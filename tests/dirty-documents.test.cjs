const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {preserveDirty}=require('../dist/snapshots/dirtyDocuments');
const {snapshot,hash}=require('../dist/snapshots/snapshots');
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-dirty-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'project'),copies=path.join(dir,'storage','unsaved');
 await fs.mkdir(root);return {dir,root,copies,file:path.join(root,'backlog.md')};
}
test('stale dirty editor never replaces newer disk and both versions survive the snapshot',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,'Изменения агента на диске');
 const saved=await preserveDirty([{path:f.file,text:'Старый буфер редактора'}],f.copies);
 assert.deepEqual(saved.failed,[]);assert.equal(saved.copies.length,1);assert.equal(saved.copies[0].created,true);
 assert.equal(await fs.readFile(f.file,'utf8'),'Изменения агента на диске');
 assert.equal(await fs.readFile(saved.copies[0].copy,'utf8'),'Старый буфер редактора');
 const meta=JSON.parse(await fs.readFile(saved.copies[0].copy.replace(/\.md$/,'.source.json'),'utf8'));
 assert.equal(meta.source,f.file);assert.equal(meta.encoding,'utf8');
 const snap=path.join(f.dir,'snapshot');
 const manifest=await snapshot(f.root,snap,{file:4096,total:16384,count:20,excludes:[]});
 assert.equal(manifest.entries.find(e=>e.path==='backlog.md').hash,hash('Изменения агента на диске'));
 assert.equal(await fs.readFile(path.join(snap,'files','backlog.md'),'utf8'),'Изменения агента на диске');
});
test('matching editor does not write anything; a repeated conflicting version reuses its copy',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,'совпадает');
 assert.deepEqual(await preserveDirty([{path:f.file,text:'совпадает'}],f.copies),{copies:[],unchanged:[f.file],failed:[]});
 await assert.rejects(fs.stat(f.copies),{code:'ENOENT'});
 const docs=[{path:f.file,text:'из редактора'}];
 const a=await preserveDirty(docs,f.copies),files=await fs.readdir(f.copies);
 const b=await preserveDirty(docs,f.copies);
 assert.equal(b.copies[0].created,false);assert.equal(b.copies[0].copy,a.copies[0].copy);
 assert.deepEqual(await fs.readdir(f.copies),files);
});
test('several editor versions and equal names in different folders keep separate recoverable copies',async t=>{
 const f=await fixture(t),other=path.join(f.root,'other','backlog.md');
 await fs.mkdir(path.dirname(other));await fs.writeFile(f.file,'disk');await fs.writeFile(other,'other disk');
 const a=await preserveDirty([{path:f.file,text:'Версия 1'},{path:other,text:'Версия 1'}],f.copies);
 const b=await preserveDirty([{path:f.file,text:'Версия 2'}],f.copies);
 const copies=[...a.copies,...b.copies];assert.equal(new Set(copies.map(c=>c.copy)).size,3);
 assert.deepEqual(await Promise.all(copies.map(c=>fs.readFile(c.copy,'utf8'))),['Версия 1','Версия 1','Версия 2']);
 assert.equal(await fs.readFile(f.file,'utf8'),'disk');assert.equal(await fs.readFile(other,'utf8'),'other disk');
});
test('a deleted original stays deleted and an empty editor buffer is still recoverable',async t=>{
 const f=await fixture(t);const saved=await preserveDirty([{path:f.file,text:''}],f.copies);
 assert.equal(saved.copies.length,1);assert.equal(await fs.readFile(saved.copies[0].copy,'utf8'),'');
 await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
});
test('disk encoding and BOM remain byte-exact while editor copies use UTF-8',async t=>{
 const f=await fixture(t),bytes=Buffer.from('\ufeffНовая версия на диске','utf16le');await fs.writeFile(f.file,bytes);
 const saved=await preserveDirty([{path:f.file,text:'Старая версия редактора'}],f.copies);
 assert.deepEqual(await fs.readFile(f.file),bytes);
 assert.equal(await fs.readFile(saved.copies[0].copy,'utf8'),'Старая версия редактора');
});
test('copy failures leave the original intact and never overwrite an existing edited copy',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,'new disk');
 const blocked=path.join(f.dir,'blocked');await fs.writeFile(blocked,'not a directory');
 const docs=[{path:f.file,text:'old buffer'}];
 const failed=await preserveDirty(docs,blocked);assert.equal(failed.failed.length,1);assert.equal(failed.copies.length,0);
 const first=await preserveDirty(docs,f.copies);await fs.writeFile(first.copies[0].copy,'user changed copy');
 const again=await preserveDirty(docs,f.copies);assert.equal(again.failed.length,1);
 assert.equal(await fs.readFile(first.copies[0].copy,'utf8'),'user changed copy');
 assert.equal(await fs.readFile(f.file,'utf8'),'new disk');
});
