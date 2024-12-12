from faasit_runtime import function, create_handler, FaasitRuntime

import subprocess
import json

node_scripts = f"""
async function main() {{
    const code = await import('./index.js')
    const handler = code.default.handler
    const output = await handler(__params__)
    console.log(output)
}}
main()
"""

@function
def nodejsfunc(frt:FaasitRuntime):
    _input = frt.input()
    rendered = node_scripts.replace('__params__', json.dumps(_input))
    with open('driver.js', 'w') as f:
        f.write(rendered)
        f.close()
    result = subprocess.run(['/opt/node/bin/node', 'driver.js'],env={
        'FAASIT_PROVIDER': 'local-once',
        'FAASIT_FUNC_NAME': '__executor',
        'FAASIT_WORKFLOW_FUNC_NAME': '__executor',
    })
    return frt.output(result.stdout)


handler = create_handler(nodejsfunc)