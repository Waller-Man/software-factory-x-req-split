import {Service,type Context} from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import {registerRunTool} from '@software-factory/runtime-sdk';
import {Backend,type BackendOptions} from './backend.ts';
import {runBusiness,type Input} from './business.ts';

export default class ReqSplit extends Service {
  static inject=['tools','sfRuntime','subprocess'];
  static Config=z.object({
    pythonPath:z.string().default('').description('预先准备的 Python；默认使用安装包 server/.venv。'),
    port:z.number().step(1).min(0).max(65535).default(0),
    startupTimeoutMs:z.number().min(1000).max(120000).default(30000),
    graceMs:z.number().min(100).max(30000).default(3000),
    ocrEnabled:z.boolean().default(true).description('使用本地 RapidOCR，不调用外部视觉服务。'),
  });
  constructor(ctx:Context,private readonly config:BackendOptions){super(ctx,'reqSplit');}
  async *[Service.init](){
    const backend=new Backend(this.ctx,this.config);
    yield ()=>backend.stop();
    await backend.start();
    registerRunTool<Input>(this.ctx,{
      toolId:'split_requirement_document',
      description:'转换 PDF、DOCX、XLSX、XLSM 或文本并拆分需求，交付 ZIP 与汇总 Markdown；通过软件工厂 Run 调用。',
      inputSchema:{
        type:'object',additionalProperties:false,
        properties:{
          path:{type:'string',description:'服务端当前工作区内文档的绝对路径；与 text 二选一。'},
          text:{type:'string',description:'非空需求文本；与 path 二选一。'},
          title:{type:'string',description:'文档标题。'},
          mode:{type:'string',enum:['split','convert'],description:'默认 split；convert 只转换、不调用模型。'},
        },
      },
      execute:(input,execution)=>runBusiness(backend,input,execution),
    });
  }
}

declare module '@deepseek-ai/cordis' {interface Context {reqSplit:ReqSplit}}
