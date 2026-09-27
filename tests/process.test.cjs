const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {Channel} = require('../dist/processes/channel');
const {alive} = require('../dist/processes/lock');
const jobRunner = path.resolve('dist/native/JobRunner.exe');
test('Windows job transports Unicode and kills the whole descendant tree', {timeout: 15000, skip: process.platform !== 'win32'}, async () => {
  let receive, pid;
  const ready = new Promise(r => receive = r);
  const childCode = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); console.log(JSON.stringify({pid:child.pid,arg:process.argv[1]})); setInterval(()=>{},1000)";
  const marker = 'Привет "quoted" C:\\some path\\';
  const channel = new Channel({launch:{file:process.execPath,args:[]}, args:['-e',childCode,marker],
    cwd:process.cwd(),jobRunner,signal:new AbortController().signal,onPid:async value=>{pid=value;},onMessage:receive});
  channel.onClose=e=>receive({error:e.message});
  try {
    await channel.open();const value=await ready;
    assert.equal(value.error,undefined);assert.equal(value.arg,marker);
    assert.ok(alive(value.pid));assert.ok(alive(pid));
    await channel.close();
    for(let attempt=0;attempt<30&&alive(value.pid);attempt++)await new Promise(r=>setTimeout(r,50));
    assert.equal(alive(value.pid),false);assert.equal(alive(pid),false);
  } finally {await channel.close();}
});
test('aborted before open never spawns',async()=>{
 const abort=new AbortController();abort.abort();let spawned=false;
 const channel=new Channel({launch:{file:process.execPath,args:[]},args:[],cwd:process.cwd(),jobRunner,
   signal:abort.signal,onPid:async()=>{spawned=true;},onMessage:()=>{}});
 await assert.rejects(channel.open(),/отменён/);assert.equal(spawned,false);
});
