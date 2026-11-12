import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {ExecutionContext,ModelProtocol} from '@software-factory/runtime-sdk';
import {modelCaller} from '../src/model.ts';

test('JSON bridge preserves both protocol formats, reuses the task connection and never calls a fallback model',async t=>{
  const requests:any[]=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    requests.push({path:req.url,authorization:req.headers.authorization,body:JSON.parse(raw)});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url?.endsWith('/responses')?{output:[{content:[{type:'output_text',text:'{"ok":true}'}]}]}:
      {choices:[{message:{content:'{"ok":true}'}}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address() as {port:number};let grants=0;
  const execution={signal:new AbortController().signal,model:{
    call:()=>{throw new Error('Unexpected compatibility fallback');},
    getConnection:async({protocol}:{protocol:ModelProtocol})=>{grants++;return {protocol,model:'fixed-model-b',apiKey:'temporary-test-lease',baseUrl:`http://127.0.0.1:${address.port}/v1`};},
  }} as unknown as ExecutionContext;
  const messages=[{role:'system',content:'JSON only'},{role:'user',content:[{type:'text',text:'small input'},{type:'image_url',image_url:{url:'data:image/png;base64,dGVzdA=='}}]}] as const;
  const chat=modelCaller(execution,'json-chat');
  assert.equal((await chat(structuredClone(messages) as any)).text,'{"ok":true}');
  await chat(structuredClone(messages) as any);assert.equal(grants,1);
  assert.deepEqual(requests[0].body.messages,messages);
  assert.deepEqual(requests[0].body.response_format,{type:'json_object'});
  assert.equal(requests[0].body.model,'fixed-model-b');
  assert.equal(requests[0].authorization,'Bearer temporary-test-lease');
  const responses=modelCaller(execution,'json-responses');
  assert.equal((await responses(structuredClone(messages) as any)).text,'{"ok":true}');
  assert.deepEqual(requests[2].body.text,{format:{type:'json_object'}});
  assert.deepEqual(requests[2].body.input[1].content,[{type:'input_text',text:'small input'},{type:'input_image',image_url:'data:image/png;base64,dGVzdA=='}]);
  assert.equal(requests[2].path,'/v1/responses');
  const incompatible={...execution,model:{...execution.model,getConnection:async()=>{throw new Error('MODEL_PROTOCOL_UNSUPPORTED');}}} as ExecutionContext;
  await assert.rejects(modelCaller(incompatible,'json-chat')([{role:'user',content:'JSON'}]),/MODEL_PROTOCOL_UNSUPPORTED/);
  assert.equal(requests.length,3,'Protocol errors never send a fallback request');
});

test('JSON gateway fetch receives task cancellation',async t=>{
  let started!:()=>void;const requestStarted=new Promise<void>(resolve=>{started=resolve;});
  const server=createServer((_req,_res)=>started());
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const controller=new AbortController(),address=server.address() as {port:number};
  const execution={signal:controller.signal,model:{getConnection:async()=>({protocol:'openai-completions',model:'mock',apiKey:'test',baseUrl:`http://127.0.0.1:${address.port}/v1`})}} as unknown as ExecutionContext;
  const pending=modelCaller(execution,'json-chat')([{role:'user',content:'JSON'}]);
  const stopped=assert.rejects(pending,/AbortError|cancelled/);
  await requestStarted;controller.abort(new Error('cancelled'));await stopped;
});
