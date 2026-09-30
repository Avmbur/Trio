const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {SnapshotStorage} = require('../dist/snapshots/storage');
const {snapshot, compare, beforeFile} = require('../dist/snapshots/snapshots');
const limits = {file:100000,total:100000,count:100,excludes:[]};
async function setup(t) {
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'trio-cas-'));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'work');await fs.mkdir(root);
 let budget=1000000;
 const store=new SnapshotStorage(base,()=>budget);
 async function state(project,turns){
  const dir=path.join(base,'projects',project);await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({turns,tasks:[]}));
  const snapshots=turns.map(t=>t.snapshot).filter(Boolean);
  const active=turns.filter(t=>t.snapshot&&(t.status==='running'||t.status==='preparing')).map(t=>t.snapshot);
  await fs.writeFile(path.join(dir,'snapshot-refs.json'),JSON.stringify({pid:process.pid,snapshots,active}));
 }
 const target=(project,id)=>path.join(base,'projects',project,'snapshots',id);
 return {base,root,store,state,target,budget:n=>budget=n};
}
test('CAS shares content across projects and retains both before versions',async t=>{
 const x=await setup(t);await fs.writeFile(path.join(x.root,'a'),'before');
 const a=x.target('a','one'),b=x.target('b','two');
 await x.store.create(x.root,a,limits);await x.state('a',[{snapshot:a}]);await x.store.finish(a);
 await x.store.create(x.root,b,limits);await x.state('b',[{snapshot:b}]);await x.store.finish(b);
 assert.equal((await fs.readdir(x.store.blobs)).length,1);
 await fs.writeFile(path.join(x.root,'a'),'after');
 assert.equal((await compare(x.root,a,limits))[0].kind,'modified');
 assert.equal(await fs.readFile(await beforeFile(b,'a',x.store.blobs),'utf8'),'before');
});
test('global quota evicts oldest across projects but protects active snapshots in another manager',async t=>{
 const x=await setup(t);await fs.writeFile(path.join(x.root,'a'),'first');
 const a=x.target('a','one'),b=x.target('b','two');
 await x.store.create(x.root,a,limits);await x.state('a',[{snapshot:a}]);await x.store.finish(a);
 await fs.writeFile(path.join(x.root,'a'),'second');await x.store.create(x.root,b,limits);await x.state('b',[{snapshot:b}]);
 x.budget(1);await x.store.prune();
 await assert.rejects(compare(x.root,a,limits),/Снимок удалён/);
 assert.equal(await fs.readFile(await beforeFile(b,'a',x.store.blobs),'utf8'),'second');
 await new SnapshotStorage(x.base,()=>1).prune();await fs.access(path.join(b,'manifest.json'));
 await x.store.finish(b);await assert.rejects(fs.access(b));assert.deepEqual(await fs.readdir(x.store.blobs),[]);
});
test('reset and startup orphan cleanup free only unreferenced content; dead pins do not retain it',async t=>{
 const x=await setup(t);await fs.writeFile(path.join(x.root,'a'),'shared');
 const a=x.target('a','one'),b=x.target('a','two');
 await x.store.create(x.root,a,limits);await x.store.create(x.root,b,limits);await x.state('a',[{snapshot:a},{snapshot:b}]);
 await x.store.finish(a);await x.store.finish(b);
 await x.state('a',[{snapshot:b}]);await x.store.prune();await assert.rejects(fs.access(a));assert.equal((await fs.readdir(x.store.blobs)).length,1);
 await fs.writeFile(path.join(b,'active.json'),JSON.stringify({pid:2147483647}));
 await x.state('a',[]);await x.store.prune();await assert.rejects(fs.access(b));assert.deepEqual(await fs.readdir(x.store.blobs),[]);
});
test('legacy snapshots remain readable and count against the global budget',async t=>{
 const x=await setup(t);await fs.writeFile(path.join(x.root,'a'),'legacy');const a=x.target('a','one');
 await snapshot(x.root,a,limits);await x.state('a',[{snapshot:a}]);
 assert.equal(await fs.readFile(await beforeFile(a,'a',x.store.blobs),'utf8'),'legacy');
 x.budget(1);await x.store.prune();await assert.rejects(compare(x.root,a,limits),/Снимок удалён/);
});
test('cleanup follows snapshot-refs and does not read state.json',async t=>{
 const x=await setup(t);await fs.writeFile(path.join(x.root,'a'),'keep');
 const a=x.target('a','one');
 await x.store.create(x.root,a,limits);await x.state('a',[{snapshot:a}]);await x.store.finish(a);
 await fs.writeFile(path.join(x.base,'projects','a','state.json'),JSON.stringify({turns:[],tasks:[]}));
 await x.store.prune();
 await fs.access(path.join(a,'manifest.json'));
 await x.state('a',[]);
 await fs.writeFile(path.join(x.base,'projects','a','state.json'),JSON.stringify({turns:[{snapshot:a}],tasks:[]}));
 await x.store.prune();
 await assert.rejects(fs.access(a));
});
test('extension excludes keep docs and concurrent writers preserve shared blobs',async t=>{
 const x=await setup(t);await fs.mkdir(path.join(x.root,'docs'));await fs.writeFile(path.join(x.root,'docs','a.md'),'docs');await fs.writeFile(path.join(x.root,'old.vsix'),'package');
 const a=x.target('a','one'),b=x.target('b','two');
 await Promise.all([x.store.create(x.root,a,{...limits,excludes:['*.vsix']}),new SnapshotStorage(x.base,()=>1000000).create(x.root,b,{...limits,excludes:['*.vsix']})]);
 assert.equal((await fs.readdir(x.store.blobs)).length,1);
 assert.equal(await fs.readFile(await beforeFile(a,path.join('docs','a.md'),x.store.blobs),'utf8'),'docs');
 await assert.rejects(beforeFile(a,'old.vsix',x.store.blobs),/не вошёл/);
});

test('locked refs preserve a finished snapshot and its blobs until the next successful save',
 {skip:process.platform!=='win32'},async t=>{
 const {Store}=require('../dist/storage/store');
 const x=await setup(t);await fs.writeFile(path.join(x.root,'a'),'before');
 const project=path.join(x.base,'projects','a'),chat=new Store(project),state=await chat.load();
 await chat.save(state);
 const target=x.target('a','one');await x.store.create(x.root,target,limits);
 const reader=await fs.open(path.join(project,'snapshot-refs.json'),'r');
 try {
  state.turns.push({id:'one',messageId:'m',recipient:'codex',status:'completed',snapshot:target});
  await chat.save(state);
  assert.ok(state.diagnostics.some(s=>s.includes('snapshot-refs:')));
  await x.store.finish(target);
  assert.equal(await fs.readFile(await beforeFile(target,'a',x.store.blobs),'utf8'),'before');
  await fs.access(path.join(project,'snapshot-refs.pending'));
  // No in-memory flag or live-process pin: a different manager must also preserve it.
  await fs.writeFile(path.join(target,'active.json'),JSON.stringify({pid:2147483647}));
  await new SnapshotStorage(x.base,()=>1).prune();
  assert.equal(await fs.readFile(await beforeFile(target,'a',x.store.blobs),'utf8'),'before');
 } finally {await reader.close();}
 await chat.save(state);
 await assert.rejects(fs.access(path.join(project,'snapshot-refs.pending')),{code:'ENOENT'});
 await x.store.prune();await fs.access(path.join(target,'manifest.json'));
 // A successful save releases the guard; normal quota eviction must work again.
 x.budget(1);await x.store.prune();
 await assert.rejects(fs.access(target),{code:'ENOENT'});
 assert.deepEqual(await fs.readdir(x.store.blobs),[]);
});
