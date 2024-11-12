import {faas} from '@faasit/std'
import { error } from 'console'
import yaml from 'js-yaml'

interface stage {
    name: string,
    request: {
        vcpu: number,
    }
    image: string,
    codeDir: string
}

class PKUProvider implements faas.ProviderPlugin {
    name: string = 'pku'


    generate_spilot_yaml(job_name:string, image:string) {
        const spilot_yaml = {
            image: image,
            job_name: job_name,
            setup: `uname -a
            echo "Hello, world!"`,
            run: `cd ServerlessPilot && python3 serverless-framework/controller.py --repeat __repeat_times__ --para __thput_para__ --launch __launch_mode__ --transmode __transmode__ --ditto_placement --profile config/mlpipe.yaml --remote_call_timeout 10.0 --post_ratio 1.0`,
            profile: `cd ServerlessPilot && python3 serverless-framework/controller.py --repeat __repeat_times__ --para __thput_para__ --launch __launch_mode__ --transmode __transmode__ --ditto_placement --profile config/mlpipe.yaml --remote_call_timeout 10.0 --post_ratio 1.0`
        }
        return yaml.dump(spilot_yaml)
    }

    async python_generate_dag(codeDir:string, ctx: faas.ProviderPluginContext) {
        const pythonCode = `
import json
import os
os.environ["FAASIT_PROVIDER"]="pku"
from index import handler
output,invoke = handler()
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

    generate_app_yaml(app_name:string ,stages: stage[]) {
        let stage_profiles: { [key: string]: any } = {};
        let port: number = 10000
        for (const stage of stages) {
            const name = stage.name
            const _stage = {
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
                args: `["-c", "cd / && PYTHONPATH=\${PYTHONPATH}:/serverless-framework:/packages python3 /serverless-framework/worker.py /code/index.py handler --port __worker-port__ --parallelism __parallelism__ --cache_server_port __cache-server-port__ --debug"]`
            }
            let stage_obj = {
                [name]: _stage
            }
            // stage_obj.set(name, _stage)
            stage_profiles[name] = _stage
        }

        const app_yaml = {
            app_name: app_name,
            template: `${process.cwd()}/template.yaml`,
            node_resources: {
                cloud: {
                    vcpu: 20
                }
            },
            image_coldstart_latency: {
                ['faasit-spilot:0.1']: 2.0
            },
            knative_template: `${process.cwd()}/knative-template.yaml`,
            external_ip: "10.0.0.234",
            stage_profiles: stage_profiles,
            // default_params: inputExample,
        }
        return yaml.dump(app_yaml)

    }

    async deploy(input: faas.ProviderDeployInput, ctx: faas.ProviderPluginContext) {
        const {app} = input
        const {rt, logger} = ctx
        logger.info("Deploying app to pku")
        if (app.output.workflow) {
            const job_name = app.$ir.name
            const image = 'faasit-spilot:0.1'
            const spilot_yaml = this.generate_spilot_yaml(job_name, image)
            await rt.writeFile('.spilot.yaml', spilot_yaml)
            let stages = new Array<stage>()
            for (const fnRef of app.output.workflow.value.output.functions) {
                const fn = fnRef.value
                const stage: stage = {
                    name: fn.$ir.name,
                    request: {
                        vcpu: fn.output.resource? parseInt(fn.output.resource.cpu) : 1
                    },
                    image: image,
                    codeDir: fn.output.codeDir
                }
                stages.push(stage)
            }
            let app_yaml = this.generate_app_yaml(app.$ir.name, stages)
            let dag_yaml = await this.python_generate_dag(app.output.workflow.value.output.codeDir, ctx)
            app_yaml = app_yaml + '\n' + dag_yaml
            await rt.writeFile(`${app.$ir.name}.yaml`, app_yaml)
            
            const proc = ctx.rt.runCommand('python', {
                args: ['upload.py', `deploy`,
                    '--path',
                    ctx.cwd,
                    '--job',
                    app.$ir.name,
                ],
                cwd: ctx.cwd,
                stdio: 'inherit'
            })
            await Promise.all([
                proc.readOut(v => {
                    console.log(v)
                }
                ),
                proc.readErr(v => {
                    console.log(v)
                })
            ])
            await proc.wait()
        }



    }
    async invoke(input: faas.ProviderInvokeInput, ctx: faas.ProviderPluginContext) {
        const {app} = input
        const pythonCode = `
import os
import sys
sys.path.append('${app.output.workflow?.value.output.codeDir}')
os.environ["FAASIT_PROVIDER"]="pku"
from index import handler
output,invoke = handler()
invoke('${process.cwd()}/${app.$ir.name}.yaml','${process.cwd()}/Redis')
    `.trim()
        const proc = ctx.rt.runCommand(`python`, {
            args: ['-c', pythonCode],
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
}

export default function PKUPlugin(): faas.ProviderPlugin {
    return new PKUProvider()
}