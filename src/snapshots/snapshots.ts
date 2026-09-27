import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
export interface Entry {path:string;size:number;hash?:string;binary?:boolean;link?:string;skip?:string}
export const MANIFEST_VERSION=1;
export interface Manifest {version?:number;root:string;entries:Entry[];complete:boolean;bytes:number;storage?:'cas'}
export interface Limits {file:number;total:number;count:number;excludes:string[]}
export const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
export function inside(root:string,p:string){const rel=path.relative(root,p);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
export async function snapshot(root:string,dir:string,limits:Limits,copy=true,blobs?:string):Promise<Manifest>{
 const out:Manifest={version:MANIFEST_VERSION,root,entries:[],complete:true,bytes:0};let count=0;if(blobs)out.storage='cas';
 const excludes=['.git','node_modules','.venv',...limits.excludes];
 async function walk(relative:string){
  for(const item of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
   const rel=path.join(relative,item.name),full=path.join(root,rel),entry:Entry={path:rel,size:0};
   const skip=(why:string)=>{entry.skip=why;out.complete=false;out.entries.push(entry);};
   if(excludes.some(x=>(x.startsWith('*.')&&item.name.endsWith(x.slice(1)))||x===item.name||rel===x||rel.startsWith(x+path.sep))||inside(dir,full)){skip('Исключено настройками');continue;}
   const st=await fs.lstat(full);entry.size=st.size;
   if(st.isSymbolicLink()){entry.link=await fs.readlink(full);out.entries.push(entry);continue;}
   if(st.isDirectory()){await walk(rel);continue;}
   if(!st.isFile()){skip('Специальный файл');continue;}
   if(st.size>limits.file){skip('Лимит размера файла');continue;}
   if(count>=limits.count||out.bytes+st.size>limits.total){skip('Лимит снимка');continue;}
   try{
    const real=await fs.realpath(full);if(!inside(root,real)){skip('Путь вне проекта');continue;}
    const b=await fs.readFile(full);if(b.length>limits.file||out.bytes+b.length>limits.total){skip('Файл вырос сверх лимита');continue;}
    entry.hash=hash(b);entry.size=b.length;entry.binary=b.subarray(0,8192).includes(0);count++;out.bytes+=b.length;
    if(copy){
     const target=blobs?path.join(blobs,entry.hash):path.join(dir,'files',rel);await fs.mkdir(path.dirname(target),{recursive:true});
     if(blobs){
      try{await fs.access(target);}catch(e){
       if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
       const temp=target+'.tmp-'+randomUUID();
       try{await fs.writeFile(temp,b,{flag:'wx'});await fs.rename(temp,target);}finally{await fs.rm(temp,{force:true});}
      }
     }else await fs.writeFile(target,b,{flag:'wx'});
    }
    out.entries.push(entry);
   }catch(e){skip('Не удалось прочитать: '+(e as NodeJS.ErrnoException).code);}
  }
 }
 await fs.mkdir(dir,{recursive:true});await walk('');if(copy)await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(out,null,2));return out;
}
export interface Change {path:string;kind:'modified'|'created'|'deleted'|'excluded';binary:boolean;reason?:string}
export async function compare(root:string,dir:string,limits:Limits):Promise<Change[]>{
 const before:Manifest=await readManifest(dir);
 const after=await snapshot(root,dir,limits,false);const a=new Map(before.entries.map(e=>[e.path,e])),b=new Map(after.entries.map(e=>[e.path,e]));const changes:Change[]=[];
 for(const p of new Set([...a.keys(),...b.keys()])){const old=a.get(p),now=b.get(p);if(old?.skip||now?.skip){changes.push({path:p,kind:'excluded',binary:false,reason:old?.skip||now?.skip});continue;}if(!old||!now||old.hash!==now.hash||old.link!==now.link)changes.push({path:p,kind:!old?'created':!now?'deleted':'modified',binary:!!(old?.binary||now?.binary||old?.link||now?.link)});}
 return changes;
}

export async function readManifest(dir:string):Promise<Manifest>{
 try{return JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new Error('Снимок удалён. Сравнение с началом этого хода недоступно.');throw e;}
}
export async function beforeFile(dir:string,relative:string,blobs:string):Promise<string>{
 const m=await readManifest(dir),entry=m.entries.find(e=>e.path===relative);
 if(!entry||entry.skip)throw new Error('Файл не вошёл в снимок.');
 const base=m.storage==='cas'?blobs:path.join(dir,'files');
 if(m.storage==='cas'&&!/^[a-f0-9]{64}$/.test(entry.hash||''))throw new Error('Повреждён путь снимка.');
 const file=path.resolve(base,m.storage==='cas'?entry.hash!:relative);
 if(!inside(base,file))throw new Error('Повреждён путь снимка.');
 try{await fs.access(file);}catch{throw new Error('Содержимое снимка удалено. Diff недоступен.');}
 return file;
}
