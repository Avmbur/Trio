// Protocol peer, no model calls. Shapes from the installed app-server schema.
const fs=require('node:fs'),readline=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
const record=v=>fs.appendFileSync('wire.jsonl',JSON.stringify(v)+'\n');
const threadId='thread-test';let turnId='turn-test';
const notify=(method,p={})=>send({method,params:{threadId,turnId,...p}});
const total=(input,cached,output,reason)=>({totalTokens:input+output,inputTokens:input,cachedInputTokens:cached,outputTokens:output,reasoningOutputTokens:reason});
const baseline=total(10000,8000,1000,600);
const usage=(all,last)=>notify('thread/tokenUsage/updated',{tokenUsage:{total:all,last,modelContextWindow:500000}});
let scenario='';
function finish(status='completed') {
 notify('item/completed',{item:{id:'answer',type:'agentMessage',text:'Готово'}});
 notify('turn/completed',{turn:{id:turnId,status,...(status==='failed'?{error:{message:'denied'}}:{})}});
}
readline.createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);record(v);
 const result=x=>send({id:v.id,result:x});
 switch(v.method) {
 case 'initialize':result({userAgent:'trio/0.154.0-alpha.6.2 (Windows 10; x86_64)'});break;
 case 'account/read':result({account:{type:'chatgpt'}});break;
 case 'thread/resume':usage(baseline,total(9000,7000,500,300));result({thread:{id:threadId}});break;
 case 'thread/start':result({thread:{id:threadId}});break;
 case 'account/rateLimits/read':
   if(scenario==='quota-error')send({id:v.id,error:{code:-1,message:'Billing unavailable'}});
   else result({rateLimits:{primary:{usedPercent:29,windowDurationMins:300,resetsAt:1893456000}}});
   break;
 case 'thread/compact/start':
   result({});setTimeout(()=>{record({compactionDone:true});notify('thread/compacted');},80);break;
 case 'turn/steer':
   if(scenario==='async-steer-error')send({id:v.id,error:{code:-1,message:'Steer unavailable'}});
   else if(scenario==='async-race'){
     notify('turn/completed',{turn:{id:turnId,status:'completed'}});
     send({id:v.id,error:{code:-1,message:'No active turn'}});
   }else{result({turnId});finish();}
   break;
 case 'turn/start':
   if(scenario.startsWith('async') && !v.params.input[0].text.startsWith('async')){
     turnId='turn-answer';result({turn:{id:turnId}});finish();break;
   }
   scenario=v.params.input[0].text;result({turn:{id:turnId}});
   notify('item/started',{item:{id:'answer',type:'agentMessage'}});
   notify('item/agentMessage/delta',{itemId:'answer',delta:'Го'});
   if(scenario.startsWith('async')) {
     // Real request_user_input_async shape: completed agentMessage, no started item
     // and no item/tool/requestUserInput RPC. Re-delivery must not ask twice.
     const item={type:'agentMessage',id:'async-question',phase:'final_answer',delivery:'async',
       text:'Какие элементы оставить в панели Trio?\n- Очередь, включая следующие циклы\n- Расход токенов, включая выход',
       questions:[{title:'Какие элементы оставить в панели Trio?',options:['Очередь, включая следующие циклы','Расход токенов, включая выход']},
         {title:'Какие элементы оставить в панели Trio?',options:null}]};
     notify('item/completed',{threadId:'other',item:{...item,id:'wrong-thread'}});
     notify('item/completed',{turnId:'old-turn',item:{...item,id:'wrong-turn'}});
     notify('item/completed',{item});notify('item/completed',{item});
     notify('item/agentMessage/delta',{itemId:item.id,delta:'DUPLICATE'});
     // Async messages without questions remain regular output.
     notify('item/completed',{item:{type:'agentMessage',id:'note',text:'Заметка',delivery:'async',questions:null}});
     if(scenario==='async-late')notify('turn/completed',{turn:{id:turnId,status:'completed'}});
     if(scenario==='async-fail')setTimeout(()=>finish('failed'),50);
     if(scenario==='async-close')setTimeout(()=>process.exit(9),50);
   } else if(scenario==='question' || scenario==='cancel-question') {
     send({id:'ask',method:'item/tool/requestUserInput',params:{threadId,turnId,itemId:'tool',questions:[
       {id:'a',header:'A',question:'Одинаковый текст?',options:[{label:'Да, всё'}],multiSelect:true},
       {id:'b',header:'B',question:'Одинаковый текст?',options:null}
     ]}});
   } else if(['delete','edit','missing','command'].includes(scenario)) {
     const item=scenario==='command'?{id:'tool',type:'commandExecution',command:'cd C:/projects/trio && git status'}:
       {id:'tool',type:'fileChange',changes:[{path:'a.txt',kind:{type:'update',move_path:null},diff:'-a\n+b'},
         {path:'b.txt',kind:{type:scenario==='delete'?'delete':'add'},diff:'-x'}]};
     if(scenario!=='missing')notify('item/started',{item});
     send({id:'approval',method:scenario==='command'?'item/commandExecution/requestApproval':'item/fileChange/requestApproval',params:{threadId,turnId,itemId:'tool'}});
   } else if(scenario==='stop') {
     notify('item/started',{item:{id:'tool',type:'commandExecution',command:'long-test'}});
     setInterval(()=>notify('item/commandExecution/outputDelta',{itemId:'tool',delta:'.'}),30);
   } else {
     notify('item/started',{item:{id:'reason',type:'reasoning'}});
     notify('item/reasoning/summaryTextDelta',{itemId:'reason',delta:'Проверяю факты'});
     notify('item/started',{item:{id:'tool',type:'commandExecution',command:'git status'}});
     notify('item/commandExecution/outputDelta',{itemId:'tool',delta:'clean'});
     const first=total(12000,9500,1200,700),last=total(2000,1500,200,100);
     usage(first,last);usage(first,last);
     usage(total(16000,12000,1500,900),total(4000,2500,300,200));
     // Other sessions never change this turn's report or text.
     send({method:'item/agentMessage/delta',params:{threadId:'other',itemId:'x',delta:'WRONG'}});
     notify('item/completed',{item:{id:'tool',type:'commandExecution',command:'git status'}});
     if(scenario==='compact')notify('thread/compacted');
     finish();
   }
   break;
 }
 if(v.id==='ask'&&v.result)finish();
 if(v.id==='approval'&&v.result)finish(v.result.decision==='accept'?'completed':'failed');
});
