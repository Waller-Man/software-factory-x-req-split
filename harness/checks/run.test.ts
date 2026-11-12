/** Small real Run + Python bridge checks. No paid model or full split pipeline. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Context} from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Registry from '@deepseek-ai/dsh-typert-registry';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ToolCallId,LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import Plugin from '../lib/index.js';

const runtimePath=process.env.SF_RUNTIME_MODULE??fileURLToPath(new URL('../../../reconstruct/packages/runtime/lib/index.js',import.meta.url));
const Runtime=(await import(pathToFileURL(runtimePath).href)).default;
const python=process.env.REQ_SPLIT_TEST_PYTHON??fileURLToPath(new URL('../../server/.venv/'+(process.platform==='win32'?'Scripts/python.exe':'bin/python'),import.meta.url));

test('Run bridge: pure conversion delivery, SDK model failure and cooperative cancellation',{timeout:45000},async t=>{
  const workspace=await realpath(await mkdtemp(join(tmpdir(),'req-run-')));
  const ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();await rm(workspace,{recursive:true,force:true});});
  await mountAgentLoopTestDependencies(ctx,{workingDirectory:true});
  const harness=await mountAgentLoopTestHarness(ctx);
  const agent=await harness.create(SessionId('owner-'+randomUUID()),{},{cwd:workspace});
  await ctx.plugin(Registry);await ctx.plugin(LocalSubprocess);
  await ctx.plugin(Runtime,{allowedToolIds:['split_requirement_document'],defaultTimeoutMs:20000});
  const plugin=await ctx.plugin(Plugin,{pythonPath:python,ocrEnabled:false});
  async function call(action:string,args:object){
    const result=await ctx.tools.execute({name:'sf_runtime_'+action,arguments:args,agent,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(25000)});
    assert.equal(result.isError,false,JSON.stringify(result));const value=result.value as any;
    assert.equal(value.ok,true,JSON.stringify(value));return value.data;
  }
  async function finish(runId:string){
    let seq=0;
    for(let n=0;n<100;n++){
      const update=await call('wait_run',{runId,afterSeq:seq,waitMs:200});seq=update.lastSeq;
      if(['completed','failed','cancelled','interrupted'].includes(update.run.status))return call('get_run',{runId});
    }
    throw new Error('Small task did not finish');
  }
  await t.test('registered input contract, conversion without a model, ZIP + Markdown artifact IDs',async()=>{
    const contract=await call('get_tool_contract',{toolId:'split_requirement_document'});
    assert.equal(contract.supportsRun,true);assert.equal(contract.inputSchema.additionalProperties,false);
    assert.equal(contract.inputSchema.properties.outputDir,undefined);
    const direct=await ctx.tools.execute({name:'split_requirement_document',arguments:{text:'direct'},agent,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(10000)});
    assert.equal(direct.isError,true,'Business entry requires an actual Run context');
    const input={text:'# 1 订单\n用户可以查看订单。',title:'小材料',mode:'convert'};
    const accepted=await call('run_tool',{toolId:'split_requirement_document',input});
    const run=await finish(accepted.runId);assert.equal(run.status,'completed',JSON.stringify(run.issues));
    assert.equal(run.progress,100);assert.ok(run.logs.length);assert.equal(run.model,undefined);
    assert.equal(run.result.files.length,2);
    assert.deepEqual(run.result.files.map((f:any)=>f.relativePath),['final/requirements.zip','final/requirements/final.md']);
    const material=await call('get_artifact',{runId:run.runId,artifactId:run.result.files[0].artifactId});
    assert.match(material.downloadUrl,/^\/api\/sf-runtime\/download\?/);
    const dir=join(workspace,'outputs','runs',run.runId);
    assert.equal((await readFile(join(dir,'final','requirements.zip'))).subarray(0,2).toString(),'PK');
    assert.match(await readFile(join(dir,'final','requirements','final.md'),'utf8'),/用户可以查看订单/);
    assert.deepEqual(JSON.parse(await readFile(join(dir,'input','request.json'),'utf8')).input,input);
  });

  class MockModel extends LlmAdapter {
    seen:GenerateOptions[]=[];waiting=false;started=Promise.withResolvers<void>();
    async listModels(provider:string){return [{provider,id:'tiny',name:'Tiny mock'}];}
    async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
      this.seen.push(options);
      if(this.waiting){
        this.started.resolve();
        await new Promise<void>((_resolve,reject)=>{const signal=options.signal!;if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
      }
      yield {type:'text-delta',index:0,text:'deliberately invalid JSON'};
      yield {type:'usage',usage:{inputTokens:2,outputTokens:1}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  const model=new MockModel();ctx.llm.registerAdapter(['internal-b'],model);
  await t.test('Python model request uses SDK model B and retains failed materials',async()=>{
    const accepted=await call('run_tool',{toolId:'split_requirement_document',input:{text:'# 1 订单\n查看订单'},model:{provider:'internal-b',model:'tiny'}});
    const run=await finish(accepted.runId);assert.equal(run.status,'failed');assert.equal(model.seen.length,1);
    assert.equal(model.seen[0].provider,'internal-b');assert.notEqual(model.seen[0].sessionId,agent.id);
    assert.ok(run.issues.some((i:any)=>i.level==='error'));
    assert.ok(run.artifacts.some((a:any)=>a.relativePath==='intermediate/model-0001-response.json'));
    const outcome=JSON.parse(await readFile(join(workspace,'outputs','runs',run.runId,'intermediate','backend-outcome.json'),'utf8'));
    assert.equal(outcome.status,'failed');assert.ok(outcome.events.some((e:any)=>e.type==='progress'));
  });
  await t.test('Run cancellation stops the Python job while waiting for a mock model',async()=>{
    model.waiting=true;
    const accepted=await call('run_tool',{toolId:'split_requirement_document',input:{text:'# 1 订单\n取消测试'},model:{provider:'internal-b',model:'tiny'}});
    await model.started.promise;await call('cancel_run',{runId:accepted.runId});
    const run=await finish(accepted.runId);assert.equal(run.status,'cancelled',JSON.stringify(run));
    const dir=join(workspace,'outputs','runs',run.runId);
    assert.equal(JSON.parse(await readFile(join(dir,'intermediate','backend-outcome.json'),'utf8')).status,'cancelled');
    assert.match(await readFile(join(dir,'input','material.txt'),'utf8'),/取消测试/);
    assert.equal(model.seen.length,2,'Never run the complete split pipeline');
  });
  await plugin.dispose();assert.equal(ctx.tools.get('split_requirement_document'),undefined);
});

test('real Run 0.3 gateway forwards JSON formats and records usage without exposing credentials',{timeout:30000},async t=>{
  const received:any[]=[],key='synthetic-upstream-credential';
  const upstream=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    received.push({body:JSON.parse(raw),authorization:req.headers.authorization});
    res.setHeader('content-type','application/json');
    // Deliberately stop at the original Python JSON parser instead of running the split pipeline.
    res.end(JSON.stringify(req.url?.endsWith('/responses')?{output:[{content:[{type:'output_text',text:'synthetic invalid JSON'}]}],usage:{input_tokens:3,output_tokens:2}}:
      {choices:[{message:{content:'synthetic invalid JSON'}}],usage:{prompt_tokens:3,completion_tokens:2}}));
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>{upstream.closeAllConnections();return new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const workspace=await realpath(await mkdtemp(join(tmpdir(),'req-json-gateway-'))),ctx=new Context();
  t.after(async()=>{await ctx.fiber.dispose();await rm(workspace,{recursive:true,force:true});});
  await mountAgentLoopTestDependencies(ctx,{workingDirectory:true});
  const harness=await mountAgentLoopTestHarness(ctx),agent=await harness.create(SessionId('json-owner-'+randomUUID()),{},{cwd:workspace});
  await ctx.plugin(Registry);await ctx.plugin(LocalSubprocess);
  const protocols=['openai-completions','openai-responses'] as const;
  const profiles=Object.fromEntries(protocols.map(protocol=>[protocol,{api:protocol,baseURL:`http://127.0.0.1:${(upstream.address() as any).port}/v1`,models:[{id:'fixed-b'}]}]));
  ctx.provide('settings',{configure:()=>()=>{},describe:()=>[{ns:'synthetic-connections',value:{providers:profiles}}]} as never);
  ctx.provide('credentials',{resolve:async()=>({value:key}),readRecord:async()=>({kind:'api-key',key})} as never);
  await ctx.plugin(WebServer,{host:'127.0.0.1',port:0,compression:'none'});
  class HttpModel extends LlmAdapter{
    async listModels(provider:string){return [{provider,id:'fixed-b',name:'Synthetic HTTP model'}];}
    async *stream(_options:GenerateOptions):AsyncIterable<StreamChunk>{assert.fail('JSON mode must use the Runtime gateway');}
  }
  ctx.llm.registerAdapter([...protocols],new HttpModel());
  ctx.llm.registerConfigurableProviders(protocols.map(provider=>({provider,displayName:provider,settingsNs:'synthetic-connections',settingsPath:['providers',provider]})));
  await ctx.plugin(Runtime,{defaultTimeoutMs:20000});
  async function call(action:string,args:object){
    const result=await ctx.tools.execute({name:'sf_runtime_'+action,arguments:args,agent,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(25000)});
    const body=result.value as any;assert.equal(body.ok,true,JSON.stringify(body));return body.data;
  }
  for(const protocol of protocols){
    const plugin=await ctx.plugin(Plugin,{pythonPath:python,ocrEnabled:false,modelOutput:protocol==='openai-completions'?'json-chat':'json-responses'});
    try{
      const accepted=await call('run_tool',{toolId:'split_requirement_document',input:{text:'# 订单\n小材料'},model:{provider:protocol,model:'fixed-b'}});
      let run:any;
      for(let n=0;n<80;n++){run=await call('get_run',{runId:accepted.runId});if(['completed','failed'].includes(run.status))break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.equal(run.status,'failed','Synthetic invalid JSON must retain the original parsing failure');
      assert.equal(run.modelCalls.length,1);assert.equal(run.modelCalls[0].protocol,protocol);
      const callId=run.modelCalls[0].requestId;
      const record=await readFile(join(workspace,'outputs/runs',run.runId,'logs/model-calls',callId+'.json'),'utf8');
      assert.ok(!record.includes(key));assert.ok(!record.includes('sf-run-'));
      assert.ok(JSON.parse(record).usage);
      const request=received.at(-1);assert.equal(request.authorization,`Bearer ${key}`);assert.equal(request.body.model,'fixed-b');
      if(protocol==='openai-completions')assert.deepEqual(request.body.response_format,{type:'json_object'});
      else assert.deepEqual(request.body.text,{format:{type:'json_object'}});
      const saved=await readFile(join(workspace,'outputs/runs',run.runId,'intermediate/model-0001-request.json'),'utf8');
      assert.ok(!saved.includes(key));assert.ok(!saved.includes('sf-run-'));
    }finally{await plugin.dispose();}
  }
  assert.equal(received.length,2);
});
