import { ir } from "@faasit/core";
import { faas } from "@faasit/std";
import assert from "assert";
import path from "path";
import { spawn } from "child_process";
import { z } from "zod";

export const LocalOnceProviderSchema = ir.types.CustomBlockSchemaT(z.object({
  kind: z.literal('local-once'),
  input: z.object({
    value: z.unknown()
  }),
}))

class LocalOnceProvider implements faas.ProviderPlugin {
  name: string = "local-once"

  async deploy(input: faas.ProviderDeployInput, ctx: faas.ProviderPluginContext) {
    const { app, provider } = input
    const onceProvider = LocalOnceProviderSchema.parse(
      provider
    )
    const inputData = onceProvider.output.input.value

    if (faas.isWorkflowApplication(app)) {
      const workflow = app.output.workflow.value
      await this.deployWorkflow(ctx, inputData, workflow)
      return
    }

    const func = app.output.functions[0]
    if (!func) {
      throw new Error(`no functions provided`)
    }

    await this.deployFunction(ctx, inputData, func.value)
  }

  async invoke(input: faas.ProviderInvokeInput, ctx: faas.ProviderPluginContext) {
    throw new Error('not implemented');
  }

  // helpers
  async deployWorkflow(ctx: faas.ProviderPluginContext, inputData: unknown, workflowBlk: faas.Workflow) {
    const { logger } = ctx
    const workflow = workflowBlk.output
    // assert(workflow.runtime === 'nodejs')

    const inputJSON = JSON.stringify(inputData)
    // if (inputJSON.length < 100) {
    //   logger.info(`running workflow locally, use input=${inputJSON}`)
    // } else {
    //   logger.info(`running workflow locally`)
    // }
    const output = await this.executeFunction(ctx, '__executor', workflow.codeDir, inputData, workflow.runtime)
    logger.info(`workflow executed, output=${JSON.stringify(output)}`)
  }

  async deployFunction(ctx: faas.ProviderPluginContext, inputData: unknown, fn: faas.Function) {
    const { logger } = ctx

    logger.info(`run function locally, use input=${JSON.stringify(inputData)}`)
    const output = await this.executeFunction(ctx, fn.$ir.name, fn.output.codeDir, inputData, fn.output.runtime)
    logger.info(`function executed, output=${JSON.stringify(output)}`)
  }

  async executeFunction(ctx: faas.ProviderPluginContext, name: string, codeDir: string, inputData: unknown, runtime: string) {

    switch (runtime) {
      case 'nodejs':
        return this.executeJsCode(ctx, name, codeDir, inputData)
      case 'python':
        return this.executePyCode(ctx, name, codeDir, inputData)
      default:
        throw new Error(`unsupported runtime: ${runtime}`)
    }
  }

  async executePyCode(ctx: faas.ProviderPluginContext, name: string, codeDir: string, inputData: unknown) {
    process.env.FAASIT_PROVIDER = 'local-once'
    process.env.FAASIT_FUNC_NAME = name
    process.env.FAASIT_WORKFLOW_FUNC_NAME = name

    const dir = path.resolve(process.cwd(), codeDir)
    let moduleId = dir
    moduleId = path.resolve(dir, 'index')

    const pythonCode = `
import json
from index import handler;
import asyncio
inputData = ${inputData ? JSON.stringify(inputData) : '{}'};
async def main():
    output = await handler(inputData);
    output = json.dumps(output)
    print(json.loads(output))
loop = asyncio.get_event_loop()
loop.run_until_complete(main())
loop.close()
    `.trim()
    // console.log(pythonCode)

    const proc = ctx.rt.runCommand(`python`, {
      args: ['-c', pythonCode],
      cwd: dir,
      stdio: 'inherit'
    })

    let result = ''
    await Promise.all([
      proc.readOut(v => {
        console.log(v)
        result = v.replace(/\\n/g, '\n')
      }),
      proc.readErr(v => {
        console.log(v)
      }),
    ])

    await proc.wait()

    // console.log(result)
    return result
  }

  async executeJsCode(ctx: faas.ProviderPluginContext, name: string, codeDir: string, inputData: unknown) {
    process.env.FAASIT_PROVIDER = 'local-once'
    process.env.FAASIT_FUNC_NAME = name
    process.env.FAASIT_WORKFLOW_FUNC_NAME = name

    const dir = path.resolve(process.cwd(), codeDir)
    let moduleId = dir
    let moduleType: 'commonjs' | 'es6' = 'commonjs'

    // if index.mjs exists
    if (await ctx.rt.fileExists(path.resolve(dir, 'index.mjs'))) {
      moduleId = path.resolve(dir, 'index.mjs')
      moduleType = 'es6'
    } else {
      moduleId = path.resolve(dir, 'index.js')
      moduleType = 'commonjs'
    }

    const code = await import(moduleId)
    const handler = moduleType == 'commonjs' ? code.handler : code.default.handler
    const output = await handler(inputData)
    return output
  }
}

export default function LocalOncePlugin(): faas.ProviderPlugin {
  return new LocalOnceProvider()
}
