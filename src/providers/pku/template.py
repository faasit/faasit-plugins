from faasit_runtime import function, create_handler, FaasitRuntime

import subprocess
import logging

node_scripts = """
async function main() {
    const code = await import('./index.js')
    const handler = code.default.handler
    const output = await handler(__params__)
    console.log(output)
    process.stdout.write(JSON.stringify(output))
}
main()
"""

@function
def nodejsfunc(frt:FaasitRuntime):
    with open('/code/driver.js', 'w') as f:
        f.write(node_scripts)
        f.close()
    result = subprocess.run(['/root/.volta/bin/node', '/code/driver.js'],env={
        'FAASIT_PROVIDER': 'local-once',
        'FAASIT_FUNC_NAME': '__executor',
        'FAASIT_WORKFLOW_FUNC_NAME': '__executor',
    },capture_output=True,     # 捕获标准输出和标准错误
    text=True)
    return frt.output(result.stdout)


handler = create_handler(nodejsfunc)