import {spawn,execFile} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export interface Launch {file:string;args:string[]}
export async function resolveCli(config:string):Promise<Launch>{
 let file=config;
 if(!path.isAbsolute(file)){
  const dirs=(process.env.PATH||'').split(path.delimiter);
  let found='';for(const dir of dirs){for(const ext of process.platform==='win32'?['.exe','.cmd','.bat','']:['']){const p=path.join(dir,file+ext);try{if((await fs.stat(p)).isFile()){found=p;break;}}catch{}}if(found)break;}
  if(!found)throw new Error(`CLI ${config} не найден. Укажите полный путь в настройках Trio.`);file=found;
 }
 if(/\.(cmd|bat|ps1)$/i.test(file)){
  const raw=await fs.readFile(file,'utf8');
  // Only resolve standard npm shims; never execute arbitrary launcher shell text.
  const match=raw.match(/(?:%dp0%|\$basedir)[\\/]([^"\r\n]*?\.(?:js|cjs|mjs))/i);
  if(!match)throw new Error('Неизвестный Windows launcher. Укажите .exe или стандартный npm .cmd launcher.');
  const entry=path.resolve(path.dirname(file),match[1]);await fs.access(entry);
  const node=await resolveCli('node');return {file:node.file,args:[entry]};
 }
 await fs.access(file);return {file,args:[]};
}
export class Supervisor {
 constructor(private readonly jobRunner?:string,private readonly env?:NodeJS.ProcessEnv){}
 private child?:ReturnType<typeof spawn>; private stopping?:Promise<void>;
 private interrupted=false;
 async stop(){
  this.interrupted=true;
  if(this.stopping)return this.stopping;
  const child=this.child;if(!child?.pid)return;
  this.stopping=(async()=>{
   const closed=new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once('close',()=>resolve());});
   if(process.platform==='win32'){
    try{if(this.jobRunner){if(!child.kill()&&child.exitCode===null)throw new Error('JobRunner не остановлен');}
      else await exec('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});}
    catch(e){if(child.exitCode===null && child.signalCode===null)throw new Error('Не удалось остановить дерево CLI: '+String(e));}
   }else{try{process.kill(-child.pid!,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
   await Promise.race([closed,new Promise<void>(resolve=>setTimeout(()=>{try{child.kill();}catch{} child.unref();resolve();},3000))]);
  })();return this.stopping;
 }
 async run(launch:Launch,args:string[],cwd:string,prompt:string,timeout:number,onLine:(line:string)=>void,onPid?:(pid:number)=>Promise<void>):Promise<{code:number|null;stderr:string;interrupted:boolean}>{
  if(this.child)throw new Error('Процесс уже запущен');this.interrupted=false;this.stopping=undefined;
  const native=process.platform==='win32'&&this.jobRunner;
  const child=spawn(native?this.jobRunner!:launch.file,native?[String(process.pid),launch.file,...launch.args,...args]:[...launch.args,...args],{cwd,env:this.env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});this.child=child;
  let stderr='',buffer='',stopError:unknown;
  child.stdout!.setEncoding('utf8');child.stderr!.setEncoding('utf8');
  child.stdout!.on('data',(text:string)=>{buffer+=text;if(buffer.length>4*1024*1024){void this.stop().catch(e=>{stopError=e;});return;}let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);onLine(line);}});
  child.stderr!.on('data',(text:string)=>{stderr=(stderr+text).slice(-16000);});child.stdin!.on('error',()=>{});
  const done=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
  const timer=setTimeout(()=>{void this.stop().catch(e=>{stopError=e;});},timeout);
  try{if(child.pid)await onPid?.(child.pid);child.stdin!.end(prompt);const code=await done;if(buffer.trim())onLine(buffer);await this.stopping;if(stopError)throw stopError;return {code,stderr,interrupted:this.interrupted};}
  catch(e){await this.stop();await done.catch(()=>{});throw e;}
  finally{clearTimeout(timer);this.child=undefined;}
 }
}
