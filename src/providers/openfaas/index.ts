import { faas } from '@faasit/std'
import yaml from 'js-yaml'

export default function OpenFaasPlugin(): faas.ProviderPlugin {
  const gateway = 'https://openfaas-ft.i2ec.top'

  return {
    name: 'openfaas',
    async deploy(input, ctx) {
      const { rt, logger } = ctx
      const { app } = input

      logger.info(`openfaas deploy`)

      for (const fnRef of app.output.functions) {
        const fn = fnRef.value
        logger.info(`deploy function ${fn.$ir.name}`)

        // const output = await rt.runCommand(
        //   `faas-cli deploy -g ${gateway} --lang node --handler ${fn.codeDir} --name ${fn.$ir.name} --image hello-world:latest`
        // )

        const stackObj = {
          version: '1.0',
          provider: {
            name: 'openfaas',
            gateway,
          },
          functions: {
            [fn.$ir.name]: {
              lang: 'node',
              handler: fn.output.codeDir,
              image: `reg.i2ec.top/faasit/${fn.$ir.name}:latest`,
            },
          },
        }

        const stackFile = `stack.tmp.yaml`

        // write to stack.yaml
        await rt.writeFile(stackFile, yaml.dump(stackObj))

        const proc = rt.runCommand(`faas-cli up -f ${stackFile}`)

        await Promise.all([
          proc.readOut(v => logger.info(v)),
          proc.readErr(v => logger.error(v))
        ])

        await proc.wait()

        await rt.removeFile(stackFile)
      }
    },

    async invoke(input, ctx) {
      const { rt, logger } = ctx

      logger.info(`invoke function ${input.funcName}`)

      const proc = rt.runCommand(
        `echo "" | faas-cli invoke ${input.funcName} -g ${gateway}`
      )

      await Promise.all([
        proc.readOut(v => logger.info(v)),
        proc.readErr(v => logger.error(v))
      ])
      await proc.wait()
    },
  }
}
