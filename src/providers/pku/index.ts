import {faas} from '@faasit/std'
import yaml from 'js-yaml'
import path from 'path'
import fs from 'fs'
import Docker from 'dockerode'
import { ir } from '@faasit/core'

interface stage {
    name: string,
    request: {
        vcpu: number,
    }
    image: string,
    codeDir: string,
    replicas: number,
    handler: string
}

class PKUProvider implements faas.ProviderPlugin {
    name: string = 'pku'

    async get_base_image(baseImage:string|undefined):Promise<string> {
        if (baseImage) {
            return baseImage
        }
        const docker = new Docker();
        const images = await docker.listImages({
            filters: {
                reference: ['faasit-spilot']
            }
        });
        if (images.length == 0) {
            console.warn(`Base image faasit-spilot not found, using default image`)
            return 'faasit-spilot'
        }
        const image_tags = images.flatMap(image => image.RepoTags).sort()
        return image_tags.at(-1) || 'faasit-spilot';
    }

    async build_functions_image(
        functions:ir.types.Reference<faas.Function>[], 
        ctx: faas.ProviderPluginContext, 
        fastStart:boolean = false,
        registry?: string, 
        app_name?:string
    ) {
        for (const fnRef of functions) {
            const image = await this.get_base_image(fnRef.value.output.baseImage)
            const fn = fnRef.value
            let fn_image_name:string = ''
            if (app_name) {
                fn_image_name = `${app_name}-${fn.$ir.name}:tmp`
            } else {
                fn_image_name = `${fn.$ir.name}:tmp`
            }
            await this.build_docker_image(image, fn_image_name, fn.output.codeDir, ctx,registry,fastStart)
        }

    }

    async build(input: faas.ProviderBuildInput, ctx: faas.ProviderPluginContext) {
        const {app,registry,provider} = input
        const {rt, logger} = ctx
        const startMode = provider.output.deployment?.startMode || 'tradition'
        const useFastStart:boolean = startMode == 'fast-start'
        logger.info(`Using fast start mode: ${useFastStart}`)
        const job_name = app.$ir.name
        if (app.output.workflow) {
            logger.info("Workflow mode")
            if (app.output.workflow.value.output.runtime == 'nodejs') {
                const image = await this.get_base_image(undefined)
                const template_py = `${path.dirname(__filename)}/template.py`
                const index_py = `${app.output.workflow.value.output.codeDir}/index.py`
                let python_scripts = fs.readFileSync(template_py).toString()
                python_scripts = python_scripts.replace(/__params__/g, app.output.inputExamples? JSON.stringify(app.output.inputExamples[0].value):'{}')
                fs.writeFileSync(index_py, python_scripts)
                const app_image_name = `${job_name}:tmp`
                await this.build_docker_image(image, app_image_name, app.output.workflow.value.output.codeDir, ctx, registry, useFastStart)
            } else {
                // const image = 'faasit-spilot:0.4'
                // for (const fnRef of app.output.workflow.value.output.functions) {
                //     const image = await this.get_base_image(fnRef.value.output.baseImage)
                //     const fn = fnRef.value
                //     const fn_image_name = `${job_name}-${fn.$ir.name}:tmp`
                //     await this.build_docker_image(image, fn_image_name, fn.output.codeDir, ctx,registry)
                // }
                await this.build_functions_image(app.output.workflow.value.output.functions,ctx,useFastStart,registry,job_name)
            }
        } else {
            logger.info("Function mode")
            await this.build_functions_image(app.output.functions,ctx,useFastStart,registry,job_name)
        }
    }


    generate_spilot_yaml(job_name:string) {
        const spilot_yaml = {
            image: 'enavenue/watcher-img:latest',
            job_name: job_name,
            setup: `uname -a
            echo "Hello, world!"`,
            run: `cd ${process.cwd()} && ft invoke`,
            profile: `cd ${process.cwd()} && ft invoke`
        }
        return yaml.dump(spilot_yaml)
    }

    

    async node_generate_dag(job_name:string, ctx: faas.ProviderPluginContext) {
        const data = {
            default_params: {
                [job_name]: {}
            },
            DAG: {
                [job_name]: {}
            }
        }
        return yaml.dump(data)
    }

    
    

    async build_docker_image(
        baseImageName:string,
        imageName: string,
        codeDir:string,
        ctx: faas.ProviderPluginContext, 
        registry?: string,
        useFastStart: boolean = false
    ) {
        function generate_faststart_code(codeDir:string) {
            const faststartCode = `${path.dirname(__filename)}/fast_start.py`
            const dest_py = `${codeDir}/fast_start.py`
            fs.writeFileSync(dest_py, fs.readFileSync(faststartCode))
        }
        const {rt,logger} = ctx
        logger.info(`> Building docker image ${imageName}`)
        let build_commands = []
        build_commands.push(`FROM ${baseImageName}`)
        build_commands.push(`COPY ${codeDir} /code`)
        build_commands.push(`WORKDIR /code`)
        if (useFastStart) {
            generate_faststart_code(codeDir)
        }
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
            args: ['build','--no-cache','-t',`${imageName}`,'-f',`${imageName}.dockerfile`,'.'],
            cwd: process.cwd(),
            stdio: 'inherit'
        })
        await proc.wait()
        if (registry) {
            await this.push_image(imageName, registry, ctx)
        }
    }

    async push_image(imageName: string, registry: string, ctx: faas.ProviderPluginContext) {
        const {rt,logger} = ctx
        logger.info(`> Tagging image ${imageName} to ${registry}/library/${imageName}`)
        const proc = rt.runCommand('docker', {
            args: ['tag',imageName,`${registry}/library/${imageName}`],
            cwd: process.cwd(),
            stdio: 'inherit'
        })
        await proc.wait()
        logger.info(`> Pushing image ${registry}/library/${imageName} to registry ${registry}...`)
        const proc2 = rt.runCommand('docker', {
            args: ['push',`${registry}/library/${imageName}`],
            cwd: process.cwd(),
            stdio: 'inherit'
        })
        await proc2.wait()
    }

    async deploy(input: faas.ProviderDeployInput, ctx: faas.ProviderPluginContext) {
        const {app,provider} = input
        const {rt, logger} = ctx
        logger.info("Deploying app to pku")
        const runtimeClass = provider.output.deployment?.runtimeClass || 'normal'
        logger.info(`Runtime class: ${runtimeClass}`)
        const startMode = provider.output.deployment?.startMode || 'tradition'
        logger.info(`Using fast start mode: ${startMode == 'fast-start'}`)
        function generate_app_yaml(app_name:string ,stages: stage[], runtime:string = 'normal') {
            function get_runtime_template(runtime:string) {
                if (runtime == 'runvk') {
                    return `${path.dirname(__filename)}/template_runvk.yaml`
                } else {
                    return `${path.dirname(__filename)}/template.yaml`
                }
            }
        
            let stage_profiles: { [key: string]: any } = {};
            let image_coldstart_latency: { [key: string]: number } = {};
            let port: number = 10000
            for (const stage of stages) {
                const _stage_generator = () => {
                    const file_name = stage.handler.split('.')[0]
                    const func_name = stage.handler.split('.')[1]
                    return {
                        request: {
                            vcpu: stage.request.vcpu
                        },
                        input_time: 0,
                        compute_time: 0,
                        output_time: 0,
                        worker_external_port: port++,
                        cache_server_external_port: port++,
                        worker_port: port++,
                        cache_server_port: port++,
                        
                        parallelism: 4,
                        image: stage.image,
                        codeDir: stage.codeDir,
                        command: '["/bin/bash"]',
                        args: `["-c", "cd / && PYTHONPATH=/code:$PYTHONPATH python3 -m serverless_framework.worker /code/${file_name}.py ${func_name} --port __worker-port__ --parallelism __parallelism__ --cache_server_port __cache-server-port__ --debug"]`
                    }
                }
                if (stage.replicas > 1) {
                    for (let i = 0; i < stage.replicas; i++) {
                        const name = `${stage.name}-${i}`
                        stage_profiles[name] = _stage_generator()
                    }
                } else {
                    const name = stage.name
                    stage_profiles[name] = _stage_generator()
                }
                image_coldstart_latency[stage.image] = 2.0
            }
    
            const app_yaml = {
                app_name: app_name,
                template: get_runtime_template(runtime),
                node_resources: {
                    cloud: {
                        vcpu: 20
                    }
                },
                image_coldstart_latency: image_coldstart_latency,
                knative_template: `${path.dirname(__filename)}/knative-template.yaml`,
                vk_template: ``,
                external_ip: "10.0.0.234",
                stage_profiles: stage_profiles,
                // default_params: inputExample,
            }
            return yaml.dump(app_yaml)
    
        }
        async function deploy_workflow_app() {
            async function python_generate_dag(handler:string, codeDir:string, ctx: faas.ProviderPluginContext) {
                const file_name = handler.split('.')[0]
                const func_name = handler.split('.')[1]
                const pythonCode = `
import json
import os
os.environ["FAASIT_PROVIDER"]="pku"
from ${file_name} import ${func_name}
output = ${func_name}()
print(output)
            `.trim() 
                const proc = ctx.rt.runCommand(`python`, {
                    args: ['-c', pythonCode],
                    cwd: codeDir,
                    stdio: 'pipe'
                })
        
                let result = ''
                await Promise.all([
                    proc.readOut(v => {
                        result += v
                    }),
                    proc.readErr(v => {
                        console.log(v)
                    }),
                ])
                await proc.wait()
                result = result.replace(/'/g, '"')
                result = JSON.parse(result)
                result = yaml.dump(result)
                return result
            }
            if (!app.output.workflow) {
                throw new Error("Workflow not found")
            }
            const job_name = app.$ir.name
            let stages = new Array<stage>()
            const runtime = app.output.workflow.value.output.runtime
            if (runtime == 'nodejs') {
                const stage:stage = {
                    name: job_name,
                    request: {
                        vcpu: 1
                    },
                    image: `${job_name}:tmp`,
                    codeDir: app.output.workflow.value.output.codeDir,
                    replicas: 1,
                    handler: 'handler'
                }
                stages.push(stage)
            } else {
                for (const fnRef of app.output.workflow.value.output.functions) {
                    const fn = fnRef.value
                    const fn_image_name = `${job_name}-${fn.$ir.name}:tmp`
                    const stage: stage = {
                        name: fn.$ir.name,
                        request: {
                            vcpu: fn.output.resource?.cpu? fn.output.resource.cpu : 1
                        },
                        image: fn_image_name,
                        codeDir: fn.output.codeDir,
                        replicas: fn.output.replicas? fn.output.replicas:1,
                        handler: fn.output.handler? fn.output.handler: 'index.handler'
                    }
                    stages.push(stage)
                }
            }
            let app_yaml = generate_app_yaml(app.$ir.name, stages, runtimeClass)
            let dag_yaml = ''
            if (runtime == 'nodejs') {
                dag_yaml = await this.node_generate_dag(job_name, ctx)
            } else {
                const handler = app.output.workflow.value.output.handler
                dag_yaml = await python_generate_dag(handler?handler:"index.handler" ,app.output.workflow.value.output.codeDir, ctx) 
            }
            app_yaml = app_yaml + '\n' + dag_yaml
            await rt.writeFile(`${app.$ir.name}.yaml`, app_yaml)
        }
        async function deploy_functions_app() {
            const job_name = app.$ir.name
            let stages = new Array<stage>()
            for (const fnRef of app.output.functions) {
                const fn = fnRef.value
                const fn_image_name = `${job_name}-${fn.$ir.name}:tmp`
                const stage: stage = {
                    name: fn.$ir.name,
                    request: {
                        vcpu: fn.output.resource?.cpu? fn.output.resource.cpu : 1
                    },
                    image: fn_image_name,
                    codeDir: fn.output.codeDir,
                    replicas: fn.output.replicas? fn.output.replicas:1,
                    handler: fn.output.handler? fn.output.handler: 'index.handler'
                }
                stages.push(stage)
            }
            let app_yaml = generate_app_yaml(app.$ir.name, stages, runtimeClass)
            app_yaml = app_yaml
            await rt.writeFile(`${app.$ir.name}.yaml`, app_yaml)
        }
        if (app.output.workflow) {
            await deploy_workflow_app()
        } else {
            await deploy_functions_app()
        }



    }

    async invokeWorkflow(input: faas.ProviderInvokeInput, ctx: faas.ProviderPluginContext) {
        const {app,provider} = input
        let cmd_args_map:{ [key: string]: string } = {
            'repeat': '1',
            'launch': 'tradition',
            'transmode': 'allTCP',
            'profile': `${process.cwd()}/${app.$ir.name}.yaml`
        }
        let com_args = [
            '-m',
            'serverless_framework.controller',
        ]
        if (provider.output.invoke) {
            for (let [key,value] of Object.entries(provider.output.invoke)) {
                cmd_args_map[key] = value
            }
        }
        for (let [key, value] of Object.entries(cmd_args_map)) {
            console.log(`Parse config ${key}=${value}`)
            com_args.push(`--${key}`)
            com_args.push(value)
        }
        const proc = ctx.rt.runCommand(`python`, {
            args: com_args,
            cwd: ctx.cwd,
            stdio: 'inherit'
        })

        let result = ''
        await Promise.all([
            proc.readOut(v => {
                result += v
            }),
            proc.readErr(v => {
                console.log(v)
            }),
        ])
        await proc.wait()
    }
    async invokeFunction(input: faas.ProviderInvokeInput, ctx: faas.ProviderPluginContext) {
        const {app, provider} = input
        const funcName = input.funcName
        const index = app.output.functions.findIndex(fn => fn.$ir.id == funcName)
        const params = input.input? JSON.stringify(input.input): '{}'
        if (index == -1) {
            throw new Error(`Function ${funcName} not found`)
        }
        let cmd_args_map:{ [key: string]: string } = {
            'repeat': '1',
            'launch': 'tradition',
            'transmode': 'allTCP',
            'profile': `${process.cwd()}/${app.$ir.name}.yaml`,
            'stage': funcName,
            'params': params
        }
        let com_args = [
            '-m',
            'serverless_framework.invoke'
        ]
        if (provider.output.invoke) {
            for (let [key,value] of Object.entries(provider.output.invoke)) {
                cmd_args_map[key] = value
            }
        }
        for (let [key, value] of Object.entries(cmd_args_map)) {
            console.log(`Parse config ${key}=${value}`)
            com_args.push(`--${key}`)
            com_args.push(value)
        }
        const proc = ctx.rt.runCommand(`python`, {
            args: com_args,
            cwd: ctx.cwd,
            stdio: 'inherit'
        })

        let result = ''
        await Promise.all([
            proc.readOut(v => {
                result += v
            }),
            proc.readErr(v => {
                console.log(v)
            }),
        ])
        await proc.wait()
    }
    async invoke(input: faas.ProviderInvokeInput, ctx: faas.ProviderPluginContext) {
        if (!faas.isWorkflowApplication(input.app)) {
            await this.invokeFunction(input, ctx)
        } else {
            await this.invokeWorkflow(input, ctx)
        }
    }
}

export default function PKUPlugin(): faas.ProviderPlugin {
    return new PKUProvider()
}