// Pre-release smoke without VS Code: snapshot, diff, feed storage, usage token parse, short errors.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Store,shortError}=require('../dist/storage/store');
const {SnapshotStorage}=require('../dist/snapshots/storage');
const {snapshot,compare,beforeFile}=require('../dist/snapshots/snapshots');
const {grokAccessToken,expiryMs}=require('../dist/providers/adapter');
const {fresh}=require('../dist/shared/model');
async function main(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'trio-release-'));
 try{
  const work=path.join(root,'work');await fs.mkdir(work);
  await fs.writeFile(path.join(work,'a.txt'),'before');
  const limits={file:100000,total:100000,count:100,excludes:[]};
  const store=new SnapshotStorage(root,()=>1000000);
  const snap=path.join(root,'projects','p','snapshots','one');
  const manifest=await store.create(work,snap,limits);
  assert.equal(manifest.version,1);
  const chat=new Store(path.join(root,'projects','p'));
  const state=await chat.load();
  state.messages.push({id:'m',author:'Антон',text:'ход в Правках'});
  state.turns.push({id:'one',messageId:'m',recipient:'grok',status:'completed',snapshot:snap});
  await chat.save(state);
  await store.finish(snap);
  await fs.writeFile(path.join(work,'a.txt'),'after');
  const changes=await compare(work,snap,limits);
  assert.equal(changes[0].kind,'modified');
  assert.equal(await fs.readFile(await beforeFile(snap,'a.txt',store.blobs),'utf8'),'before');
  const raw=await fs.readFile(path.join(root,'projects','p','state.json'),'utf8');
  assert.doesNotMatch(raw,/ход в Правках/);
  await fs.writeFile(path.join(root,'projects','p','state.json'),JSON.stringify({turns:[],tasks:[]}));
  await store.prune();
  await fs.access(path.join(snap,'manifest.json'));
  const home=path.join(root,'home');await fs.mkdir(path.join(home,'.grok'),{recursive:true});
  const future=new Date(Date.now()+3600000).toISOString();
  assert.equal(Number.isNaN(Number(future)),true);
  assert.ok(expiryMs(future)>Date.now());
  await fs.writeFile(path.join(home,'.grok','auth.json'),JSON.stringify({'https://auth.x.ai::test':{key:'k',expires_at:future}}));
  assert.equal((await grokAccessToken({home,now:Date.now()})).token,'k');
  const notice=shortError("EPERM: operation not permitted, rename 'c:\\\\Users\\\\code\\\\state.json.tmp' -> 'c:\\\\Users\\\\code\\\\state.json'");
  assert.match(notice,/state\.json/);
  assert.doesNotMatch(notice,/Users\\\\code/);
  assert.equal(fresh().version,3);
  console.log('check-release ok');
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exit(1);});
