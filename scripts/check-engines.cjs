// Local protocol handshakes only: no user prompts and no model calls.
const {Channel,Rpc}=require('../dist/processes/channel');
const {subscriptionEnvironment}=require('../dist/providers/adapter');
const path=require('node:path');
const provider=process.argv[2],file=process.argv[3];
if(!['codex','claude'].includes(provider)||!file)throw new Error('Usage: node scripts/check-engines.cjs codex|claude <official exe>');
(async()=>{
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),60000);
 let rpc,complete,fail;
 const response=new Promise((resolve,reject)=>{complete=resolve;fail=reject;});void response.catch(()=>{});
 const channel=new Channel({launch:{file,args:[]},
   args:provider==='codex'?['app-server','--listen','stdio://']:['--print','--verbose','--input-format','stream-json','--output-format','stream-json','--permission-prompt-tool','stdio'],
   cwd:process.cwd(),jobRunner:path.resolve(__dirname,'../dist/native/JobRunner.exe'),signal:abort.signal,
   env:subscriptionEnvironment(process.env),onPid:async()=>{},
   onMessage:value=>{
    if(provider==='codex')rpc.receive(value,()=>{},async()=>{throw new Error('Unexpected server request during handshake');});
    else if(value.type==='control_response'&&value.response?.request_id==='check'){
      if(value.response.subtype==='error')fail(new Error(value.response.error));else complete(value.response.response);
    }
   }});
 if(provider==='codex')rpc=new Rpc(channel);else channel.onClose=fail;
 try{
  await channel.open();
  if(provider==='codex'){
    const result=await rpc.request('initialize',{clientInfo:{name:'trio_check',version:'0.1.0'},capabilities:{}});
    rpc.notify('initialized');
    console.log('Codex initialize: OK; response fields: '+Object.keys(result).join(', '));
    console.log('Codex userAgent: '+String(result.userAgent));
  }else{
    channel.write({type:'control_request',request_id:'check',request:{subtype:'initialize'}});
    const result=await response;
    console.log('Claude initialize: OK; response fields: '+Object.keys(result||{}).join(', '));
  }
 }finally{clearTimeout(timer);await channel.close();}
})().catch(e=>{console.error(String(e));process.exitCode=1;});
