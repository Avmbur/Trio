const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {snapshot,compare}=require('../dist/snapshots/snapshots');
const limits={file:4096,total:16384,count:20,excludes:[]};
test('snapshots report created, changed, deleted and binary files without Git',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-snapshot-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'project'),snap=path.join(dir,'snapshot');await fs.mkdir(root);
 await fs.writeFile(path.join(root,'changed.txt'),'before');await fs.writeFile(path.join(root,'deleted.txt'),'old');
 const made=await snapshot(root,snap,limits);
 assert.equal(made.version,1);
 await fs.writeFile(path.join(root,'changed.txt'),'after');await fs.unlink(path.join(root,'deleted.txt'));
 await fs.writeFile(path.join(root,'binary.bin'),Buffer.from([0,1,2]));
 const changes=await compare(root,snap,limits);
 assert.equal(changes.find(e=>e.path==='changed.txt').kind,'modified');
 assert.equal(changes.find(e=>e.path==='deleted.txt').kind,'deleted');
 const binary=changes.find(e=>e.path==='binary.bin');assert.equal(binary.kind,'created');assert.equal(binary.binary,true);
});
test('oversized files are excluded; junction contents outside the project are not read',{skip:process.platform!=='win32'},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-snapshot-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'project'),other=path.join(dir,'outside');await fs.mkdir(root);await fs.mkdir(other);
 await fs.writeFile(path.join(other,'private.txt'),'outside');
 await fs.symlink(other,path.join(root,'link'),'junction');await fs.writeFile(path.join(root,'big'),Buffer.alloc(5000));
 const result=await snapshot(root,path.join(dir,'snapshot'),limits);
 assert.equal(result.complete,false);assert.ok(result.entries.find(e=>e.path==='big').skip);
 assert.ok(result.entries.find(e=>e.path==='link').link);assert.equal(result.entries.some(e=>e.path.includes('private')),false);
});
