import type {Context} from '@deepseek-ai/cordis';
import type {SubprocessHandle} from '@deepseek-ai/dsh-subprocess';
import {createInterface} from 'node:readline';
import {randomUUID,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SplitError} from './contracts.ts';

// Packaged server payload lives next to lib; no dependency on the process cwd.
export const serverDirectory=fileURLToPath(new URL('../server/',import.meta.url));
export interface BackendOptions {pythonPath:string;port:number;startupTimeoutMs:number;graceMs:number;ocrEnabled:boolean}
/** One owned HTTP service, allocated by the host provider. Never adopts a listener or kills a PID. */
export class Backend {
  private handle?:SubprocessHandle;
  private readonly lifetime=new AbortController();
  private readonly token=randomBytes(32).toString('hex');
  private readonly instance=randomUUID();
  private baseUrl='';private exited=false;
  constructor(private readonly ctx:Context,private readonly options:BackendOptions){}
  async start():Promise<void>{
    if(this.handle)throw new SplitError('ALREADY_STARTED','Backend already started');
    const command=this.options.pythonPath||join(serverDirectory,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const python=await this.ctx.subprocess.resolveExecutable(command,{},this.lifetime.signal);
    const env:NodeJS.ProcessEnv={PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',PYTHONPATH:undefined,
      X_REQ_SPLIT_TOKEN:this.token,X_REQ_SPLIT_INSTANCE:this.instance,XAGENTS_PORT:String(this.options.port),XAGENTS_HOST:'127.0.0.1',XAGENTS_WORKERS:'1',
      XAGENTS_OCR_ENABLED:String(this.options.ocrEnabled),XAGENTS_OCR_PROVIDER:'rapidocr',XAGENTS_OCR_BASE_URL:'',XAGENTS_OCR_MODEL:'',XAGENTS_OCR_API_KEY:undefined};
    this.handle=this.ctx.subprocess.spawn({argv:[python,'-B','-u','-m','src'],cwd:serverDirectory,env,graceMs:this.options.graceMs,signal:this.lifetime.signal,stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'}});
    const handle=this.handle;let diagnostic='';
    const exited=handle.done.then(outcome=>{this.exited=true;throw new SplitError('BACKEND_EXIT',`Python 后端退出 (${outcome.exitCode})。可能端口冲突或依赖缺失：${diagnostic}`);},error=>{this.exited=true;throw error;});void exited.catch(()=>{});
    handle.stderr?.on('data',(chunk:Buffer)=>{diagnostic=(diagnostic+chunk.toString()).slice(-16000);});
    const startup=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(this.options.startupTimeoutMs)]);
    try{
      if(!handle.stdout)throw new Error('Missing backend stdout');
      const lines=createInterface({input:handle.stdout});
      const address=new Promise<number>((resolve,reject)=>{
        const abort=()=>reject(startup.reason);startup.addEventListener('abort',abort,{once:true});
        lines.on('line',line=>{try{const event=JSON.parse(line);if(event.type==='listening'&&event.instance===this.instance&&Number.isInteger(event.port)&&event.port>0&&event.port<65536){startup.removeEventListener('abort',abort);resolve(event.port);}}catch{/* other output is not a handshake */}});
      });
      const port=await Promise.race([address,exited]);this.baseUrl=`http://127.0.0.1:${port}`;
      for(const endpoint of ['/health','/ready']){
        while(true){
          startup.throwIfAborted();
          try{const value=await this.request(endpoint,undefined,startup) as {ok:boolean;instance:string};
            if(value.instance!==this.instance)throw new SplitError('PORT_CONFLICT','端口被其他服务占用；不会接管或终止它。');
            if(value.ok)break;
          }catch(error){if(this.exited||error instanceof SplitError)throw error;}
          await Promise.race([new Promise(r=>setTimeout(r,100)),exited]);
        }
      }
    }catch(error){await this.stop();throw new SplitError('BACKEND_START_FAILED',`Python 后端启动失败：${String(error)} ${diagnostic}。请提前准备 Python 依赖并检查端口。`);}
  }
  async request(path:string,body?:unknown,signal?:AbortSignal):Promise<unknown>{
    if(this.exited)throw new SplitError('BACKEND_EXIT','Python 后端已退出，请检查 DSH 插件错误后重新启用。');
    const response=await fetch(this.baseUrl+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([this.lifetime.signal,signal??AbortSignal.timeout(30000)])});
    if(!response.ok)throw new Error(`Backend HTTP ${response.status}: ${await response.text()}`);return response.json();
  }
  async stop(){
    this.lifetime.abort();const handle=this.handle;if(!handle)return;
    handle.terminate();await handle.done.catch(()=>{});
    if(!await handle.waitForExit(AbortSignal.timeout(this.options.graceMs*2)))throw new SplitError('PROCESS_CLEANUP','DSH 无法确认本插件的后端进程组已退出。');
  }
}
