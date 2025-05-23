import FC_Open20210406, * as $FC_Open20210406 from '@alicloud/fc-open20210406'
import Admzip from 'adm-zip'
import Util, * as $Util from '@alicloud/tea-util'

export class AliyunFunction {
  readonly layer: string
  constructor(private opt: {
    client: FC_Open20210406,
    serviceName: string,
    functionName: string,
    codeDir: string,
    runtime: string,
    handler: string,
    env?: { [key: string]: any },
    resource? :{
      cpu?: number,
      memory?:number,
    },
    requirements: string[],
  }) {
    const region = 'cn-hangzhou'
    const accountId = process.env.FAASIT_SECRET_ALIYUN_ACCOUNT_ID
    const version = '24'
    const layer_name = 'ft-rt-py'
    // this.layer = `acs:fc:${region}:${accountId}:layers/${layer_name}/versions/${version}`
  }

  private zipFolderAndEncode() {
    const zip = new Admzip();
    zip.addLocalFolder(this.opt.codeDir);
    const zipBuffer = zip.toBuffer();
    const base64 = zipBuffer.toString('base64');
    return base64;
  }
  private transToLayers(requirement: string) {
    const region = 'cn-hangzhou'
    const accountId = process.env.FAASIT_SECRET_ALIYUN_ACCOUNT_ID
    const version = '1'
    return `acs:fc:${region}:${accountId}:layers/${requirement}/versions/${version}`
  }

  async create(): Promise<$FC_Open20210406.CreateFunctionResponse | undefined> {
    let code = new $FC_Open20210406.Code({
      zipFile: this.zipFolderAndEncode(),
    })
    let cpu = this.opt.resource?.cpu || 0.05
    let memory = this.opt.resource?.memory || 128
    if (memory / 1024 / cpu > 4) {
      cpu = memory / 1024 / 4
    } else if (memory / 1024 / cpu < 1) {
      cpu = memory / 1024
    }
    let layers: string[] = []
    for (const requirement of this.opt.requirements) {
      layers.push(this.transToLayers(requirement))
    }
    let createFunctionHeaders = new $FC_Open20210406.CreateFunctionHeaders({});
    let createFunctionRequests = new $FC_Open20210406.CreateFunctionRequest({
      layers: layers,
      functionName: this.opt.functionName,
      handler: this.opt.handler,
      runtime: this.opt.runtime,
      code: code,
      environmentVariables: this.opt.env,
      memorySize: memory,
      cpu: cpu,
      diskSize: 512,
      timeout: 100
    });
    let runtime = new $Util.RuntimeOptions({
      connectTimeout: 10000
    });
    try {
      const resp = await this.opt.client.createFunctionWithOptions(
        this.opt.serviceName,
        createFunctionRequests,
        createFunctionHeaders,
        runtime);
      return resp;
    } catch (error) {
      throw error;
    }
  }

  async get(): Promise<{ [key: string]: any } | undefined> {
    let getFunctionRequests = new $FC_Open20210406.GetFunctionRequest({});
    try {
      const resp = await this.opt.client.getFunction(this.opt.serviceName, this.opt.functionName, getFunctionRequests);
      return resp;
    } catch (error) {
      if (error.code != 'FunctionNotFound') {
        throw error;
      }
    }
  }

  async update(): Promise<$FC_Open20210406.UpdateFunctionResponse | undefined> {
    let code = new $FC_Open20210406.Code({
      zipFile: this.zipFolderAndEncode()
    })
    let headers = new $FC_Open20210406.UpdateFunctionHeaders({});
    let cpu = this.opt.resource?.cpu || 0.05
    let memory = this.opt.resource?.memory || 128
    if (memory / 1024 / cpu > 4) { // cpu 太小
      // cpu 的值必须是0.05的倍数
      const cpu_min = memory / 1024 / 4
      if (cpu_min < 0.05) {
        cpu = 0.05
      } else {
        cpu = Math.ceil(cpu_min / 0.05) * 0.05
      }
    } else if (memory / 1024 / cpu < 1) { // cpu 太大
      // cpu 的值必须是0.05的倍数
      const cpu_max = memory / 1024
      if (cpu_max < 0.05) {
        cpu = 0.05
      } else {
        cpu = Math.floor(cpu_max / 0.05) * 0.05
      }
    }
    let layers: string[] = []
    for (const requirement of this.opt.requirements) {
      layers.push(this.transToLayers(requirement))
    }
    let requests = new $FC_Open20210406.UpdateFunctionRequest({
      layers : layers,
      functionName: this.opt.functionName,
      handler: this.opt.handler,
      runtime: this.opt.runtime,
      code: code,
      environmentVariables: this.opt.env,
      memorySize: memory,
      cpu: cpu,
      diskSize: 512,
      timeout: 100
    });
    let runtime = new $Util.RuntimeOptions({
      connectTimeout: 10000
    });
    try {
      const resp = await this.opt.client.updateFunctionWithOptions(
        this.opt.serviceName,
        this.opt.functionName,
        requests,
        headers,
        runtime);
      return resp;
    } catch (error) {
      throw error;
    }
  }

  async invoke(event: any, timeout: undefined | number): Promise<$FC_Open20210406.InvokeFunctionResponse | undefined> {
    if (timeout === undefined) {
      timeout = 3000
    }
    let invokeFunctionRequests = new $FC_Open20210406.InvokeFunctionRequest({
      body: event ? Util.toBytes(JSON.stringify(event)) : Util.toBytes(JSON.stringify({}))
    });
    let invokeFunctionHeaders = new $FC_Open20210406.InvokeFunctionHeaders({
    });
    let runtime = new $Util.RuntimeOptions({
      readTimeout: timeout,
    });
    try {
      const resp = await this.opt.client.invokeFunctionWithOptions(this.opt.serviceName, this.opt.functionName, invokeFunctionRequests, invokeFunctionHeaders, runtime);
      return resp;
    } catch (error) {
      throw error;
    }
  }
}