/** Small real Run + Python bridge checks. No paid model or full split pipeline. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
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
