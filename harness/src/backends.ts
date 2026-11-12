import type {Context} from '@deepseek-ai/cordis';
import {Backend,type BackendOptions} from './backend.ts';
import type {Options} from './config.ts';
import {SplitError} from './contracts.ts';

interface Entry {backend:Backend;ready:Promise<void>;users:number}
/** Keep a backend per in-flight configuration; idle outdated instances are retired. */
export class Backends {
  private entries=new Map<string,Entry>();private latest='';private closed=false;
  constructor(private ctx:Context){}
  async acquire(options:Readonly<Options>){
    if(this.closed)throw new SplitError('PLUGIN_STOPPED','插件已停用。');
    const {modelOutput:_,...settings}=options;
    const key=JSON.stringify(settings);this.latest=key;
    await this.retireIdle();
    if(this.closed)throw new SplitError('PLUGIN_STOPPED','插件已停用。');
    let entry=this.entries.get(key);
    if(!entry){
      const backend=new Backend(this.ctx,settings as BackendOptions);
      entry={backend,ready:backend.start(),users:0};this.entries.set(key,entry);
    }
    const owned=entry;owned.users++;
    try{await owned.ready;}
    catch(error){owned.users--;if(this.entries.get(key)===owned)this.entries.delete(key);await owned.backend.stop().catch(()=>{});throw error;}
    if(this.closed){owned.users--;throw new SplitError('PLUGIN_STOPPED','插件已停用。');}
    let released=false;
    return {backend:owned.backend,release:async()=>{if(released)return;released=true;owned.users--;await this.retireIdle();}};
  }
  private async retireIdle(){
    for(const [key,entry] of this.entries){
      if(key!==this.latest&&entry.users===0){this.entries.delete(key);await entry.ready.catch(()=>{});await entry.backend.stop();}
    }
  }
  async stop(){
    this.closed=true;
    const entries=[...this.entries.values()];this.entries.clear();
    const results=await Promise.allSettled(entries.map(async entry=>{await entry.ready.catch(()=>{});await entry.backend.stop();}));
    const failure=results.find(result=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
  }
}
