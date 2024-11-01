import { ft_utils, services } from '@faasit/core';
import { faas } from '@faasit/std'
import axios from 'axios'
import * as yaml from 'js-yaml';

import path from 'path'
import AdmZip from 'adm-zip'

import * as k8s from '@kubernetes/client-node'
import { Logger } from '../../../../faasit-core/src/utils/index';
import { PluginLogger } from '../../../../faasit-core/src/runtime/index';
import { log } from 'console';

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

class K8sProvider implements faas.ProviderPlugin {
  name: string = 'k8s'
  // 初始化 Kubernetes 客户端
  k8sApi: k8s.AppsV1Api
  coreApi: k8s.CoreV1Api
  private serviceIp: Map<string, string>
  constructor() {
    // 初始化 Kubernetes 客户端配置
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault() // 从默认位置加载 kubeconfig
    this.k8sApi = kc.makeApiClient(k8s.AppsV1Api);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  async deploy(
    input: faas.ProviderDeployInput,
    ctx: faas.ProviderPluginContext
  ) {
    if (faas.isWorkflowApplication(input.app)) {
      return this.deployWorkflowApp({ ctx, input }, input.app)
    }
    return this.deployFunctionApp({ ctx, input })
  }

  async invoke(
    input: faas.ProviderInvokeInput,
    ctx: faas.ProviderPluginContext
  ) {
    const { rt, logger } = ctx
    const { app } = input
    logger.info(`invoke function ${input.funcName}`)
    logger.info(`input: ${JSON.stringify(input.input)}`)
    const svcName = input.funcName

    // 获取指定命名空间中 Service 的 Cluster IP
    // const ip = this.serviceIp.has(svcName)
    //   ? this.serviceIp.get(svcName)
    //   : this.getServiceClusterIP(svcName,logger)
    const ip = await this.getServiceClusterIP(svcName,logger)
    const url = `http://${ip}:80`
    // 不使用代理发送请求
    const axiosInstance = axios.create()
    const data = { event: input?.input || {}, metadata: {} }

    const resp = await axiosInstance.post(url, data, {
      headers: { 'Content-Type': 'application/json' },
      proxy: false,
    })

    console.log(resp.data)

    logger.info(`invoked function ${input.funcName}`)
  }
  // helpers
  async deployWorkflowApp(p: DeployParams, app: faas.WorkflowApplication) {
    const { ctx } = p
    const { rt, logger } = ctx

    logger.info(`deploy workflow on k8s`)
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
        runtime: fn.output.runtime,
      })
    }

    // deploy executor function
    functionsToDeploy.push({
      name: '__executor',
      codeDir: workflow.codeDir,
      runtime: workflow.runtime,
    })

    logger.info(`deploying workflow, functions=${functionsToDeploy.length}`)
    // await ft_utils.asyncPoolAll(1, functionsToDeploy, (fn) => this.deployOneFunction(p, fn))
    let funcsObj: any[] = []
    for (const fn of functionsToDeploy) {
      const funcobjs = await this.deployOneFunction(p, fn)
      funcsObj.push(...funcobjs)
    }
    await this.applyResources(funcsObj,logger);
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
        throw new Error(
          `failed to deploy function=${fn.$ir.name}, codeDir is empty`
        )
      }

      functionsToDeploy.push({
        name: fnRef.value.$ir.name,
        codeDir: codeDir,
        runtime: fn.output.runtime,
      })
    }

    let funcsObj: any[] = []
    for (const fn of functionsToDeploy) {
      const funcobj = await this.deployOneFunction(p, fn)
      funcsObj.push(...funcobj)
    }

    await this.applyResources(funcsObj,logger);
    logger.info(`deployed functions on k8s`)
  }

  async deployOneFunction(p: DeployParams, fnParams: {
    name: string
    codeDir: string
    runtime: string
  }
  ): Promise<any> {
    const { rt, logger } = p.ctx

    logger.info(`  > deploy function ${fnParams.name}`)

    let imageName = 'faasit-python-runtime:0.0.2'
    let runCommand: String[] = []
    let runArgs: String[] = []
    if (fnParams.runtime == 'python') {
      imageName = 'faasit-python-runtime:0.0.2'
      runCommand.push('python')
      runArgs.push('/app/server.py')
    } else if (fnParams.runtime == 'nodejs') {
      imageName = 'faasit-nodejs-runtime:0.0.2'
      runCommand.push('node')
      runArgs.push('/app/server.js')
    }

    const registry = 'docker.io'
    const funcName = fnParams.name
    const svcName = fnParams.name != '__executor' ? funcName : 'executor'
    const current_dir = process.cwd()
    const code_dir = path.resolve(current_dir, fnParams.codeDir)
    const deployObj = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: funcName,
        namespace: 'default',
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: funcName,
          },
        },
        template: {
          metadata: {
            labels: {
              app: funcName,
            },
          },
          spec: {
            containers: [
              {
                name: funcName,
                image: `${registry}/xdydy/${imageName}`,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: 9000 }],
                readinessProbe: {
                  httpGet: {
                    path: '/health',
                    port: 9000,
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                  timeoutSeconds: 1,
                  successThreshold: 1,
                  failureThreshold: 3,
                },
                securityContext: {
                  runAsNonRoot: false,
                  allowPrivilegeEscalation: false,
                  capabilities: {
                    drop: ['ALL'],
                  },
                  seccompProfile: {
                    type: 'RuntimeDefault',
                  },
                },
                command: runCommand,
                args: runArgs,
                env: [
                  {
                    name: 'FAASIT_PROVIDER',
                    value: 'local'
                  },
                  {
                    name: 'FAASIT_FUNC_NAME',
                    value: fnParams.name
                  },
                  {
                    name: 'FAASIT_APP_NAME',
                    value: p.input.app.$ir.name
                  },
                  {
                    name: 'FAASIT_WORKFLOW_NAME',
                    value: p.input.app.$ir.name
                  },
                  {
                    name: 'CODE_DIR',
                    value: `/code/${funcName}`,
                  },
                ],
                volumeMounts: [
                  {
                    name: 'code-volume',
                    mountPath: `/code/${funcName}`,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: 'code-volume',
                hostPath: {
                  path: `${code_dir}`,
                  type: 'Directory',
                },
              },
            ],
          },
        },
      },
    }
    const serviceObj = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: svcName,
        namespace: 'default'
      },
      spec: {
        selector: {
          app: svcName
        },
        ports: [
          {
            protocol: 'TCP',
            port: 80,
            targetPort: 9000
          }
        ]
      }
    }
    return [deployObj, serviceObj]
  }

  async applyResources(resources: any[],logger : PluginLogger) {
    for (const resource of resources) {
      const namespace = resource.metadata?.namespace || 'default';
      const name = resource.metadata?.name;
      if (!name) {
        console.warn("Resource is missing a name, skipping:", resource);
        continue;
      }

      try {
        if (resource.kind === 'Deployment') {
          // 尝试更新 Deployment
          await this.k8sApi.replaceNamespacedDeployment(name, namespace, resource);
          logger.info(`Deployment ${name} updated.`);
        } else if (resource.kind === 'Service') {
          // 尝试更新 Service
          await this.coreApi.replaceNamespacedService(name, namespace, resource);
          logger.info(`Service ${name} updated.`);
        } else {
          logger.info(`Unsupported resource kind: ${resource.kind}`);
        }
      } catch (error: any) {
        // 检查是否为 "Not Found" 错误
        if (error.response && error.response.statusCode === 404) {
          // 如果资源不存在，则创建
          if (resource.kind === 'Deployment') {
            await this.k8sApi.createNamespacedDeployment(namespace, resource);
            logger.info(`Deployment ${name} created.`);
          } else if (resource.kind === 'Service') {
            await this.coreApi.createNamespacedService(namespace, resource);
            logger.info(`Service ${name} created.`);
          }
        } else {
          logger.error(`Error applying ${resource.kind} ${name}:`, error);
        }
      }
    }
  }
  async getServiceClusterIP(
    serviceName: string,
    logger : PluginLogger,
    namespace: string = 'default'
  ): Promise<string | null> {
    try {
      // 调用 Kubernetes API 获取 Service 详情
      const res = await this.coreApi.readNamespacedService(
        serviceName,
        namespace
      )
      const clusterIP = res.body.spec?.clusterIP

      if (clusterIP) {
        logger.info(`Cluster IP of service ${serviceName}: ${clusterIP}`)
        return clusterIP
      } else {
        logger.info(`No Cluster IP found for service ${serviceName}.`)
        return null
      }
    } catch (err) {
      logger.error(`Error fetching service ${serviceName}:`, err)
      return null
    }
  }
}

export default function K8sPlugin(): faas.ProviderPlugin {
  return new K8sProvider()
}
