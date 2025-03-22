import { ft_utils } from '@faasit/core'
import { faas } from '@faasit/std'
import axios from 'axios'
import yaml from 'js-yaml'
import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import Docker from 'dockerode'
import { randomUUID } from 'crypto'
import * as k8s from '@kubernetes/client-node'
import {createClient} from 'redis'


interface DeployParams {
  ctx: faas.ProviderPluginContext
  input: faas.ProviderDeployInput
  // providerDataDir: string
}

interface DeployFunctionParams {
  file: string
  name: string
  function_name: string
  codeDir: string
  runtime: string
  cpu: number
  memory: number
  registry?: string
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

  async get_base_image(baseImage: string | undefined): Promise<string> {
    if (baseImage) {
      return baseImage
    }
    const docker = new Docker();
    const images = await docker.listImages({
      filters: {
        reference: ['faasit-runtime']
      }
    });
    if (images.length == 0) {
      console.warn(`Base image faasit-runtime not found, using default image`)
      return 'faasit-runtime'
    }
    const image_tags = images.flatMap(image => image.RepoTags).sort()
    return image_tags.at(-1) || 'faasit-runtime';
  }

  async build(input: faas.ProviderBuildInput, ctx: faas.ProviderPluginContext) {
    const { app, provider } = input
    const registry = provider.output.registry? provider.output.registry : '192.168.28.220:5000'
    const image = await this.get_base_image(undefined)
    const app_name = app.$ir.name
    async function push_image(imageName: string, registry: string, ctx: faas.ProviderPluginContext) {
      const { rt, logger } = ctx
      const proc = rt.runCommand('docker', {
        args: ['tag', imageName, `${registry}/library/${imageName}`],
        cwd: process.cwd(),
        stdio: 'inherit'
      })
      await proc.wait()
      logger.info(`> Pushing image ${registry}/library/${imageName} to registry ${registry}...`)
      const proc2 = rt.runCommand('docker', {
        args: ['push', `${registry}/library/${imageName}`],
        cwd: process.cwd(),
        stdio: 'inherit'
      })
      await proc2.wait()
    }
    async function build_docker_image(
      baseImageName: string,
      imageName: string,
      codeDir: string,
      ctx: faas.ProviderPluginContext,
      registry?: string
    ) {
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
      rt.removeFile(`${imageName}.dockerfile`)
      if (registry) {
        await push_image(imageName, registry, ctx)
      }
    }
    function build_function_image(fn: faas.Function) {
      const codeDir = fn.output.codeDir
      const imageName = `${app_name}-${fn.$ir.name}:tmp`
      return build_docker_image(image, imageName, codeDir, ctx, registry)
    }
    if (app.output.workflow) {
      for (const fnRef of app.output.workflow.value.output.functions) {
        build_function_image(fnRef.value)
      }
      const codeDir = app.output.workflow.value.output.codeDir
      const imageName = `${app_name}-${app.output.workflow.value.$ir.name}:tmp`
      build_docker_image(image, imageName, codeDir, ctx, registry)
    } else {
      for (const fnRef of app.output.functions) {
        build_function_image(fnRef.value);
      }
    }
  }

  

  

  async deploy(input: faas.ProviderDeployInput, ctx: faas.ProviderPluginContext) {
    async function configRedis() {
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault()
      const k8sApi = kc.makeApiClient(k8s.CoreV1Api)
      async function cleanRedis() {
        try {
          await k8sApi.deleteNamespacedService({name: 'redis-service', namespace: 'default'})
          ctx.logger.info('Deleting redis-service')
        } catch (err) {
          ctx.logger.info("redis-service not found")
        }
  
        try {
          await k8sApi.deleteNamespacedPod({name: 'redis-pod', namespace: 'default'})
          ctx.logger.info('Deleting redis-pod')
        } catch (err) {
          ctx.logger.info("redis-pod not found")
        }
  
        while(true) {
          try {
            await k8sApi.readNamespacedService({name: 'redis-service', namespace:'default'})
            ctx.logger.info('Waiting for redis-service to be deleted')
            await new Promise(resolve => setTimeout(resolve, 1000))
          } catch (err) {
            ctx.logger.info("redis-service deleted")
            break
          }
        }
  
        while(true) {
          try {
            await k8sApi.readNamespacedPod({name: 'redis-pod', namespace:'default'})
            ctx.logger.info('Waiting for redis-pod to be deleted')
            await new Promise(resolve => setTimeout(resolve, 1000))
          } catch (err) {
            ctx.logger.info("redis-pod deleted")
            break
          }
        }
        
      }
      await cleanRedis()
      const provider = input.provider
      if (!provider.output.redis_data) {
        return;
      }
      const redis_data = provider.output.redis_data
  
      async function create_redis_pod() {
        const redis_pod: k8s.V1Pod = {
          metadata: {
            name: 'redis-pod',
            labels: {
              app: 'redis'
            },
            namespace: 'default'
          },
          spec: {
            containers: [
              {
                name: 'redis-pod',
                image: 'redis',
                imagePullPolicy: 'IfNotPresent'
              }
            ]
          }
        }
        try {
          await k8sApi.createNamespacedPod({namespace: 'default', body: redis_pod})
          ctx.logger.info('Creating redis-pod')
        } catch (err) {
          ctx.logger.error(err)
          throw err
        }
      }
  
      async function create_redis_service() {
        const redis_service: k8s.V1Service = {
          metadata: {
            name: 'redis-service',
            namespace: 'default'
          },
          spec: {
            selector: {
              app: 'redis'
            },
            ports: [
              {
                port: 6379,
              }
            ], 
            externalIPs: ['10.0.0.100']
          }
        }
        try {
          await k8sApi.createNamespacedService({namespace: 'default', body: redis_service})
          ctx.logger.info('Creating redis-service')
        } catch (err) {
          ctx.logger.error(err)
          throw err
        }
      }
  
      async function load_redis_data() {
        ctx.logger.info(`Loading redis data from ${redis_data}`)
        const redis_data_path = path.resolve(redis_data)
        const redisClient = createClient({
          // url: 'redis://10.0.0.100:6379',
          socket: {
            host: '10.0.0.100',
            port: 6379,
            reconnectStrategy: function(times) {
              ctx.logger.error(`Reconnecting to redis, times=${times}`)
              return Math.min(times * 50, 2000)
            }
          }
        }).on('error', (err) => {
          ctx.logger.error(err)
        })
        try {
          await redisClient.connect()
          ctx.logger.info('Connected to redis')
        } catch (err) {
          ctx.logger.error(err)
          throw err
        }
        try {
          const files = fs.readdirSync(redis_data_path)
          files.map((file) => {
            const key = path.join(redis_data_path, file)
            const val = fs.readFileSync(key, {encoding: 'utf-8'})
            redisClient.SET(file, Buffer.from(val, 'utf-8'))
          })
        } catch (err) {
          ctx.logger.error(err)
          throw err
        }
        await redisClient.quit()
        ctx.logger.info('Loaded redis data')
      }
  
      await create_redis_pod()
      await create_redis_service()
      while(true) {
        try {
          await k8sApi.readNamespacedPod({name: 'redis-pod', namespace:'default'})
          ctx.logger.info("redis-pod created")
          break
        } catch (err) {
          ctx.logger.info('Waiting for redis-pod to be created')
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
      while(true) {
        try {
          await k8sApi.readNamespacedService({name: 'redis-service', namespace:'default'})
          ctx.logger.info("redis-service created")
          break
        } catch (err) {
          ctx.logger.info('Waiting for redis-service to be created')
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
      await load_redis_data()
    }
    await configRedis()
    if (faas.isWorkflowApplication(input.app)) {
      return this.deployWorkflowApp({ ctx, input }, input.app)
    }
    return this.deployFunctionApp({ ctx, input })
  }
  async invoke(input: faas.ProviderInvokeInput, ctx: faas.ProviderPluginContext) {
    const { rt, logger } = ctx
    const { app } = input

    logger.info(`invoke function ${input.funcName}`)
    logger.info(`input: ${JSON.stringify(input.input)}`)

    const getSvcName = () => {
      if (faas.isWorkflowApplication(app)) {
        return getNormalizedFuncName(app, app.output.workflow.value.$ir.name)
      }

      return getNormalizedFuncName(app, input.funcName)
    }
    const getRouter = () => {
      let router: Record<string,string> = {}
      if (faas.isWorkflowApplication(app)) {
        for (const fnRef of app.output.workflow.value.output.functions) {
          const fn = fnRef.value
          const funcName = getNormalizedFuncName(app, fn.$ir.name)
          router[fn.$ir.name] = `http://${funcName}.default.10.0.0.233.sslip.io`
        }
      } else {
        for (const fnRef of app.output.functions) {
          const fn = fnRef.value
          const funcName = getNormalizedFuncName(app, fn.$ir.name)
          router[fn.$ir.name] = `http://${funcName}.default.10.0.0.233.sslip.io`
        }
      }
      return router
    }
    const id = randomUUID()
    const router = getRouter()
    const namespace = app.$ir.name
    const type = 'invoke'
    const params = input.input ? input.input : {}

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
    const _metadata = {
      id: id,
      namespace: namespace,
      type: type,
      params: params,
      router: router
    }
    const resp = await axiosInstance.post(url, _metadata, { headers: { 'Content-Type': 'application/json' }, proxy: false })

    console.log(JSON.stringify(resp.data, null, 2))

    logger.info(`invoked function ${input.funcName}`)
  }

  // helpers
  async deployWorkflowApp(p: DeployParams, app: faas.WorkflowApplication) {
    const { ctx, input } = p
    const { rt, logger } = ctx

    logger.info(`deploy workflow on knative`)
    const workflow = app.output.workflow.value.output

    // deploy worker functions
    const functionsToDeploy: DeployFunctionParams[] = []
    for (const fnRef of workflow.functions) {
      const fn = fnRef.value
      const codeDir = fn.output.codeDir
      const handler = fn.output.handler? fn.output.handler : "index.handler"
      const fileName = handler.split('.')[0]
      const functionName = handler.split('.')[1]

      functionsToDeploy.push({
        file: fileName,
        name: functionName,
        function_name: fn.$ir.name,
        // use workflow's codeDir if no codeDir provided by the function
        codeDir: codeDir || workflow.codeDir,
        runtime: fn.output.runtime,
        registry: input.provider.output.registry,
        cpu: fn.output.resource? Number(fn.output.resource.cpu) : 0.5,
        memory: fn.output.resource? Number(fn.output.resource.memory) : 128
      })
    }

    // deploy executor function
    const handler = workflow.handler? workflow.handler : "index.handler"
    const fileName = handler.split('.')[0]
    const functionName = handler.split('.')[1]
    functionsToDeploy.push({
      file: fileName,
      name: app.output.workflow.value.$ir.name,
      function_name: functionName,
      codeDir: workflow.codeDir,
      runtime: workflow.runtime,
      registry: input.provider.output.registry,
      cpu: workflow.resource? Number(workflow.resource.cpu) : 0.5,
      memory: workflow.resource? Number(workflow.resource.memory) : 128
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
      const handler = fn.output.handler? fn.output.handler : "index.handler"
      const fileName = handler.split('.')[0]
      const functionName = handler.split('.')[1]
      if (!codeDir) {
        throw new Error(`failed to deploy function=${fn.$ir.name}, codeDir is empty`)
      }

      functionsToDeploy.push({
        file: fileName,
        name: fn.$ir.name,
        function_name: functionName,
        codeDir: codeDir,
        runtime: fn.output.runtime,
        registry: p.input.provider.output.registry,
        cpu: fn.output.resource? Number(fn.output.resource.cpu) : 0.5,
        memory: fn.output.resource? Number(fn.output.resource.memory) : 128
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

  async deployOneFunction(p: DeployParams, fnParams: DeployFunctionParams): Promise<any> {
    const { rt, logger } = p.ctx

    logger.info(`  > deploy function ${fnParams.name}`)
    const registry = fnParams.registry? fnParams.registry : '192.168.28.220:5000'

    const funcName = getNormalizedFuncName(p.input.app, fnParams.name)

    let runCommand: String[] = ['python']
    let runArgs: String[] = [
      '-m',
      'faasit_runtime.worker',
      '--lambda_file',
      `/code/${fnParams.file}.py`,
      '--function_name',
      fnParams.function_name,
      '--server_port',
      '9000'
    ]

    const funcObj = {
      apiVersion: 'serving.knative.dev/v1',
      kind: 'Service',
      metadata: {
        name: funcName,
        namespace: 'default'
      },
      spec: {
        template: {
          spec: {
            containers: [
              {
                image: `${registry}/library/${funcName}:tmp`,
                imagePullPolicy: "IfNotPresent",
                ports: [{ "containerPort": 9000 }],
                resources: {
                  limits: {
                    cpu: `${fnParams.cpu}`,
                    memory: `${fnParams.memory}Mi`
                  }
                },
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
                    name: 'FUNC_NAME',
                    value: fnParams.function_name
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
