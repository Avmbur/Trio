import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {ProjectLock, alive} from '../processes/lock';
import {snapshot, Limits, Manifest, inside} from './snapshots';

// All writers and collectors share this lock, including other VS Code windows.
export class SnapshotStorage {
 readonly blobs:string;
 constructor(readonly base:string,private budget:()=>number){this.blobs=path.join(base,'snapshot-blobs');}
 async exclusive<T>(job:()=>Promise<T>):Promise<T>{
  await fs.mkdir(this.base,{recursive:true});
  const lock=new ProjectLock(path.join(this.base,'snapshot-storage.lock'));
  for(let n=0;;n++){try{await lock.acquire();break;}catch(e){if(n>=600)throw e;await new Promise(r=>setTimeout(r,100));}}
  try{return await job();}finally{await lock.release();}
 }
 private async remove(target:string){
  const resolved=path.resolve(target),projects=path.resolve(this.base,'projects');
  const parts=path.relative(projects,resolved).split(path.sep);
  const snapshotDir=inside(projects,resolved)&&parts.length===3&&parts[1]==='snapshots';
  const blobFile=path.dirname(resolved)===path.resolve(this.blobs);
  if(!snapshotDir&&!blobFile)throw new Error('Invalid snapshot cleanup path');
  try{const parent=await fs.realpath(path.dirname(resolved)),base=await fs.realpath(this.base);
   if(!inside(base,parent))throw new Error('Snapshot cleanup escaped storage');
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  await fs.rm(resolved,{recursive:true,force:true});
 }
 private async directories(dir:string){
  try{if((await fs.lstat(dir)).isSymbolicLink())throw new Error('Snapshot storage must not be a link');return (await fs.readdir(dir,{withFileTypes:true})).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>path.join(dir,e.name));}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 }
 private async size(dir:string):Promise<number>{
  let bytes=0;
  for(const e of await fs.readdir(dir,{withFileTypes:true})){
   const file=path.join(dir,e.name);if(e.isSymbolicLink())continue;
   bytes+=e.isDirectory()?await this.size(file):(await fs.stat(file)).size;
  }return bytes;
 }
 async create(root:string,target:string,limits:Limits){return this.exclusive(async()=>{
  await fs.mkdir(target,{recursive:true});
  await fs.writeFile(path.join(target,'active.json'),JSON.stringify({pid:process.pid}));
  try{const m=await snapshot(root,target,limits,true,this.blobs);await this.collect();return m;}
  catch(e){await this.remove(target);await this.collect();throw e;}
 });}
 async finish(target:string){await this.exclusive(async()=>{
  await fs.rm(path.join(target,'active.json'),{force:true});await this.collect();
 });}
 async prune(){await this.exclusive(()=>this.collect());}
 private async collect(){
  const records:{dir:string;at:number;bytes:number;active:boolean;m:Manifest}[]=[];
  for(const project of await this.directories(path.join(this.base,'projects'))){
   let refs:Set<string>|undefined,live=new Set<string>();
   // A persisted save guard means refs may be stale. Protect this project's
   // snapshots from both orphan cleanup and quota eviction until a save succeeds.
   let refsPending = true;
   try {await fs.access(path.join(project, 'snapshot-refs.pending'));}
   catch(e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') refsPending = false;}
   try{
    const pin=JSON.parse(await fs.readFile(path.join(project,'snapshot-refs.json'),'utf8'));
    if(Array.isArray(pin?.snapshots))refs=new Set(pin.snapshots.filter((v:any)=>typeof v==='string').map((v:string)=>path.resolve(v)));
    if(Array.isArray(pin?.active))live=new Set(pin.active.filter((v:any)=>typeof v==='string').map((v:string)=>path.resolve(v)));
   }catch{}
   // Missing refs are not evidence that a snapshot is orphaned.
   for(const dir of await this.directories(path.join(project,'snapshots'))){
    let active=refsPending;
    try{const pin=JSON.parse(await fs.readFile(path.join(dir,'active.json'),'utf8'));active ||= Number.isInteger(pin.pid)&&pin.pid>0&&alive(pin.pid);}catch{}
    let ownerAlive=false;try{const owner=JSON.parse(await fs.readFile(path.join(this.base,'owners',path.basename(project)+'.lock'),'utf8'));ownerAlive=Number.isInteger(owner.pid)&&owner.pid>0&&alive(owner.pid);}catch{}
    if(!active&&ownerAlive&&live.has(path.resolve(dir)))active=true;
    let m:Manifest;
    try{m=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));}
    catch(e){if(active)throw new Error('Active snapshot manifest unavailable');await this.remove(dir);continue;}
    if(!active&&refs&&!refs.has(path.resolve(dir))){await this.remove(dir);continue;}
    records.push({dir,m,active,at:(await fs.stat(path.join(dir,'manifest.json'))).mtimeMs,bytes:await this.size(dir)});
   }
  }
  const references=new Map<string,number>();
  const hashes=(m:Manifest)=>m.storage==='cas'?new Set(m.entries.filter(e=>!e.skip&&e.hash&&/^[a-f0-9]{64}$/.test(e.hash)).map(e=>e.hash!)):new Set<string>();
  for(const r of records)for(const h of hashes(r.m))references.set(h,(references.get(h)||0)+1);
  await fs.mkdir(this.blobs,{recursive:true});
  const sizes=new Map<string,number>();
  for(const e of await fs.readdir(this.blobs,{withFileTypes:true})){
   if(e.isFile()&&/^[a-f0-9]{64}\.tmp-/.test(e.name)){await this.remove(path.join(this.blobs,e.name));continue;}
   if(!e.isFile()||!/^[a-f0-9]{64}$/.test(e.name))continue;
   const file=path.join(this.blobs,e.name);
   if(!references.has(e.name))await this.remove(file);else sizes.set(e.name,(await fs.stat(file)).size);
  }
  let total=records.reduce((n,r)=>n+r.bytes,0)+[...sizes.values()].reduce((a,b)=>a+b,0);
  const budget=this.budget();if(!Number.isFinite(budget)||budget<=0)throw new Error('Invalid snapshot storage budget');
  for(const r of records.sort((a,b)=>a.at-b.at)){
   if(total<=budget)break;if(r.active)continue;
   await this.remove(r.dir);total-=r.bytes;
   for(const h of hashes(r.m)){
    const count=references.get(h)!-1;references.set(h,count);
    if(!count){await this.remove(path.join(this.blobs,h));total-=sizes.get(h)||0;}
   }
  }
 }
}
