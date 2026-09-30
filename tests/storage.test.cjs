const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {Store,replace,shortError}=require('../dist/storage/store');
const {fresh}=require('../dist/shared/model');
test('v1 migration preserves history and forbids automatic second answer',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const old={...fresh(),version:1,paused:false,turns:[{id:'old',messageId:'m',recipient:'both',next:1,status:'proposed'}],queue:['old']};
 delete old.agents;delete old.recipient;
 old.messages=[{id:'m',author:'Антон',text:'Привет'}];
 await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(old));
 const s=await new Store(dir).load();
 assert.equal(s.version,3);assert.equal(s.messages[0].text,'Привет');assert.deepEqual(s.queue,[]);assert.equal(s.agents.length,3);
});
test('damaged primary restores backup and retains corrupt original',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new Store(dir);const s=await store.load();
 s.draft='before';await store.save(s);s.draft='after';await store.save(s);
 await fs.writeFile(path.join(dir,'state.json'),'{broken');
 const recovered=await store.load();assert.equal(recovered.draft,'before');
 assert.ok((await fs.readdir(dir)).some(n=>n.startsWith('state.corrupt-')));
});
test('save waits out a reader briefly holding state.json open',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new Store(dir);const s=await store.load();
 s.draft='before';await store.save(s);
 const reader=await fs.open(path.join(dir,'state.json'),'r');
 const release=new Promise(r=>setTimeout(r,150)).then(()=>reader.close());
 s.draft='after';await store.save(s);await release;
 assert.equal((await new Store(dir).load()).draft,'after');
 assert.equal((await fs.readdir(dir)).includes('state.json.tmp'),false);
});
test('replace gives up on a lock that outlasts the deadline',{skip:process.platform!=='win32'},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const target=path.join(dir,'a');await fs.writeFile(target,'1');await fs.writeFile(target+'.tmp','2');
 const reader=await fs.open(target,'r');
 try {await assert.rejects(replace(target+'.tmp',target,100),{code:'EPERM'});} finally {await reader.close();}
});
test('a post keeps a readable time and loses a broken one instead of failing the load',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const state={...fresh(),messages:[
  {id:'a',author:'Антон',text:'со временем',at:1789200000000},
  {id:'b',author:'Колян',text:'время строкой',at:'сегодня'},
  {id:'c',author:'Гриха',text:'время битое',at:Number.NaN},
  {id:'d',author:'Trio',text:'старая запись без времени'}]};
 await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state));
 const s=await new Store(dir).load();
 assert.equal(s.messages[0].at,1789200000000);
 for(const m of s.messages.slice(1))assert.equal('at' in m,false,m.id+' сохранил негодное время');
});
test('messages live in jsonl so state.json does not hold the feed',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new Store(dir);const s=await store.load();
 s.messages.push({id:'a',author:'Антон',text:'секретная-лента-xyz'});
 s.turns.push({id:'t',messageId:'a',recipient:'claude',status:'completed',snapshot:path.join(dir,'snapshots','t')});
 await store.save(s);
 const raw=await fs.readFile(path.join(dir,'state.json'),'utf8');
 assert.doesNotMatch(raw,/секретная-лента-xyz/);
 assert.match(await fs.readFile(path.join(dir,'messages.jsonl'),'utf8'),/секретная-лента-xyz/);
 const refs=JSON.parse(await fs.readFile(path.join(dir,'snapshot-refs.json'),'utf8'));
 assert.deepEqual(refs.snapshots,[path.join(dir,'snapshots','t')]);
 const loaded=await new Store(dir).load();
 assert.equal(loaded.messages[0].text,'секретная-лента-xyz');
 assert.equal(loaded.version,3);
});
test('v2 state with inline messages still loads',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({...fresh(),version:2,messages:[{id:'m',author:'Антон',text:'старое'}]}));
 const s=await new Store(dir).load();
 assert.equal(s.messages[0].text,'старое');
 assert.equal(s.version,3);
});
test('a locked snapshot-refs file does not fail the save',{skip:process.platform!=='win32'},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new Store(dir);const s=await store.load();
 const oldSnap=path.join(dir,'snapshots','old');const newSnap=path.join(dir,'snapshots','new');
 s.draft='before';s.turns.push({id:'t',messageId:'m',recipient:'claude',status:'completed',snapshot:oldSnap});
 await store.save(s);
 const refs=path.join(dir,'snapshot-refs.json');
 const reader=await fs.open(refs,'r');
 try {
  s.draft='after';s.diagnostics=[];s.turns[0].snapshot=newSnap;
  await store.save(s);
  assert.equal((await new Store(dir).load()).draft,'after');
  assert.deepEqual(JSON.parse(await fs.readFile(refs,'utf8')).snapshots,[oldSnap]);
  assert.ok(s.diagnostics.some(line=>/snapshot-refs:/.test(line)&&/EPERM/.test(line)));
 } finally {await reader.close();}
 s.diagnostics=[];await store.save(s);
 assert.equal(s.diagnostics.length,0);
 assert.deepEqual(JSON.parse(await fs.readFile(refs,'utf8')).snapshots,[newSnap]);
});
test('a locked state.json still fails the save',{skip:process.platform!=='win32'},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trio-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new Store(dir);const s=await store.load();
 s.draft='before';await store.save(s);
 const reader=await fs.open(path.join(dir,'state.json'),'r');
 try {
  s.draft='after';
  await assert.rejects(store.save(s),{code:'EPERM'});
 } finally {await reader.close();}
 assert.equal((await new Store(dir).load()).draft,'before');
});
test('shortError keeps the file name and drops the long path',()=>{
 const text=shortError("Error: EPERM: operation not permitted, rename 'c:\\\\Users\\\\code\\\\AppData\\\\Roaming\\\\Code\\\\User\\\\globalStorage\\\\trio-local.trio-chat\\\\projects\\\\abc\\\\state.json.tmp' -> 'c:\\\\Users\\\\code\\\\AppData\\\\Roaming\\\\Code\\\\User\\\\globalStorage\\\\trio-local.trio-chat\\\\projects\\\\abc\\\\state.json'");
 assert.match(text,/state\.json/);
 assert.doesNotMatch(text,/globalStorage|AppData/);
 assert.match(text,/Диагностике/);
});
