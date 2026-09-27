const readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const args=process.argv.slice(2);
if(args[0]==='auth'){
  console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',
    plan:'Pro',fiveHour:{usedPercent:12,resetsAt:'16:00'}},null,2));
}else if(args[0]==='usage'){
  process.stdout.write(JSON.stringify({sessionId:args[1],updatedAt:'2026-01-01T00:00:00Z',
    session:{totalTokens:183065,inputTokens:180000,outputTokens:3065,limit:500000},turns:[{totalTokens:183065}]}));
}else{
 const rl=readline.createInterface({input:process.stdin});
 let promptId;
 rl.on('line',line=>{
  const v=JSON.parse(line);
  if(args[0]==='agent'){
   const result=x=>send({jsonrpc:'2.0',id:v.id,result:x});
   switch(v.method){
    case 'initialize':result({protocolVersion:1,authMethods:[{id:'cached_token'},{id:'grok.com'}],
     _meta:{defaultAuthMethodId:'cached_token',modelState:{currentModelId:'fake-4',availableModels:[{modelId:'fake-4',name:'Fake',totalContextTokens:500000}]}}});break;
    case 'session/new':result({sessionId:'grok-session'});break;
    case 'session/load':result({});break;
    case 'session/cancel':result({});break;
    case 'session/set_config_option':
     if(typeof v.params.value!=='string')send({jsonrpc:'2.0',id:v.id,error:{code:-32602,message:'Invalid params'}});
     else result({configOptions:[{id:v.params.configId,currentValue:v.params.value}]});
     break;
    case '_x.ai/billing':
    case 'x.ai/billing':
     result({config:{creditUsagePercent:17,currentPeriod:{type:'USAGE_PERIOD_TYPE_FIVE_HOUR',end:'2026-09-14T16:00:00Z'}}});
     break;
    case 'session/prompt':
     promptId=v.id;
     send({jsonrpc:'2.0',method:'x.ai/session_notification',params:{sessionId:'grok-session',type:'auto_compact'}});
     send({jsonrpc:'2.0',method:'x.ai/session/update',params:{sessionId:'grok-session',update:{sessionUpdate:'auto_compact_start'}}});
     send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'grok-session',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Сначала сверю код.'}}}});
     send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'grok-session',update:{sessionUpdate:'tool_call',toolCallId:'t1',title:'Read adapter.ts',kind:'read',status:'in_progress'}}});
     send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'grok-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Начало '}}}});
     send({jsonrpc:'2.0',id:'approval',method:'session/request_permission',params:{sessionId:'grok-session',
      toolCall:{title:'fake-test',kind:'execute'},
      options:[{optionId:'yes',kind:'allow_once',name:'Allow'},{optionId:'no',kind:'reject_once',name:'Reject'}]}});
     break;
    default:
     if(v.id!=null&&v.id!=='approval')send({jsonrpc:'2.0',id:v.id,error:{code:-32601,message:'Method not found'}});
   }
   if(v.id==='approval'&&v.result){
    const text=v.result.outcome?.optionId==='yes'?'готово':'отказ';
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'grok-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
    send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn',_meta:{totalTokens:120000,usage:{totalTokens:545449,modelCalls:3}}}});
   }
  }else if(args[0]==='app-server'){
   const result=x=>send({id:v.id,result:x});
   switch(v.method){
    case 'initialize':result({userAgent:'fake'});break;
    case 'account/read':result({account:{type:'chatgpt'}});break;
    case 'account/rateLimits/read':result({rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:1893456000}},
      rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:1893456000}}}});break;
    case 'account/usage/read':result({totals:{inputTokens:1000}});break;
    case 'thread/start':case 'thread/resume':result({thread:{id:'thread-test'}});break;
    case 'turn/start':
     result({turn:{id:'turn-test'}});
     send({method:'thread/compact/completed',params:{threadId:'thread-test',reason:'auto'}});
     send({method:'item/agentMessage/delta',params:{threadId:'thread-test',itemId:'answer',delta:'Начало '}});
     send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread-test',command:'fake-test'}});
     break;
   }
   if(v.id==='approval'&&v.result){
    const text=v.result.decision==='accept'?'Начало готово':'Начало отказ';
    send({method:'item/completed',params:{threadId:'thread-test',item:{id:'answer',type:'agentMessage',text}}});
    send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed',
     usage:{tokens_used:120000,model_context_window:500000}}}});
   }
  }else{
   if(v.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:{commands:[]}}});
   if(v.type==='user'){
    send({type:'system',subtype:'init',session_id:'claude-session'});
    send({type:'system',subtype:'compact_boundary',session_id:'claude-session'});
    send({type:'stream_event',event:{type:'message_start',message:{id:'m'}}});
    send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Начало '}}});
    send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'fake-test'}}});
   }
   if(v.type==='control_response'&&v.response.request_id==='permission'){
    const text=v.response.response.behavior==='allow'?'Начало готово':'Начало отказ';
    send({type:'assistant',message:{id:'m',content:[{type:'text',text}]}});
    // Live shape: the top-level usage sums the whole turn and repeats itself in iterations.
    // Occupancy is the last iteration alone; totals here are deliberately much larger.
    send({type:'result',result:text,is_error:false,
     usage:{input_tokens:8,cache_creation_input_tokens:12000,cache_read_input_tokens:300000,output_tokens:1500,
      iterations:[{input_tokens:4,cache_read_input_tokens:180000,cache_creation_input_tokens:7000,output_tokens:500},
       {input_tokens:4,cache_read_input_tokens:114000,cache_creation_input_tokens:5000,output_tokens:996}]},
     modelUsage:{'fake-4':{contextWindow:500000}}});
   }
  }
 });
}
