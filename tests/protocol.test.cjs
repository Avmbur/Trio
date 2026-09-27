const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {Rpc}=require('../dist/processes/channel');
const {requireSubscription,requireGrokSubscription,subscriptionEnvironment,runProvider}=require('../dist/providers/adapter');
test('RPC correlates interleaved replies and rejects pending work on process exit',async()=>{
 const writes=[],channel={write:v=>writes.push(v),closed:false,onClose:()=>{}};
 const rpc=new Rpc(channel);
 const a=rpc.request('first'),b=rpc.request('second');
 rpc.receive({id:writes[1].id,result:{ok:2}},()=>{},async()=>{});
 rpc.receive({id:writes[0].id,result:{ok:1}},()=>{},async()=>{});
 assert.deepEqual(await a,{ok:1});assert.deepEqual(await b,{ok:2});
 const c=rpc.request('third');channel.onClose(new Error('exited'));await assert.rejects(c,/exited/);
});
test('unknown server requests fail explicitly rather than receiving automatic approval',async()=>{
 const writes=[],channel={write:v=>writes.push(v),closed:false,onClose:()=>{}};
 const rpc=new Rpc(channel);
 rpc.receive({id:7,method:'unsupported'},()=>{},async()=>{throw new Error('unsupported');});
 await new Promise(r=>setImmediate(r));assert.equal(writes[0].error.code,-32601);
});
test('subscription gate excludes API auth; copied environment strips API overrides',()=>{
 requireSubscription({type:'chatgpt'},'codex');
 requireSubscription({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'},'claude');
 for(const value of [{type:'apiKey'},{type:'amazonBedrock'},null])assert.throws(()=>requireSubscription(value,'codex'));
 assert.throws(()=>requireSubscription({loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'},'claude'));
 const original={PATH:'path',OPENAI_API_KEY:'secret',ANTHROPIC_BASE_URL:'custom',USERPROFILE:'home'};
 const env=subscriptionEnvironment(original);assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.ANTHROPIC_BASE_URL,undefined);assert.equal(env.USERPROFILE,'home');assert.equal(original.OPENAI_API_KEY,'secret');
});
test('Grok subscription gate requires a cached login and rejects API or missing auth',()=>{
 requireGrokSubscription({authMethods:[{id:'cached_token'},{id:'grok.com'}],_meta:{defaultAuthMethodId:'cached_token'}});
 for(const value of [{authMethods:[{id:'grok.com'}],_meta:{defaultAuthMethodId:'grok.com'}},
  {authMethods:[{id:'cached_token'}],_meta:{defaultAuthMethodId:'grok.com'}},{authMethods:[]},{},null])
  assert.throws(()=>requireGrokSubscription(value),/grok login/);
 assert.equal(subscriptionEnvironment({XAI_API_KEY:'secret',GROK_API_KEY:'secret'}).XAI_API_KEY,undefined);
});
test('Grok discuss mode denies every tool request without asking Anton',{timeout:20000,skip:process.platform!=='win32'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'trio-grok-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.copyFile(path.join(__dirname,'fake-engine.cjs'),path.join(root,'fake.cjs'));
 const cli=path.join(root,'fake.cmd');await fs.writeFile(cli,'@node "%dp0%/fake.cjs" %*');
 let asked=0;
 const result=await runProvider({provider:'grok',cli,root,execute:false,prompt:'test',model:'grok-4.6',effort:'xhigh',
  jobRunner:path.resolve('dist/native/JobRunner.exe'),timeout:15000,signal:new AbortController().signal,
  onPid:async()=>{},onSession:async()=>{},text:()=>{},progress:()=>{},
  permission:async()=>{asked++;return true;}});
 assert.equal(asked,0);assert.equal(result.text,'Начало отказ');assert.equal(result.error,undefined);
});
