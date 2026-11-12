import type {ExecutionContext,ModelConnection,ModelMessage,ModelResponse} from '@software-factory/runtime-sdk';
import type {ModelOutput} from './config.ts';
import {SplitError} from './contracts.ts';

/** The temporary gateway credential stays in this TS closure, never in Python or files. */
export function modelCaller(execution:ExecutionContext,mode:ModelOutput){
  let connection:Promise<ModelConnection>|undefined;
  return async(messages:ModelMessage[]):Promise<ModelResponse>=>{
    if(mode==='prompt')return execution.model.call({messages});
    const protocol=mode==='json-chat'?'openai-completions':'openai-responses';
    if(!execution.model.getConnection)throw new SplitError('RUNTIME_UPGRADE_REQUIRED','JSON 模式需要软件工厂 Runtime 0.3.0。');
    connection??=execution.model.getConnection({protocol});
    const route=await connection;
    if(route.protocol!==protocol)throw new SplitError('MODEL_PROTOCOL_UNSUPPORTED','模型连接与所选 JSON 协议不匹配；请在 DSH 选择匹配的连接或使用兼容模式。');
    const input=messages.map(message=>({role:message.role,content:typeof message.content==='string'?message.content:message.content.map(part=>
      part.type==='text'?{type:'input_text',text:part.text}:{type:'input_image',image_url:part.image_url.url})}));
    const body=mode==='json-chat'?{model:route.model,messages,response_format:{type:'json_object'}}:
      {model:route.model,input,text:{format:{type:'json_object'}}};
    const response=await fetch(route.baseUrl.replace(/\/$/,'')+(mode==='json-chat'?'/chat/completions':'/responses'),{
      method:'POST',headers:{authorization:`Bearer ${route.apiKey}`,'content-type':'application/json'},
      body:JSON.stringify(body),signal:execution.signal,redirect:'error',
    });
    if(!response.ok){await response.body?.cancel();throw new SplitError('MODEL_HTTP',`JSON 模型请求失败（HTTP ${response.status}），详情见 Run 模型调用记录；不会回退模型或协议。`);}
    const answer=await response.json() as any;
    const text=mode==='json-chat'?answer.choices?.[0]?.message?.content:
      answer.output?.flatMap((item:any)=>item.content??[]).filter((part:any)=>part.type==='output_text').map((part:any)=>part.text).join('');
    if(typeof text!=='string'||!text.trim())throw new SplitError('MODEL_EMPTY','JSON 模型没有返回有效文本，请检查 Run 模型记录。');
    // Original Python parsing, validation and correction retries remain in charge.
    return {text};
  };
}
