import {cp,copyFile,mkdir,readFile,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import type {Artifact,BusinessResult,ExecutionContext,ModelMessage} from '@software-factory/runtime-sdk';
import {serverDirectory} from './backend.ts';
import {SplitError} from './contracts.ts';

export interface Input {path?:string;text?:string;title?:string;mode?:'split'|'convert'}
export interface BackendClient {request(path:string,body?:unknown,signal?:AbortSignal):Promise<unknown>}
interface JobEvent {type:'progress'|'log';stage:string;message:string;progress?:number;level?:string}
interface Job {
  status:string;progress:number;stage:string;diagnostic?:string;result?:Record<string,unknown>;
  events:JobEvent[];requests:{id:string;messages:ModelMessage[]}[];
}
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));};
const json=(path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});

/** SDK 0.1.0 exposes outputDirectory, not workspaceRoot. Follow its verified outputs/runs layout. */
async function taskDirectory(execution:ExecutionContext){
  const dir=await realpath(execution.outputDirectory);
  if(dir!==resolve(execution.outputDirectory)||basename(dir)!==execution.runId||basename(dirname(dir))!=='runs'||basename(dirname(dirname(dir)))!=='outputs'){
    throw new SplitError('RUN_DIRECTORY','需要 Runtime 提供的 outputs/runs/<runId> 任务目录。');
  }
  return {dir,workspace:dirname(dirname(dirname(dir)))};
}

async function sourceHash(){
  const hash=createHash('sha256');
  const visit=async(dir:string):Promise<void>=>{
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const path=join(dir,entry.name);
      if(entry.isDirectory()&&entry.name!=='__pycache__')await visit(path);
      else if(entry.isFile()&&entry.name.endsWith('.py')){hash.update(relative(serverDirectory,path).replaceAll('\\','/'));hash.update(await readFile(path));}
    }
  };
  await visit(join(serverDirectory,'src'));return hash.digest('hex');
}

const mime=(path:string)=>({'.md':'text/markdown','.json':'application/json','.jsonl':'application/x-ndjson','.zip':'application/zip','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'}[extname(path).toLowerCase()]??'application/octet-stream');

/** Register stable stage files and keep the result itself small: ZIP + summary. */
async function artifacts(execution:ExecutionContext,known:Map<string,Artifact>,categories=['intermediate','snapshots','final']){
  const visit=async(folder:string):Promise<void>=>{
    for(const entry of await readdir(folder,{withFileTypes:true})){
      execution.signal.throwIfAborted();
      const full=join(folder,entry.name),path=relative(execution.outputDirectory,full).replaceAll('\\','/');
      if(entry.isSymbolicLink())throw new SplitError('ARTIFACT_LINK','产物中不能包含链接。');
      if(entry.isDirectory())await visit(full);
      else if(entry.isFile()&&!entry.name.endsWith('.tmp')&&!known.has(path)){
        known.set(path,await execution.addArtifact({kind:path.startsWith('final/')?'final':'intermediate',name:entry.name,relativePath:path,mime:mime(path)}));
      }
    }
  };
  for(const category of categories)await visit(join(execution.outputDirectory,category));
}

async function retainPythonLog(dir:string){
  await copyFile(join(dir,'logs','python.log'),join(dir,'intermediate','python.log')).catch(error=>{if(error.code!=='ENOENT')throw error;});
}

export async function runBusiness(backend:BackendClient,input:Readonly<Input>,execution:ExecutionContext):Promise<BusinessResult>{
  execution.signal.throwIfAborted();
  const {dir,workspace}=await taskDirectory(execution),known=new Map<string,Artifact>();
  let submission:Promise<unknown>|undefined,cleanup:Promise<void>|undefined,eventIndex=0;
  const stop=()=>cleanup??=(async()=>{
    if(!submission)return;
    try{await submission;}catch{return;}
    await backend.request(`/tasks/${execution.runId}/cancel`,{},AbortSignal.timeout(300000));
  })();
  execution.registerCleanup(stop);
  try{
    if(Boolean(input.path)===Boolean(input.text?.trim()))throw new SplitError('INVALID_INPUT','请提供 path 或非空 text，二选一。');
    const mode=input.mode??'split';
    if(!['split','convert'].includes(mode))throw new SplitError('INVALID_INPUT','mode 必须为 split 或 convert。');
    let payload:Input={...input,mode};
    if(input.path){
      if(!isAbsolute(input.path))throw new SplitError('SOURCE_PATH','path 必须是服务端工作区内的绝对路径。');
      const source=await realpath(input.path),info=await stat(source);
      if(!inside(workspace,source))throw new SplitError('SOURCE_PATH','输入文件不在本次 Run 所属工作区。');
      if(!info.isFile()||!['.pdf','.docx','.xlsx','.xlsm'].includes(extname(source).toLowerCase()))throw new SplitError('SOURCE_FORMAT','仅支持 PDF、DOCX、XLSX、XLSM。');
      if(info.size>200*1024*1024)throw new SplitError('SOURCE_SIZE','文档超过 200MB。');
      await copyFile(source,join(dir,'input',basename(source)));payload={...payload,path:source};
    }
    if(input.text)await writeFile(join(dir,'input','material.txt'),input.text,{mode:0o600});
    await json(join(dir,'intermediate','provenance.json'),{runId:execution.runId,plugin:'x-dsh',version:'0.3.0',pythonSourceSha256:await sourceHash(),model:execution.model.selection??null,mode,source:payload.path??'input/material.txt'});
    await execution.log(`开始${mode==='convert'?'文档转换':'需求拆分'}，任务 ${execution.runId}`,'prepare');
    await execution.reportProgress({stage:'prepare',stageName:'准备输入',progress:0});
    submission=backend.request('/tasks',{runId:execution.runId,runDirectory:dir,input:payload},AbortSignal.timeout(30000));
    await submission;
    const handled=new Set<string>();
    while(true){
      execution.signal.throwIfAborted();
      const job=await backend.request(`/tasks/${execution.runId}`,undefined,execution.signal) as Job;
      for(const event of job.events.slice(eventIndex)){
        if(event.type==='progress')await execution.reportProgress({stage:event.stage,stageName:event.stage,progress:Math.min(event.progress??0,98),message:event.message});
        else{
          await execution.log(event.message,event.stage);
          if(event.level==='WARNING'||event.level==='ERROR'||event.level==='CRITICAL')await execution.reportIssue({level:event.level==='WARNING'?'warning':'error',stage:event.stage,message:event.message});
        }
      }
      eventIndex=job.events.length;
      for(const request of job.requests){
        if(handled.has(request.id))continue;handled.add(request.id);
        await artifacts(execution,known,['intermediate','snapshots']);
        const prefix=join(dir,'intermediate',`model-${String(handled.size).padStart(4,'0')}`);
        await json(prefix+'-request.json',request);
        let answer;
        try{answer=await execution.model.call({messages:request.messages});}
        catch(error){await json(prefix+'-error.json',{id:request.id,error:String(error)});throw error;}
        await json(prefix+'-response.json',{id:request.id,model:execution.model.selection??null,...answer});
        await backend.request(`/tasks/${execution.runId}/model/${request.id}`,{text:answer.text},execution.signal);
      }
      if(job.status==='failed'||job.status==='cancelled')throw new SplitError('PYTHON_TASK_FAILED',job.diagnostic??job.status);
      if(job.status==='completed'){
        const result=job.result!;
        if(result.splitStatus==='failed')throw new SplitError('SPLIT_FAILED',String(result.splitError));
        for(const warning of [...(result.warnings as string[]??[]),...(result.splitWarnings as string[]??[])]){
          await execution.reportIssue({level:'warning',stage:'result',message:String(warning)});
        }
        if(mode==='convert'){
          const target=join(dir,'final','requirements');await mkdir(target,{recursive:true});
          await cp(join(dir,'intermediate'),target,{recursive:true});
          await copyFile(join(dir,'intermediate','document.md'),join(target,'final.md'));
        }
        await retainPythonLog(dir);
        await execution.reportProgress({stage:'package',stageName:'打包结果',progress:99});
        await json(join(dir,'final','result.json'),result);
        await backend.request('/archives',{runId:execution.runId,runDirectory:dir},execution.signal);
        await artifacts(execution,known);
        const files=['final/requirements.zip','final/requirements/final.md'].map(path=>known.get(path)!.artifactId);
        await execution.reportProgress({stage:'completed',stageName:'处理完成',progress:100});
        await execution.log('结果已打包，交付 ZIP 和汇总 Markdown。','completed');
        return {text:mode==='convert'?'文档转换完成，未调用模型。':`需求拆分完成：${result.requirementCount??0} 条需求。`,files};
      }
      await new Promise(resolve=>setTimeout(resolve,150));
    }
  }catch(error){
    await stop();
    await json(join(dir,'logs','error.json'),{error:String(error),cancelled:execution.signal.aborted});
    await retainPythonLog(dir);
    if(!execution.signal.aborted){
      await artifacts(execution,known);
      await execution.reportIssue({level:'error',message:error instanceof Error?error.message:String(error),code:error instanceof SplitError?error.code:'REQ_SPLIT_FAILED'});
    }
    throw error;
  }
}
