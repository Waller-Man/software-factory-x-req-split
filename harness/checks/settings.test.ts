import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {boot,initProfile,readProfilePatches} from '@deepseek-ai/dsh-app-boot';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import Settings from '@deepseek-ai/dsh-settings';
import Registry from '@deepseek-ai/dsh-typert-registry';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ToolCallId,LlmAdapter,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import Plugin from '../lib/index.js';
import {snapshotConfig,type LiveOptions} from '../src/config.ts';
const Runtime=(await import(pathToFileURL(process.env.SF_RUNTIME_MODULE??resolve('../../reconstruct/packages/runtime/lib/index.js')).href)).default;
const python=process.env.REQ_SPLIT_TEST_PYTHON??resolve('server/.venv/Scripts/python.exe');

test('native save persists without reload; running tasks keep settings and new Python gets updated options',{timeout:45000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'req-settings-')),dir=join(home,'profile');
  t.after(()=>rm(home,{recursive:true,force:true}));
  initProfile(dir,['req-settings-test']);const bundle=join(dir,'node_modules/req-settings-test');await mkdir(bundle,{recursive:true});
  await writeFile(join(home,'package.json'),'{"name":"req-settings-test"}');
  await writeFile(join(bundle,'package.json'),JSON.stringify({name:'req-settings-test',version:'1.0.0',dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
  await writeFile(join(bundle,'cordis.patch.yml'),JSON.stringify([{insert:[
    {id:'config-editor',name:'cordis:editor'},{id:'settings',name:'cordis:settings'},
    {id:'sf-runtime',name:'cordis:runtime'},{id:'x-req-split',name:'cordis:splitter',config:{pythonPath:join(home,'missing-python.exe'),ocrEnabled:false}},
  ]}]));
  await writeFile(join(dir,'cordis.yml'),'[]\n');
  const profile={name:'test',startedBundles:['req-settings-test'],dir,patchPath:join(dir,'cordis.patch.yml'),installAnchor:join(home,'package.json'),cwd:home,home,overlays:[]};
  const start=()=>boot('dsh',join(dir,'cordis.yml'),readProfilePatches('dsh',profile as never),async ctx=>{
    ctx.provide('profileContext',profile as never);ctx.provide('appReady',{onReady:(listener:()=>void)=>{listener();return()=>{};}} as never);
    await mountAgentLoopTestDependencies(ctx,{workingDirectory:true});await ctx.plugin(Registry);await ctx.plugin(LocalSubprocess);
    Object.assign(ctx.loader.builtins,{editor:ConfigEditor,settings:Settings,runtime:Runtime,splitter:Plugin});
  });
  const ctx=await start();
  try{
    assert.equal(ctx.tools.get('split_requirement_document'),undefined,'A failed initial backend must not expose the business entry');
    const recoverable=ctx.settings.describe().find(item=>item.ns==='x-req-split')!;
    assert.ok(recoverable,'The native form remains available even when Python cannot start');
    await ctx.settings.mutate('x-req-split',[{op:'set',path:['pythonPath'],value:python}],recoverable.revision);
    for(let n=0;n<80&&!ctx.tools.get('split_requirement_document');n++)await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(ctx.tools.get('split_requirement_document'),'Saving a valid Python path retries startup and registers the entry');
    const fiber=[...ctx.loader.entries()].find(entry=>entry.options.id==='x-req-split')!.fiber!;
    const before=snapshotConfig(fiber.config as LiveOptions),spawns:any[]=[];
    const spawn=ctx.subprocess.spawn.bind(ctx.subprocess);
    ctx.subprocess.spawn=((options:any)=>{spawns.push(options);return spawn(options);}) as typeof ctx.subprocess.spawn;
    const harness=await mountAgentLoopTestHarness(ctx),agent=await harness.create(SessionId('settings-owner'),{},{cwd:home});
    async function call(action:string,args:object){
      const result=await ctx.tools.execute({name:'sf_runtime_'+action,arguments:args,agent,callId:ToolCallId(crypto.randomUUID()),signal:AbortSignal.timeout(25000)});
      const body=result.value as any;assert.equal(body.ok,true,JSON.stringify(body));return body.data;
    }
    const started=Promise.withResolvers<void>();
    class WaitingModel extends LlmAdapter {
      async listModels(provider:string){return [{provider,id:'tiny',name:'Synthetic model'}];}
      async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{started.resolve();await new Promise((_resolve,reject)=>options.signal!.addEventListener('abort',()=>reject(options.signal!.reason),{once:true}));}
    }
    ctx.llm.registerAdapter(['mock-settings'],new WaitingModel());
    const old=await call('run_tool',{toolId:'split_requirement_document',input:{text:'# 订单\n查看订单'},model:{provider:'mock-settings',model:'tiny'}});
    await started.promise;
    const descriptor=ctx.settings.describe().find(item=>item.ns==='x-req-split')!;
    assert.equal(descriptor.autoGenerate,false);
    await ctx.settings.mutate('x-req-split',[
      {op:'set',path:['ocrDpi'],value:240},{op:'set',path:['maxSourceMb'],value:1},{op:'set',path:['modelOutput'],value:'json-chat'},
    ],descriptor.revision);
    assert.equal([...ctx.loader.entries()].find(entry=>entry.options.id==='x-req-split')!.fiber,fiber,'Save must not reload the plugin');
    assert.equal(before.ocrDpi,180);assert.equal(snapshotConfig(fiber.config as LiveOptions).ocrDpi,240);
    const accepted=await call('run_tool',{toolId:'split_requirement_document',input:{text:'# 转换\n小材料',mode:'convert'}});
    let fresh:any;
    for(let n=0;n<60;n++){fresh=await call('get_run',{runId:accepted.runId});if(['completed','failed'].includes(fresh.status))break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(fresh.status,'completed',JSON.stringify(fresh.issues));
    assert.equal(spawns.length,1,'Changed backend settings start exactly one new Python instance');
    assert.equal(spawns[0].env.XAGENTS_OCR_DPI,'240');assert.equal(spawns[0].env.XAGENTS_MAX_SOURCE_MB,'1');
    const provenance=async(id:string)=>JSON.parse(await readFile(join(home,'outputs/runs',id,'intermediate/provenance.json'),'utf8'));
    assert.equal((await provenance(old.runId)).settings.ocrDpi,180);
    assert.equal((await provenance(old.runId)).settings.modelOutput,'prompt');
    assert.equal((await call('get_run',{runId:old.runId})).status,'running','Saving and a new backend must not cancel the old task');
    assert.equal((await provenance(accepted.runId)).settings.modelOutput,'json-chat');
    await call('cancel_run',{runId:old.runId});
    assert.match(await readFile(profile.patchPath,'utf8'),/240/);
  }finally{await ctx.fiber.dispose();}
  const restarted=await start();
  try{const value=restarted.settings.describe().find(item=>item.ns==='x-req-split')!.value as any;assert.equal(value.ocrDpi,240);assert.equal(value.modelOutput,'json-chat');}
  finally{await restarted.fiber.dispose();}
});

test('plugin form uses its own native entry, saves only a draft, validates and shows failures',{timeout:15000},async()=>{
  const host=resolve(process.env.DSH_SOURCE??'../../DSH-Softwarefactory');
  const hostRequire=createRequire(join(host,'package.json')),uiRequire=createRequire(join(host,'packages/client/ui-primitives/package.json'));
  const {JSDOM}=hostRequire('jsdom'),dom=new JSDOM('<!doctype html><div id="root"></div>');
  const previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  const React=uiRequire('react'),{createRoot}=uiRequire('react-dom/client'),root=createRoot(dom.window.document.getElementById('root'));
  let state:any={status:'loading',writable:true,revision:1};const listeners=new Set<()=>void>();
  let artifact:any,registration:any,Component:any,dictionaries:any,saves=0,fail=false;
  const scope={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},
    async mutate(ops:any[],revision:number){saves++;assert.equal(revision,state.revision);if(fail)throw new Error('Synthetic save error');const value={...state.value};for(const op of ops)value[op.path[0]]=op.value;state={...state,revision:revision+1,value};listeners.forEach(fn=>fn());return true;}};
  try{
    runInNewContext(await readFile(resolve('client.js'),'utf8'),{window:{__ModuleLoader__:{load:(value:any)=>{artifact=value;}}}});
    artifact.factory(uiRequire).apply({effect:(fn:Function)=>fn(),locale:{register:(_ns:string,data:any)=>{dictionaries=data;}},
      configForms:{get:(id:string)=>{assert.equal(id,'x-req-split');return scope;}},
      slots:{inject:(name:string,fn:Function)=>{assert.equal(name,'plugins.bundle.config');fn();},register:(options:any,view:any)=>{registration=options;Component=view;}}});
    assert.equal(artifact.id,'x-dsh');assert.equal(registration.key,'x-dsh');
    await React.act(async()=>root.render(React.createElement(Component,{view:'page',scope,t:(key:string)=>dictionaries.zh[key]})));
    assert.match(dom.window.document.body.textContent,/正在读取/);
    await React.act(async()=>{state={...state,status:'unavailable'};listeners.forEach(fn=>fn());});
    assert.match(dom.window.document.body.textContent,/前后端来自同一完整发布包/);
    const fields={pythonPath:'',port:0,startupTimeoutMs:30000,graceMs:3000,ocrEnabled:true,maxSourceMb:200,splitMaxChars:120000,ocrDpi:180,ocrMaxPages:50,ocrTimeout:60,ocrMaxRetries:1,ocrMinConfidence:0.5,modelOutput:'prompt'};
    await React.act(async()=>{state={...state,status:'ready',value:fields};listeners.forEach(fn=>fn());});
    const submit=()=>dom.window.document.querySelector('button[type=submit]');
    const edit=async(name:string,value:string)=>React.act(async()=>{const input=dom.window.document.querySelector(`input[name="${name}"]`);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
    const save=()=>React.act(async()=>dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
    assert.equal(submit().disabled,true);await edit('ocrDpi','240');assert.equal(state.value.ocrDpi,180);assert.equal(saves,0);
    await save();assert.equal(state.value.ocrDpi,240);assert.match(dom.window.document.body.textContent,/已保存/);assert.equal(submit().disabled,true);
    await edit('ocrMaxPages','0');await save();assert.equal(saves,1);assert.match(dom.window.document.body.textContent,/请检查/);
    await React.act(async()=>dom.window.document.querySelector('button[type=button]').click());
    await edit('ocrDpi','300');fail=true;await save();assert.match(dom.window.document.body.textContent,/保存失败/);assert.equal(state.value.ocrDpi,240);
    await React.act(async()=>{state={...state,writable:false};listeners.forEach(fn=>fn());});assert.equal(submit().disabled,true);
  }finally{await React.act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
