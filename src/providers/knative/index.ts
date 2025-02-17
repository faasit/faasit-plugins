import { ft_utils } from '@faasit/core'
import { faas } from '@faasit/std'
import axios from 'axios'
import yaml from 'js-yaml'
import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'

interface DeployParams {
  ctx: faas.ProviderPluginContext
  input: faas.ProviderDeployInput
  // providerDataDir: string
}

interface DeployFunctionParams {
  name: string
  codeDir: string
  runtime: string
}

function normalizeDnsName(dnsName: string) {
  return dnsName.toLowerCase().replace(/_/g, '-')
}

function getNormalizedFuncName(app: faas.Application, funcName: string) {
  const lowerAppName = normalizeDnsName(app.$ir.name)
  const lowerFuncName = normalizeDnsName(funcName)

  return `${lowerAppName}-${lowerFuncName}`
}

class KnativeProvider implements faas.ProviderPlugin {
  name: string = 'knative'

  async build(input: faas.ProviderDeployInput, ctx: faas.ProviderPluginContext) {
    const { app } = input
    if (app.output.workflow) {
      const image = 'faasit-python-runtime:0.2'
      const app_name = app.$ir.name
      await this.build_docker_image(image, `${app_name}-executor:tmp`, app.output.workflow.value.output.codeDir, ctx)
      for (const fnRef of app.output.workflow.value.output.functions) {
        const fn = fnRef.value
        const codeDir = fn.output.codeDir
        const imageName = `${app_name}-${fn.$ir.name}:tmp`
        await this.build_docker_image(image, imageName, codeDir, ctx)
      }
    }
  }

  async build_docker_image(baseImageName: string, imageName: string, codeDir: string, ctx: faas.ProviderPluginContext) {
    const { rt, logger } = ctx
    logger.info(`Building docker image ${imageName}`)
    let build_commands = []
    build_commands.push(`FROM ${baseImageName}`)
    build_commands.push(`COPY ${codeDir} /code`)
    build_commands.push(`WORKDIR /code`)
    if (fs.existsSync(path.join(codeDir, 'requirements.txt'))) {
      build_commands.push(`COPY ${path.join(codeDir, 'requirements.txt')} /requirements.txt`)
      build_commands.push(`RUN pip install -r /requirements.txt --index-url https://mirrors.aliyun.com/pypi/simple/`)
    }
    if (fs.existsSync(path.join(codeDir, 'package.json'))) {
      build_commands.push(`RUN pnpm install @faasit/runtime`)
    }
    const dockerfile = build_commands.join('\n')
    await rt.writeFile(`${imageName}.dockerfile`, dockerfile)
    const proc = rt.runCommand('docker', {
      args: ['build', '--no-cache', '-t', `${imageName}`, '-f', `${imageName}.dockerfile`, '.'],
      cwd: process.cwd(),
      stdio: 'inherit'
    })
    await proc.wait()
  }

  async deploy(input: faas.ProviderDeployInput, ctx: faas.ProviderPluginContext) {
    if (faas.isWorkflowApplication(input.app)) {
      return this.deployWorkflowApp({ ctx, input }, input.app)
    }
    return this.deployFunctionApp({ ctx, input })
  }

  async invoke(input: faas.ProviderInvokeInput, ctx: faas.ProviderPluginContext): Promise<string | undefined> {
    const { rt, logger } = ctx
    const { app } = input

    logger.info(`invoke function ${input.funcName}`)
    logger.info(`input: ${JSON.stringify(input.input)}`)

    const getSvcName = () => {
      if (faas.isWorkflowApplication(app)) {
        return getNormalizedFuncName(app, 'executor')
      }

      return getNormalizedFuncName(app, input.funcName)
    }

    const svcName = getSvcName()
    // const svcName = `${app.$ir.name}-${input.funcName}`

    const url = `http://${svcName}.default.10.0.0.233.sslip.io`

    // 不使用代理发送请求
    const axiosInstance = axios.create()
    // const resp = await axios.post(url, JSON.stringify(input.input), {
    //   headers: {
    //     'Content-Type': 'application/json'
    //   },
    //   proxy: false
    // })

    const data = { event: input?.input || {}, metadata: {} }
    const resp = await axiosInstance.post(url, data, { headers: { 'Content-Type': 'application/json' }, proxy: false })

    console.log(JSON.stringify(resp.data, null, 2))

    logger.info(`invoked function ${input.funcName}`)
    return resp.data
  }

  // helpers
  async deployWorkflowApp(p: DeployParams, app: faas.WorkflowApplication) {
    const { ctx } = p
    const { rt, logger } = ctx

    logger.info(`deploy workflow on knative`)
    const workflow = app.output.workflow.value.output

    // deploy worker functions
    const functionsToDeploy: DeployFunctionParams[] = []
    for (const fnRef of workflow.functions) {
      const fn = fnRef.value
      const codeDir = fn.output.codeDir

      functionsToDeploy.push({
        name: fnRef.value.$ir.name,
        // use workflow's codeDir if no codeDir provided by the function
        codeDir: codeDir || workflow.codeDir,
        runtime: fn.output.runtime
      })
    }

    // deploy executor function
    functionsToDeploy.push({
      name: 'executor',
      codeDir: workflow.codeDir,
      runtime: workflow.runtime
    })

    logger.info(`deploying workflow, functions=${functionsToDeploy.length}`)
    // await ft_utils.asyncPoolAll(1, functionsToDeploy, (fn) => this.deployOneFunction(p, fn))
    let funcsObj: any[] = [];
    for (const fn of functionsToDeploy) {
      const funcobj = await this.deployOneFunction(p, fn);
      funcsObj.push(funcobj)
    }
    const yamlsStrs = funcsObj.map((funcObj) => yaml.dump(funcObj))
    const yamlsStr = yamlsStrs.join('---\n')
    await rt.writeFile("kn_func.yaml", yamlsStr)

    const proc = rt.runCommand(`kubectl apply -f kn_func.yaml`, {
      cwd: process.cwd(),
      shell: true,
      stdio: 'inherit'
    })

    await Promise.all([
      proc.readOut(v => logger.info(v)),
      proc.readErr(v => logger.error(v))
    ])
    await proc.wait()

    // await rt.removeFile("kn_func.yaml")
    logger.info(`deployed workflow, functions=${functionsToDeploy.length}`)
  }

  async deployFunctionApp(p: DeployParams) {
    const { app } = p.input
    const { rt, logger } = p.ctx

    logger.info(`deploy functions on knative`)

    const functionsToDeploy: DeployFunctionParams[] = []
    for (const fnRef of app.output.functions) {
      const fn = fnRef.value
      const codeDir = fn.output.codeDir

      if (!codeDir) {
        throw new Error(`failed to deploy function=${fn.$ir.name}, codeDir is empty`)
      }

      functionsToDeploy.push({
        name: fnRef.value.$ir.name,
        codeDir: codeDir,
        runtime: fn.output.runtime
      })
    }

    // await ft_utils.asyncPoolAll(4, functionsToDeploy, (fn) => this.deployOneFunction(p, fn))
    let funcsObj: any[] = [];
    for (const fn of functionsToDeploy) {
      const funcobj = await this.deployOneFunction(p, fn);
      funcsObj.push(funcobj)
    }

    const yamlsStrs = funcsObj.map((funcObj) => yaml.dump(funcObj))
    const yamlsStr = yamlsStrs.join('---\n')
    await rt.writeFile("kn_func.yaml", yamlsStr)

    const proc = rt.runCommand(`kubectl apply -f kn_func.yaml`, {
      cwd: process.cwd(),
      shell: true,
      stdio: 'inherit'
    })

    await Promise.all([
      proc.readOut(v => logger.info(v)),
      proc.readErr(v => logger.error(v))
    ])
    await proc.wait()

    await rt.removeFile("kn_func.yaml")

    logger.info(`deployed functions on knative`)
  }

  async deployOneFunction(p: DeployParams, fnParams: {
    name: string
    codeDir: string
    runtime: string
  }): Promise<any> {
    const { rt, logger } = p.ctx

    logger.info(`  > deploy function ${fnParams.name}`)

    let imageName = "faasit-python-runtime:0.2"
    let runCommand: String[] = []
    let runArgs: String[] = []
    if (fnParams.runtime == 'python') {
      imageName = "faasit-python-runtime:0.2"
      runCommand.push('python')
      runArgs.push('/app/server.py')
    } else if (fnParams.runtime == 'nodejs') {
      imageName = "faasit-nodejs-runtime:0.0.1"
      runCommand.push('node')
      runArgs.push('/app/server.js')
    }

    const registry = 'docker.io'

    const funcName = getNormalizedFuncName(p.input.app, fnParams.name)
    const svcName = fnParams.name != '__executor' ? funcName : getNormalizedFuncName(p.input.app, 'executor')
    // const getNginxProc = rt.runCommand(`kubectl get svc | grep nginx-file-server | awk '{print $3}'`, {
    //   cwd: process.cwd(),
    //   shell: true
    // })
    // let nginxIP = ''
    // getNginxProc.readOut(v => {
    //   nginxIP = String(v).replace('\n', '')
    // })

    // const getRedisProc = rt.runCommand(`kubectl get svc | grep faasit-redis | awk '{print $3}'`, {
    //   cwd: process.cwd(),
    //   shell: true
    // })
    // let redisIP = ''
    // getRedisProc.readOut(v => {
    //   redisIP = String(v).replace('\n', '')
    // })

    // await getNginxProc.wait()
    // await getRedisProc.wait()

    const funcObj = {
      apiVersion: 'serving.knative.dev/v1',
      kind: 'Service',
      metadata: {
        name: svcName,
        namespace: 'default'
      },
      spec: {
        template: {
          spec: {
            containers: [
              {
                image: `192.168.28.220:5000/library/${funcName}:tmp`,
                imagePullPolicy: "IfNotPresent",
                ports: [{ "containerPort": 9000 }],
                readinessProbe: {
                  httpGet: {
                    path: '/health',
                    port: 9000
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                  timeoutSeconds: 1,
                  successThreshold: 1,
                  failureThreshold: 3
                },
                securityContext: {
                  runAsNonRoot: false,
                  allowPrivilegeEscalation: false,
                  capabilities: {
                    drop: ['ALL']
                  },
                  seccompProfile: {
                    type: 'RuntimeDefault'
                  }
                },
                env: [
                  {
                    name: 'FAASIT_FUNC_NAME',
                    value: fnParams.name
                  },
                  {
                    name: 'FAASIT_PROVIDER',
                    value: 'knative'
                  },
                  {
                    name: 'FAASIT_CODE_DIR',
                    value: `${funcName}.zip`
                  },
                  {
                    name: 'FAASIT_APP_NAME',
                    value: normalizeDnsName(p.input.app.$ir.name)
                  },
                  {
                    name: 'FAASIT_WORKFLOW_NAME',
                    value: normalizeDnsName(p.input.app.$ir.name)
                  },
                  {
                    name: 'REDIS_PORT',
                    value: '6379'
                  }
                ],
                command: runCommand,
                args: runArgs
              }
            ]
          }
        }
      }
    }
    // const zipFile = await this.packFuncCode({ codeDir: fnParams.codeDir, fnName: funcName })
    // // 获取名称包含funcName的pod的名称
    // const getPodProc = rt.runCommand(`kubectl get pod | grep nginx-file-server | awk '{print $1}'`, {
    //   cwd: process.cwd(),
    //   shell: true
    // })
    // let podName: string = '';
    // getPodProc.readOut(v => {
    //   podName = String(v).replace('\n', '')
    //   logger.info(`podName: ${podName}`)
    // })
    // await getPodProc.wait()

    // logger.info(`Deploy ${zipFile} to Pod ${podName}`)
    // const cpProc = rt.runCommand(`kubectl cp ${zipFile} ${podName}:/data/uploads`, {
    //   cwd: process.cwd(),
    //   shell: true,
    //   stdio: 'inherit'
    // })
    // await Promise.all([
    //   cpProc.readOut(v => logger.info(v)),
    //   cpProc.readErr(v => logger.error(v))
    // ])
    // await cpProc.wait()
    // await rt.removeFile(zipFile)

    return funcObj
  }
  async packFuncCode(fn: {
    codeDir: string, fnName: string
  }) {
    // pack code to zip file
    const { codeDir, fnName } = fn
    const zipFile = `${fnName}.zip`
    const zip = new AdmZip()
    zip.addLocalFolder(codeDir)
    zip.writeZip(zipFile)
    return zipFile
  }
}

export default function KnativePlugin(): faas.ProviderPlugin {
  return new KnativeProvider()
}
