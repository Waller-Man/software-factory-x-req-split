import {Service,type Context} from '@deepseek-ai/cordis';
import {registerRunTool} from '@software-factory/runtime-sdk';
import type {} from '@deepseek-ai/dsh-settings';
import {Backends} from './backends.ts';
import {Config,snapshotConfig,type LiveOptions} from './config.ts';
import {runBusiness,type Input} from './business.ts';

export default class ReqSplit extends Service {
  static inject=['tools','sfRuntime','subprocess'];
  static Config=Config;
  constructor(ctx:Context,private readonly config:LiveOptions){super(ctx,'reqSplit');}
  async *[Service.init](){
    const backends=new Backends(this.ctx);let disposed=false,registered=false,attempted='';
    yield ()=>{disposed=true;return backends.stop();};
    const settings=this.ctx.inject(['settings'],scope=>{
      scope.effect(()=>scope.settings.configure({auto:false},this.ctx.fiber));
    });
    yield ()=>settings.dispose();
    const prepare=async()=>{
      if(disposed||registered)return;
      const options=snapshotConfig(this.config),key=JSON.stringify(options);
      if(key===attempted)return;attempted=key;
      const initial=await backends.acquire(options);await initial.release();
      if(disposed)return;
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
      execute:async(input,execution)=>{
        const options=snapshotConfig(this.config);
        const lease=await backends.acquire(options);
        try{return await runBusiness(lease.backend,input,execution,options);}
        finally{await lease.release();}
      },
      });
      registered=true;
    };
    // DSH settings exposes active fibers only: keep the form alive on a bad Python path.
    // The business entry is still unavailable until an owned backend has passed readiness.
    let preparation=Promise.resolve();
    const refresh=()=>preparation=preparation.then(prepare).catch(error=>{
      this.ctx.logger.error('Python 后端未就绪，需求拆分工具未开放；请在插件配置页修正设置并保存：%s',String(error));
    });
    this.ctx.on('settings/document-updated',ns=>{if(ns==='x-req-split'&&!registered)void refresh();});
    await refresh();
  }
}

declare module '@deepseek-ai/cordis' {interface Context {reqSplit:ReqSplit}}
