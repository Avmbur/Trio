import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { State, Catalogs, fresh, input, providers, id, validAttachments, normalizeInstruction } from '../shared/model';

export function shortError(e: unknown): string {
 const raw = String(e);
 const paths = [...raw.matchAll(/[A-Za-z]:\\[^\s'"]+|\/(?:home|Users|var|tmp)\/[^\s'"]+/g)].map(m => m[0]);
 const name = paths.length ? path.basename(paths[0].replace(/\.tmp$/i, '')) : '';
 if (/\b(EPERM|EACCES|EBUSY)\b/i.test(raw) && /rename|open|write|unlink/i.test(raw))
  return 'Не удалось сохранить чат' + (name ? ' (' + name + ')' : '') + '. Файл занят. Подробности в Диагностике.';
 let text = raw;
 for (const p of paths) text = text.split(p).join(path.basename(p));
 if (text.length > 180) text = text.slice(0, 177) + '…';
 return text;
}

export async function writeAtomic(target: string, data: string, deadline = 2000): Promise<void> {
 const temp = target + '.tmp';
 const h = await fs.open(temp, 'w');
 try {await h.writeFile(data, 'utf8');} finally {await h.close();}
 await replace(temp, target, deadline);
}

function snapshotPaths(state: State): string[] {
 return [...state.turns, ...state.tasks].map(t => t.snapshot).filter((v): v is string => typeof v === 'string');
}
function activeSnapshots(state: State): string[] {
 return state.turns.filter(t => t.snapshot && (t.status === 'running' || t.status === 'preparing')).map(t => t.snapshot!);
}

export class Store {
 private pending: Promise<void> = Promise.resolve();
 constructor(readonly dir: string) {}
 async load(): Promise<State> {
  await fs.mkdir(this.dir,{recursive:true});
  const file=path.join(this.dir,'state.json');
  try { return await this.hydrate(this.parse(await fs.readFile(file,'utf8'))); }
  catch(e) {
   if ((e as NodeJS.ErrnoException).code==='ENOENT') return fresh();
   await fs.copyFile(file,path.join(this.dir,`state.corrupt-${Date.now()}.json`));
   try {
    const s=await this.hydrate(this.parse(await fs.readFile(file+'.bak','utf8')));
    s.diagnostics.push('Основное хранилище повреждено; восстановлена предыдущая запись. Исходник сохранён в state.corrupt-*.json.');
    return s;
   }
   catch { throw new Error(`Хранилище повреждено. Исходные данные сохранены в ${this.dir}. Восстановите state.json из резервной копии; Trio не перезаписывает историю.`); }
  }
 }
 private async hydrate(s: State): Promise<State> {
  if (s.version === 3) {
   const feed = await this.readFeed();
   if (feed) s.messages = feed;
  }
  s.version = 3;
  if (s.contextStart !== undefined && (typeof s.contextStart !== 'string' || !s.messages.some(m => m.id === s.contextStart)))
   throw new Error('Неверная граница контекста');
  return s;
 }
 private async readFeed(): Promise<State['messages'] | undefined> {
  try {
   const raw = await fs.readFile(path.join(this.dir,'messages.jsonl'),'utf8');
   if (!raw.trim()) return [];
   const messages = [];
   for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (!m || typeof m.id !== 'string' || typeof m.text !== 'string' || !['Антон','Колян','Жека','Гриха','Trio'].includes(m.author))
     throw new Error('Неверная история');
    if (m.attachments !== undefined && !validAttachments(m.attachments)) throw new Error('Неверные вложения');
    if (typeof m.at !== 'number' || !Number.isFinite(m.at) || m.at <= 0) delete m.at;
    messages.push(m);
   }
   return messages;
  } catch (e) {
   if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
   throw e;
  }
 }
 private parse(raw:string):State {
  const s=JSON.parse(raw);
  if (![1,2,3].includes(s.version)||!Array.isArray(s.messages)||!Array.isArray(s.tasks)||!Array.isArray(s.turns)||!Array.isArray(s.queue)||typeof s.draft!=='string'||!s.sessions||typeof s.sessions!=='object'||!Array.isArray(s.imports)||!Array.isArray(s.diagnostics)) throw new Error('Неверная схема');
  if(s.version===1){
   s.version=2;s.agents=fresh().agents;s.recipient='all';
   for(const t of s.turns){if(t.recipient==='both')t.recipient='all';if(t.next>0&&t.status==='proposed')t.status='interrupted';delete t.next;}
   delete s.paused;
   s.queue=s.queue.filter((x:string)=>s.turns.some((t:any)=>t.id===x&&t.status==='proposed'));
   s.diagnostics.push('История каркаса v1 перенесена. Автоматическая очередь отключена.');
  }
  if(!Array.isArray(s.agents)||s.agents.length!==3||providers.some(p=>s.agents.filter((a:any)=>a.id===p).length!==1)||s.agents.some((a:any)=>!input({type:'agent',agent:a}))||!s.agents.some((a:any)=>a.enabled))throw new Error('Неверные участники');
  if(!input({type:'draft',text:s.draft,recipient:s.recipient})||s.messages.some((m:any)=>typeof m.id!=='string'||typeof m.text!=='string'||!['Антон','Колян','Жека','Гриха','Trio'].includes(m.author)))throw new Error('Неверная история');
  if (s.conversationId === undefined) s.conversationId = id();
  if (s.draftAttachments === undefined) s.draftAttachments = [];
  if (!validAttachments(s.draftAttachments) || s.messages.some((m:any) => m.attachments !== undefined && !validAttachments(m.attachments))) throw new Error('Неверные вложения');
  if (s.responseOrder === undefined) s.responseOrder = [];
  if (typeof s.conversationId !== 'string' || !input({type:'draft',text:s.draft,recipient:s.recipient,responseOrder:s.responseOrder})) throw new Error('Неверный порядок ответов');
  if (s.version < 3 && s.contextStart !== undefined && (typeof s.contextStart !== 'string' || !s.messages.some((m:any)=>m.id===s.contextStart))) throw new Error('Неверная граница контекста');
  // Engine-reported occupancy is a cache, not history: anything unreadable is dropped, never fatal.
  if (!s.usage || typeof s.usage !== 'object' || Array.isArray(s.usage)) s.usage = {};
  for (const p of providers) {
   const u = s.usage[p];
   const number = (v:any) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
   if (u !== undefined && (!u || typeof u !== 'object' || !number(u.tokens) || !number(u.window))) delete s.usage[p];
   else if (u?.quota && (typeof u.quota !== 'object' || !number(u.quota.percent))) delete u.quota;
   else if (u?.quota && u.quota.resetsAt !== undefined && !number(u.quota.resetsAt)) delete u.quota.resetsAt;
  }
  s.autoReply = s.autoReply === true;
  s.autoEdits = s.autoEdits === true || s.autoActions === true;
  s.autoCommands = s.autoCommands === true;
  for (const t of s.turns) {
    if (typeof t.startedAt !== 'number' || !Number.isFinite(t.startedAt)) delete t.startedAt;
    if (typeof t.endedAt !== 'number' || !Number.isFinite(t.endedAt)) delete t.endedAt;
    if (typeof t.cycle !== 'number' || !Number.isFinite(t.cycle) || t.cycle < 1) delete t.cycle;
    const instruction = normalizeInstruction(t.instruction);
    if (instruction) t.instruction = instruction;
    else delete t.instruction;
  }
  // Posts from before the stamp, and any unreadable value, keep no time: the panel
  // falls back to their turn instead of inventing one.
  for (const m of s.messages) if (typeof m.at !== 'number' || !Number.isFinite(m.at) || m.at <= 0) delete m.at;
  return s;
 }

 // Model lists are a cache of what each CLI reported, kept apart from the conversation.
 async loadCatalogs():Promise<Catalogs> {
  try {
   const raw=JSON.parse(await fs.readFile(path.join(this.dir,'catalogs.json'),'utf8'));
   const out:Catalogs={};
   for(const p of providers){
    const list=raw?.[p];
    if(Array.isArray(list)&&list.every((m:any)=>m&&typeof m.value==='string'&&typeof m.label==='string'&&Array.isArray(m.efforts)))out[p]=list;
   }
   return out;
  } catch { return {}; }
 }
 async saveCatalogs(catalogs:Catalogs):Promise<void> {
  await writeAtomic(path.join(this.dir,'catalogs.json'), JSON.stringify(catalogs,null,2));
 }
 async archive(state:State):Promise<string> {
  await this.pending;
  const dir=path.join(this.dir,'archives'); await fs.mkdir(dir,{recursive:true});
  const file=path.join(dir,Date.now()+'-'+id()+'.json');
  const handle=await fs.open(file,'wx');
  try {await handle.writeFile(JSON.stringify(state,null,2),'utf8');await handle.sync();}
  finally {await handle.close();}
  return file;
 }
 save(state:State):Promise<void> {
  const messages = state.messages;
  const disk = Object.assign({}, state, {version: 3, messages: []});
  const data=JSON.stringify(disk,null,2);
  const feed = messages.length ? messages.map(m => JSON.stringify(m)).join('\n') + '\n' : '';
  const refs = JSON.stringify({pid: process.pid, snapshots: snapshotPaths(state), active: activeSnapshots(state)});
  const job=this.pending.then(async()=>{
   await fs.mkdir(this.dir,{recursive:true});
   await writeAtomic(path.join(this.dir,'messages.jsonl'), feed);
   const target=path.join(this.dir,'state.json'); const temp=target+'.tmp';
   const h=await fs.open(temp,'w'); try {await h.writeFile(data,'utf8');await h.sync();} finally {await h.close();}
   try {await fs.copyFile(target,target+'.bak');} catch(e) {if ((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   await replace(temp,target);
   await writeAtomic(path.join(this.dir,'snapshot-refs.json'), refs);
  }); this.pending=job.catch(()=>{}); return job;
 }
}
// Windows refuses to rename over a file someone holds open: another Trio window's snapshot
// cleanup reading state.json, antivirus, the indexer. Such a lock is momentary, so wait it out.
export async function replace(temp:string,target:string,deadline=2000):Promise<void> {
 const until=Date.now()+deadline;
 for(let pause=20;;pause=Math.min(pause*2,200)){
  try {return await fs.rename(temp,target);}
  catch(e) {
   const code=(e as NodeJS.ErrnoException).code;
   if(!['EPERM','EACCES','EBUSY'].includes(code!)||Date.now()>=until)throw e;
   await new Promise(r=>setTimeout(r,pause));
  }
 }
}
