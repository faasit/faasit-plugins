import { faas } from '@faasit/std'
import * as Trigger from "./utils/trigger";
import { AliyunFunction, AliyunService, AliyunTrigger, AliyunSecretType, parseAliyunSecret } from './utils'
import { createClient } from './utils/client';
import Client from '@alicloud/fc-open20210406';
import FC_Open20210406, * as $FC_Open20210406 from '@alicloud/fc-open20210406'
import Util, * as $Util from '@alicloud/tea-util'
import fs from 'fs'
import path from 'path';
import AdmZip from 'adm-zip';


interface DeployParams {
	ctx: faas.ProviderPluginContext
	input: faas.ProviderDeployInput
	secret: AliyunSecretType
}

interface DeployFunctionParams {
	name: string,
	codeDir: string,
	runtime: string,
}

class AliyunProvider implements faas.ProviderPlugin {
	name: string = 'aliyun'

	async build(input: faas.ProviderDeployInput, ctx: faas.ProviderPluginContext) {
		const { app } = input
		const { logger,rt } = ctx
		logger.info(`build ${app.$ir.name} on aliyun`)
		function buildFunction(fn: faas.Function) {
			const codeDir = fn.output.codeDir
			const runtime = fn.output.runtime
			logger.info(`build function ${fn.$ir.name}`)
			if (runtime == 'python' && fs.existsSync(path.join(codeDir,'requirements.txt'))) {
				logger.info(`install ${fn.$ir.name} python runtime requirements`)
				const proc = rt.runCommand('pip', {
					args:[
						'install', 
						'-r', 
						'requirements.txt', 
						'-t', 
						'./venv', 
						'--upgrade'
					],  
					cwd: codeDir ,  
					stdio: 'inherit' 
				})
				return proc.wait()
			}
		}
		if (app.output.workflow) {
			for (const fnRef of app.output.workflow.value.output.functions) {
				buildFunction(fnRef.value)
			}
		} else {
			for (const fnRef of app.output.functions) {
				buildFunction(fnRef.value)
			}
		}
	}

	async deploy(input: faas.ProviderDeployInput, ctx: faas.ProviderPluginContext) {
		const { rt, logger } = ctx
		const { app } = input
		const secret = parseAliyunSecret(ctx.env)
	 	async function deploy_layer() {
			const client = createClient({ secret })
			if (input.provider.output.deploy) {
				const requirements = input.provider.output.deploy['requirements']
				if (requirements === undefined) {
					return;
				}
				const createLayerVersionHeaders = new $FC_Open20210406.CreateLayerVersionHeaders({});
				const runtime = new $Util.RuntimeOptions({})
				for (const requirement of requirements) {
					const proc = rt.runCommand('pip', {
						args:[
							'install', 
							requirement, 
							'-t', 
							`./${requirement}`, 
						],  
						cwd: process.cwd(),  
						stdio: 'inherit' 
					})
					await proc.wait()
					const codeDir = path.join(process.cwd(), requirement)
					const zip = new AdmZip();
					zip.addLocalFolder(requirement);
					const zipBuffer = zip.toBuffer();
					const base64 = zipBuffer.toString('base64');
					logger.info(`deploy layer ${requirement}`)
					const code = new $FC_Open20210406.Code({
						zipFile: base64
					})
					const createLayerVersionRequest = new $FC_Open20210406.CreateLayerVersionRequest({
						code: code,
						compatibleRuntime: ['python3.10'],
					});
					try {
						await client.createLayerVersionWithOptions(requirement,createLayerVersionRequest, createLayerVersionHeaders, runtime)	
					} catch (error) {
						console.warn(error.message)
						console.log(error.data['Recommend'])
					}
				}
			}
		}
		// 这种方法限制上传大小，遂放弃
		// const resp = await deploy_layer()
		// console.log(resp)
		if (faas.isWorkflowApplication(app)) {
			return this.deployWorkflowApp({ ctx, input, secret }, app)
		} else {
			return this.deployFunctions({ ctx, input, secret })
		}
	}

	async invoke(input: faas.ProviderInvokeInput, ctx: faas.ProviderPluginContext) {
		const { rt, logger } = ctx;
		const { app } = input;
		const secret = parseAliyunSecret(ctx.env)
		const client = createClient({ secret })
		const serviceName = this.getServiceName(input.app)

		const fnName = input.funcName ? input.funcName : app.output.workflow? app.output.workflow.value.$ir.name : app.output.functions.at(0)?.value.$ir.name
		if (!fnName) {
			throw new Error("function name is required")
		}
		logger.info(`invoke function ${fnName}`)
		const aliyunFunc = new AliyunFunction({
			client,
			serviceName,
			functionName: fnName,
			codeDir: "",
			runtime: 'nodejs14',
			handler: "index.handler",
			env: {
				FAASIT_PROVIDER: 'aliyun',
				FAASIT_APP_NAME: app.$ir.name,
				FAASIT_FUNC_NAME: fnName,
				FAASIT_WORKFLOW_FUNC_NAME: fnName,
				// use for commnuication between functions
				ALIBABA_CLOUD_ACCESS_KEY_ID: secret.accessKeyId,
				ALIBABA_CLOUD_ACCESS_KEY_SECRET: secret.accessKeySecret,
				ALIBABA_CLOUD_PRODUCT_CODE: secret.accountId,
				ALIBABA_CLOUD_REGION: secret.region,
				ALIBABA_CLOUD_SERVICE: serviceName,
				// OSS
				ALIBABA_CLOUD_OSS_BUCKET_NAME: process.env.ALIBABA_CLOUD_OSS_BUCKET_NAME, // faasit
				ALIBABA_CLOUD_OSS_REGION: process.env.ALIBABA_CLOUD_OSS_REGION, // oss-cn-hangzhou
			},
			requirements: []
		})
		let options: {[key: string]: string} = {}
		if (input.provider.output.invoke) {
			options = input.provider.output.invoke
		}
		const timeout = options['timeout'] ? parseInt(options['timeout']) : undefined
		const resp = await aliyunFunc.invoke(input.input,timeout)
		logger.info("function invoke results:");
		console.log(resp?.body.toString());
	}

	async deployOneFunction(
		p: DeployParams,
		client: Client, 
		appName: string,
		serviceName: string,
		functionName: string,
		codeDir: string,
		runtime: string,
		handler: string,
		triggers: any[],
		cpu?: number,
		memory? : number) {
		const service = new AliyunService({ client, serviceName });
		const getServiceResp = await service.get()
		if (!getServiceResp) {
			await service.create()
		}
		if (runtime.includes('python')) {
			runtime = 'python3.10'
		}
		if (runtime.includes('nodejs')) {
			runtime = 'nodejs16'
		}
		let layers:string[] = []
		if (p.input.provider.output.deploy) {
			const requirements = p.input.provider.output.deploy['requirements']
			for (const requirement of requirements) {
				layers.push(requirement)
			}
		}
		let func = new AliyunFunction({
			client,
			serviceName,
			functionName,
			codeDir,
			runtime,
			handler: handler ? handler : "index.handler",
			env: {
				FAASIT_PROVIDER: 'aliyun',
				FAASIT_APP_NAME: appName,
				FAASIT_FUNC_NAME: functionName,
				FAASIT_WORKFLOW_FUNC_NAME: functionName,
				ALIBABA_CLOUD_ACCESS_KEY_ID: p.secret.accessKeyId,
				ALIBABA_CLOUD_ACCESS_KEY_SECRET: p.secret.accessKeySecret,
				ALIBABA_CLOUD_PRODUCT_CODE: p.secret.accountId,
				ALIBABA_CLOUD_REGION: p.secret.region,
				ALIBABA_CLOUD_SERVICE: serviceName,
				// OSS
				ALIBABA_CLOUD_OSS_BUCKET_NAME: process.env.ALIBABA_CLOUD_OSS_BUCKET_NAME, // faasit
				ALIBABA_CLOUD_OSS_REGION: process.env.ALIBABA_CLOUD_OSS_REGION, // oss-cn-hangzhou
				PYTHONPATH: '/code/venv'
			},
			resource: {
				cpu: cpu,
				memory: memory
			},
			requirements: layers
		})
		await func.get().then(async getFunctionResp => {
			if (getFunctionResp) {
				await func.update()
			} else {
				await func.create()
			}
		})
		for (let trigger of (triggers || [])) {
			const baseTrigger = await Trigger.getTrigger({
				kind: trigger.kind,
				name: trigger.name,
				opts: {/**TODO */ }
			})

			let aliyunTrigger = new AliyunTrigger(
				{
					client,
					serviceName,
					functionName,
					triggerName: trigger.name,
					triggerType: trigger.kind,
					triggerOpts: {}
				})

			await aliyunTrigger.get().then(async getTriggerResp => {
				if (getTriggerResp) {
					await aliyunTrigger.update()
				} else {
					await aliyunTrigger.create()
				}
			})
		}
	}

	async deployFunctions(p: DeployParams) {
		const { app } = p.input
		const { logger } = p.ctx
		logger.info('aliyun deploy')

		const serviceName = this.getServiceName(app)
		const client = createClient({ secret: p.secret })

		for (const fnRef of app.output.functions) {
			const fn = fnRef.value
			const functionName = fn.$ir.name
			logger.info(`deploy function ${fn.$ir.name}`)

			await this.deployOneFunction(
				p,
				client,
				app.$ir.name,
				serviceName,
				functionName,
				fn.output.codeDir,
				fn.output.runtime,
				fn.output.handler? fn.output.handler : "index.handler",
				fn.output.triggers,
				fn.output.resource?.cpu,
				fn.output.resource?.memory
			)

			logger.info(`aliyun deployed function ${functionName}`)
		}
	}

	async deployWorkflowApp(p: DeployParams, app: faas.WorkflowApplication) {
		const { ctx } = p;
		const { logger } = ctx

		logger.info(`deploy workflow on Aliyun`)
		const workflow = app.output.workflow.value.output

		const client = createClient({ secret: p.secret })
		const serviceName = this.getServiceName(app)

		for (const fnRef of workflow.functions) {
			const fn = fnRef.value
			const functionName = fn.$ir.name
			logger.info(`deploy function ${fn.$ir.name}`)

			await this.deployOneFunction(
				p, 
				client, 
				app.$ir.name,
				serviceName, 
				functionName,
				fn.output.codeDir,
				fn.output.runtime,
				fn.output.handler? fn.output.handler: "index.handler",
				fn.output.triggers,
				fn.output.resource?.cpu,
				fn.output.resource?.memory
			)
		}
		await this.deployOneFunction(
			p,
			client,
			app.$ir.name,
			serviceName,
			app.output.workflow.value.$ir.name,
			workflow.codeDir,
			workflow.runtime,
			workflow.handler? workflow.handler: "index.handler",
			[],
			workflow.resource?.cpu,
			workflow.resource?.memory
		)

		// functionsToDeploy.push({
		// 	name: '__executor',
		// 	codeDir: workflow.codeDir,
		// 	runtime: workflow.runtime
		// })

		// for (const func of functionsToDeploy) {
		// 	const functionName = func.name
		// 	const codeDir = func.codeDir

		// 	await this.deployOneFunction(
		// 		p,
		// 		client,
		// 		app.$ir.name,
		// 		serviceName,
		// 		functionName,
		// 		codeDir,
		// 		func.runtime,
		// 		"index.handler",
		// 		[]
		// 	)
		// }
	}

	private getServiceName(app: faas.Application) {
		// TODO: dynamic generate service name based on app name
		// return `faasit-${app.$ir.name}`
		return `faasit`
	}
}


export default function AliyunPlugin(): faas.ProviderPlugin {
	return new AliyunProvider()
}