import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export function alive(pid:number):boolean {try {process.kill(pid,0);return true;} catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}}
export async function canonical(root:string):Promise<string>{const p=await fs.realpath(root);return process.platform==='win32'?p.toLowerCase():p;}
export class ProjectLock {
 private token=randomUUID(); private held=false;
 constructor(readonly file:string){}
 static async for(root:string,base:string){await fs.mkdir(base,{recursive:true});return new ProjectLock(path.join(base,createHash('sha256').update(await canonical(root)).digest('hex')+'.lock'));}
 async acquire(){
  for(let attempt=0;attempt<2;attempt++){
   try {const h=await fs.open(this.file,'wx');await h.writeFile(JSON.stringify({pid:process.pid,token:this.token,created:Date.now()}));await h.close();this.held=true;return;}
   catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   let owner;try{owner=JSON.parse(await fs.readFile(this.file,'utf8'));}catch{throw new Error('Блокировка проекта повреждена или создаётся другим окном. Автоматическое снятие запрещено.');}
   if(alive(owner.pid)|| (owner.child && alive(owner.child)))throw new Error('Проект занят другим окном Trio или его процессом.');
   // Rename stale ownership atomically; never unlink a newly acquired lock.
   const stale=this.file+'.stale-'+this.token;
   try{await fs.rename(this.file,stale);}catch{continue;}
   const moved=JSON.parse(await fs.readFile(stale,'utf8'));
   if(moved.token!==owner.token){try{await fs.link(stale,this.file);}catch{}throw new Error('Владелец блокировки изменился; повторите позже.');}
   await fs.unlink(stale);
  }
  throw new Error('Не удалось захватить блокировку проекта.');
 }
 async child(pid:number){if(!this.held)throw new Error('Нет блокировки');await fs.writeFile(this.file,JSON.stringify({pid:process.pid,token:this.token,child:pid,created:Date.now()}));}
 async release(){if(!this.held)return;const o=JSON.parse(await fs.readFile(this.file,'utf8'));if(o.token!==this.token)throw new Error('Потерян владелец блокировки');await fs.unlink(this.file);this.held=false;}
}
