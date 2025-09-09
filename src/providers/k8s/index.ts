import { ft_utils, services } from '@faasit/core';
import { faas } from '@faasit/std'
import axios from 'axios'
import * as yaml from 'js-yaml';
import fs, { appendFile } from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import Docker from 'dockerode'
import * as k8s from '@kubernetes/client-node'
import { Logger } from '../../../../faasit-core/src/utils/index';
import { PluginLogger } from '../../../../faasit-core/src/runtime/index';
import { log } from 'console';
import {createClient} from 'redis'
import { string } from 'zod';
import { randomUUID } from 'crypto';

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

class K8sProvider implements faas.ProviderPlugin {
  name: string = 'k8s'
  // 初始化 Kubernetes 客户端
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
    const registry = provider.output.registry
    const image = await this.get_base_image(undefined)
    const app_name = app.$ir.name


    async function push_image(imageName: string) {
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
        await push_image(imageName)
      }
    }


    function build_function_image(fn: faas.Function) {
      const codeDir = fn.output.codeDir
      const imageName = `${app_name}-${fn.$ir.name}:tmp`
      return build_docker_image(image, imageName, codeDir)
    }

    if (app.output.workflow) {
      for (const fn of app.output.workflow.value.output.functions) {
        build_function_image(fn.value)
      }
      const workflowDir = app.output.workflow.value.output.codeDir
      const workflowImageName = `${app_name}-${app.output.workflow.value.$ir.name}:tmp`
      build_docker_image(image, workflowImageName, workflowDir)
    } else {
      for (const fn of app.output.functions) {
        build_function_image(fn.value)
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
          await k8sApi.deleteNamespacedService({ name: 'redis-service', namespace: 'default' })
          ctx.logger.info('Deleting redis-service')
        } catch (err) {
          ctx.logger.info("redis-service not found")
        }

        try {
          await k8sApi.deleteNamespacedPod({ name: 'redis-pod', namespace: 'default' })
          ctx.logger.info('Deleting redis-pod')
        } catch (err) {
          ctx.logger.info("redis-pod not found")
        }

        while (true) {
          try {
            await k8sApi.readNamespacedService({ name: 'redis-service', namespace: 'default' })
            ctx.logger.info('Waiting for redis-service to be deleted')
            await new Promise(resolve => setTimeout(resolve, 1000))
          } catch (err) {
            ctx.logger.info("redis-service deleted")
            break
          }
        }

        while (true) {
          try {
            await k8sApi.readNamespacedPod({ name: 'redis-pod', namespace: 'default' })
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
          await k8sApi.createNamespacedPod({ namespace: 'default', body: redis_pod })
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
          await k8sApi.createNamespacedService({ namespace: 'default', body: redis_service })
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
            reconnectStrategy: function (times) {
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
            const val = fs.readFileSync(key, { encoding: 'utf-8' })
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
      while (true) {
        try {
          await k8sApi.readNamespacedPod({ name: 'redis-pod', namespace: 'default' })
          ctx.logger.info("redis-pod created")
          break
        } catch (err) {
          ctx.logger.info('Waiting for redis-pod to be created')
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
      while (true) {
        try {
          await k8sApi.readNamespacedService({ name: 'redis-service', namespace: 'default' })
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
    let port: number = 10000
    async function deploy_function(fnParams: DeployFunctionParams): Promise<any> {
      const {rt, logger} = ctx
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault()
      const k8sApi = kc.makeApiClient(k8s.CoreV1Api)
      const funcName = fnParams.function_name
      const app_name = input.app.$ir.name
      const pod_name_and_svc_name = `${app_name}-${fnParams.name}`
      try {
        await k8sApi.deleteNamespacedService({ name: pod_name_and_svc_name, namespace: 'default' })
        logger.info(`Deleting service ${pod_name_and_svc_name}`)
      } catch (err) {
        logger.info(`Service ${pod_name_and_svc_name} not found`)
      }

      try {
        await k8sApi.deleteNamespacedPod({ name: pod_name_and_svc_name, namespace: 'default' })
        logger.info(`Deleting pod ${pod_name_and_svc_name}`)
      } catch (err) {
        logger.info(`Pod ${pod_name_and_svc_name} not found`)
      }

      while(true) {
        try {
          await k8sApi.readNamespacedService({ name: pod_name_and_svc_name, namespace: 'default' })
          logger.info(`Waiting for service ${pod_name_and_svc_name} to be deleted`)
          await new Promise(resolve => setTimeout(resolve, 1000))
        } catch (err) {
          logger.info(`Service ${pod_name_and_svc_name} deleted`)
          break
        }
      }
      while(true) {
        try {
          await k8sApi.readNamespacedPod({ name: pod_name_and_svc_name, namespace: 'default' })
          logger.info(`Waiting for pod ${pod_name_and_svc_name} to be deleted`)
          await new Promise(resolve => setTimeout(resolve, 1000))
        } catch (err) {
          logger.info(`Pod ${pod_name_and_svc_name} deleted`)
          break
        }
      }

      const image = `${app_name}-${fnParams.name}:tmp`
      async function create_pod() {
        const pod: k8s.V1Pod = {
          metadata: {
            name: pod_name_and_svc_name,
            labels: {
              app: pod_name_and_svc_name,
            }
          },
          spec: {
            containers: [
              {
                name: 'my-container',
                image: image,
                imagePullPolicy: 'IfNotPresent',
                command: ["python"],
                args: [
                  "-m",
                  "faasit_runtime.worker",
                  "--lambda_file",
                  `/code/${fnParams.file}.py`,
                  "--function_name",
                  fnParams.function_name,
                  '--server_port',
                  '9000'
                ],
                resources: {
                  requests: {
                    cpu: String(fnParams.cpu),
                    memory: `${String(fnParams.memory)}Mi`
                  },
                  limits: {
                    cpu: String(fnParams.cpu),
                    memory: `${String(fnParams.memory)}Mi`
                  }
                },
                securityContext: {
                  privileged: false
                }
              }
            ]
          }
        }
        try {
          await k8sApi.createNamespacedPod({ namespace: 'default', body: pod })
          logger.info(`Creating pod ${pod_name_and_svc_name}`)
        } catch (err) {
          logger.error(err)
          throw err
        }
      }

      async function create_service() {
        const serivce: k8s.V1Service = {
          metadata: {
            name: pod_name_and_svc_name
          },
          spec: {
            type: "LoadBalancer",
            ports: [
              {
                port: port++,
                targetPort: 9000,
                name: 'worker'
              }
            ],
            selector: {
              app: pod_name_and_svc_name
            },
            externalIPs: ["10.0.0.234"]
          }
        }
        try {
          await k8sApi.createNamespacedService({ namespace: 'default', body: serivce })
          logger.info(`Creating service ${pod_name_and_svc_name}`)
        } catch (err) {
          logger.error(err)
          throw err
        }
      }
      create_pod()
      create_service()
      while(true) {
        try {
          await k8sApi.readNamespacedPod({ name: pod_name_and_svc_name, namespace: 'default' })
          logger.info(`Pod ${pod_name_and_svc_name} created`)
          break
        } catch (err) {
          logger.info(`Waiting for pod ${pod_name_and_svc_name} to be created`)
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
      while(true) {
        try {
          await k8sApi.readNamespacedService({ name: pod_name_and_svc_name, namespace: 'default' })
          logger.info(`Service ${pod_name_and_svc_name} created`)
          break
        } catch (err) {
          logger.info(`Waiting for service ${pod_name_and_svc_name} to be created`)
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    }

    function deploy_one_function(fn: faas.Function) {
      const handler = fn.output.handler? fn.output.handler: 'index.handler'
      const file = handler.split('.')[0]
      const function_name = handler.split('.')[1]
      deploy_function({
        file: file,
        name: fn.$ir.name,
        function_name: function_name,
        codeDir: fn.output.codeDir,
        runtime: fn.output.runtime,
        cpu: fn.output.resource?.cpu? fn.output.resource.cpu: 1,
        memory: fn.output.resource?.memory? fn.output.resource.memory: 128
      })
    }
    const {app} = input
    if (app.output.workflow) {
      for (const fn of app.output.workflow.value.output.functions) {
        deploy_one_function(fn.value)
      }  
      const handler = app.output.workflow.value.output.handler? app.output.workflow.value.output.handler: 'index.handler'
      const file = handler.split('.')[0]
      const function_name = handler.split('.')[1]

      deploy_function({
        file: file,
        name: app.output.workflow.value.$ir.name,
        function_name: function_name,
        codeDir: app.output.workflow.value.output.codeDir,
        runtime: app.output.workflow.value.output.runtime,
        cpu: app.output.workflow.value.output.resource?.cpu? app.output.workflow.value.output.resource.cpu: 1,
        memory: app.output.workflow.value.output.resource?.memory? app.output.workflow.value.output.resource.memory: 128
      })
    } else {
      for (const fn of app.output.functions) {
        deploy_one_function(fn.value)
      }
    }


  }
  async invoke(input: faas.ProviderInvokeInput, ctx: faas.ProviderPluginContext) {
    const { rt, logger } = ctx
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault()
    const k8sApi = kc.makeApiClient(k8s.CoreV1Api)
    const app_name = input.app.$ir.name
    const function_name = input.funcName? input.funcName: input.app.output.workflow? input.app.output.workflow.value.$ir.name: input.app.output.functions.at(0)?.value.$ir.name
    logger.info(`Invoking function ${function_name}`)
    logger.info(`input: ${JSON.stringify(input.input)}`)
    if (!function_name) {
      throw new Error('No function name found')
    }

    const getRouter = async () => {
      const get_function_router = async (functionName: string) =>  {
        const pod_name_and_svc_name = `${app_name}-${functionName}`
        const service = await k8sApi.readNamespacedService({ name: pod_name_and_svc_name, namespace: 'default' })
        const ip = service.spec?.externalIPs?.at(0)
        const port = service.spec?.ports?.at(0)?.port
        if (!ip) {
          throw new Error('No external IP found')
        }
        if (!port) {
          throw new Error('No port found')
        }
        return `http://${ip}:${port}/`
      }
      let router: Record<string,string> = {}
      if (input.app.output.workflow) {
        for (const fnRef of input.app.output.workflow.value.output.functions) {
          const fn = fnRef.value
          const funcName = normalizeDnsName(fn.$ir.name)
          router[fn.$ir.name] = await get_function_router(funcName)
        }
        router[input.app.output.workflow.value.$ir.name] = await get_function_router(input.app.output.workflow.value.$ir.name)
      } else {
        for (const fnRef of input.app.output.functions) {
          const fn = fnRef.value
          const funcName = normalizeDnsName(fn.$ir.name)
          router[fn.$ir.name] = await get_function_router(funcName)
        }
      }
      return router
    }
    const id = randomUUID()
    const router = await getRouter()
    const namespace = input.app.$ir.name
    const type = "invoke"
    const params = input.input? input.input: {}
    const url = router[function_name]
    const _metadata = {
      id: id,
      namespace: namespace,
      type: type,
      params: params,
      router: router
    }
    const axiosInstance = axios.create()
    const response = await axiosInstance.post(url, _metadata, {headers: {'Content-Type': 'application/json'}, proxy: false})
    logger.info(`Response: ${JSON.stringify(response.data,null,2)}`)
    return response.data
  }
}

export default function K8sPlugin(): faas.ProviderPlugin {
  return new K8sProvider()
}
