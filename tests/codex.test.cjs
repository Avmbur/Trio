const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {runProvider,compactProvider,extractCliVersion,parseAgentQuestions}=require('../dist/providers/adapter');
const {CodexUsage,codexApproval}=require('../dist/providers/codexProtocol');
const {permissionClass,permissionSignature,permissionCaption,input,messageText}=require('../dist/shared/model');

async function fixture(t,scenario,overrides={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'trio-codex-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.copyFile(path.join(__dirname,'fake-codex.cjs'),path.join(root,'fake.cjs'));
 const cli=path.join(root,'fake.cmd');await fs.writeFile(cli,'@node "%dp0%/fake.cjs" %*');
 const reports=[],trace=[],asked=[];let compacts=0,activity=0;
 const o={provider:'codex',cli,root,execute:true,prompt:scenario,model:'',effort:'',session:'thread-test',timeout:10000,
   jobRunner:path.resolve('dist/native/JobRunner.exe'),signal:new AbortController().signal,
   onPid:async()=>{},onSession:async()=>{},text:()=>{},progress:()=>{},activity:()=>{activity++;},
   usage:(r,s)=>reports.push({...r,source:s}),trace:s=>{trace.splice(0,trace.length,...s);},
   compacted:()=>{compacts++;},permission:async(title,detail)=>{asked.push({title,detail});return true;},...overrides};
 return {o,reports,trace,asked,compacts:()=>compacts,activity:()=>activity,
   wire:async()=> (await fs.readFile(path.join(root,'wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)};
}
const native={timeout:20000,skip:process.platform!=='win32'};
test('Codex resumes with delta, separates turn spend from occupancy and refreshes quota on the same channel',native,async t=>{
 const f=await fixture(t,'usage'),result=await runProvider(f.o);
 assert.equal(result.error,undefined);assert.equal(result.text,'Готово');
 const usage=f.reports.filter(r=>r.spent!==undefined).at(-1);
 assert.equal(usage.spent,2500);assert.equal(usage.tokens,4300);assert.equal(usage.window,500000);
 assert.match(usage.spentHint,/выход 500/);assert.match(usage.spentHint,/мысли 300 \(уже в выходе\)/);
 assert.equal(f.reports.at(-1).raw.rateLimits.primary.usedPercent,29);
 assert.ok(f.trace.some(s=>s.kind==='thought'));assert.ok(f.trace.some(s=>s.title==='git status'));
 assert.ok(!f.trace.some(s=>s.title==='agentMessage'));assert.ok(f.activity()>0);
 const wire=await f.wire();
 assert.equal(wire.filter(v=>v.method==='initialize').length,1);
 const resume=wire.find(v=>v.method==='thread/resume').params;
 assert.equal(resume.excludeTurns,false);assert.equal(resume.sandbox,'read-only');assert.equal(resume.approvalPolicy,'on-request');
 assert.equal(wire.find(v=>v.method==='turn/start').params.input[0].text,'usage');
 assert.equal(extractCliVersion(f.reports.find(r=>r.source==='handshake').raw),'0.154.0-alpha.6.2');
});
test('Codex stores a new thread only after the first turn is accepted',native,async t=>{
 let accepted=false;
 const f=await fixture(t,'usage',{session:undefined,onSession:async id=>{
  assert.equal(id,'thread-test');
  const wire=await f.wire();
  accepted=wire.some(v=>v.method==='turn/start')&&!wire.some(v=>v.method==='thread/resume');
 }});
 const result=await runProvider(f.o);
 assert.equal(result.error,undefined);
 assert.equal(accepted,true);
});
test('Codex resume still stores the session before the turn',native,async t=>{
 let beforeTurn=false;
 const f=await fixture(t,'usage',{onSession:async()=>{
  const wire=await f.wire();
  beforeTurn=wire.some(v=>v.method==='thread/resume')&&!wire.some(v=>v.method==='turn/start');
 }});
 assert.equal((await runProvider(f.o)).error,undefined);
 assert.equal(beforeTurn,true);
});
test('Codex does not store a thread when the first turn is rejected',native,async t=>{
 let called=false;
 const f=await fixture(t,'start-fail',{session:undefined,onSession:async()=>{called=true;}});
 const result=await runProvider(f.o);
 assert.equal(called,false);
 assert.match(result.error,/turn rejected/);
});
test('Codex missing rollout asks to reset context and keeps the failure out of the answer',native,async t=>{
 let called=false;
 const f=await fixture(t,'usage',{session:'missing',onSession:async()=>{called=true;}});
 const result=await runProvider(f.o);
 assert.equal(called,false);
 assert.equal(result.error,'Сессия Жеки у Codex не найдена, сбросьте ему контекст.');
 assert.match(result.stderr||'',/no rollout found/);
});
test('Codex questions keep ids and comma labels and continue the original turn',native,async t=>{
 const f=await fixture(t,'question',{question:async items=>{
   assert.deepEqual(items.map(q=>q.id),['a','b']);assert.equal(items[0].multi,true);
   return {a:['Да, всё','свой 1','свой 2'],b:['свободный ответ']};
 }});
 const result=await runProvider(f.o);assert.equal(result.error,undefined);assert.equal(result.text,'Готово');
 const wire=await f.wire();assert.deepEqual(wire.find(v=>v.id==='ask').result,{answers:{
   a:{answers:['Да, всё','свой 1','свой 2']},b:{answers:['свободный ответ']}}});
 assert.equal(wire.filter(v=>v.method==='turn/start').length,1);
});
test('Codex cancelled questions return empty answers without fabricating human text',native,async t=>{
 const f=await fixture(t,'cancel-question',{question:async()=>undefined});
 assert.equal((await runProvider(f.o)).error,undefined);
 assert.deepEqual((await f.wire()).find(v=>v.id==='ask').result,{answers:{a:{answers:[]},b:{answers:[]}}});
});
for(const [scenario,cls] of [['edit','edit'],['delete','danger'],['missing','danger'],['command','command']])
 test('Codex approval uses item/started for '+scenario,native,async t=>{
   const f=await fixture(t,scenario);assert.equal((await runProvider(f.o)).error,undefined);
   assert.equal(f.asked.length,1);const {title,detail}=f.asked[0];assert.equal(permissionClass(title,detail),cls);
   if(scenario==='edit'){assert.equal(permissionSignature(title,detail),'tool:applypatch');assert.match(permissionCaption(title,detail),/a.txt/);}
   if(scenario==='command')assert.equal(permissionSignature(title,detail),'cmd:cd+git status');
 });
test('Codex declined action returns a grey-denial result even if CLI ends with error',native,async t=>{
 const f=await fixture(t,'delete',{permission:async()=>false}),result=await runProvider(f.o);
 assert.equal(result.denied,'Удаление файлов');assert.equal(result.error,undefined);
 assert.equal((await f.wire()).find(v=>v.id==='approval').result.decision,'cancel');
});
test('Codex quota failure does not fail an answer and remains in diagnostics',native,async t=>{
 const f=await fixture(t,'quota-error');assert.equal((await runProvider(f.o)).error,undefined);
 assert.match(f.reports.at(-1).raw.error,/Billing unavailable/);
});
test('Codex manual compact waits for completion, not request acknowledgement',native,async t=>{
 const f=await fixture(t,'');await compactProvider(f.o);
 assert.ok((await f.wire()).some(v=>v.compactionDone));
});
test('Codex native compaction event resets the delta cursor once',native,async t=>{
 const f=await fixture(t,'compact');await runProvider(f.o);assert.equal(f.compacts(),1);
});
test('Codex Stop keeps partial output and terminates a running tool',native,async t=>{
 const abort=new AbortController();let progressed;
 const ready=new Promise(r=>progressed=r);
 const f=await fixture(t,'stop',{signal:abort.signal,progress:s=>{if(s==='long-test')progressed();}});
 const work=runProvider(f.o);await ready;abort.abort();const result=await work;
 assert.equal(result.interrupted,true);assert.equal(result.error,undefined);assert.equal(result.text,'Го');
});
test('legacy answers stay readable, array payloads are bounded and do not split commas',()=>{
 assert.ok(input({type:'answer',requestId:'r',answers:{q:['a, b','c']}}));
 assert.equal(input({type:'answer',requestId:'r',answers:{q:[{}]}}),undefined);
 assert.equal(input({type:'answer',requestId:'r',answers:{q:Array(33).fill('a')}}),undefined);
 assert.match(messageText({text:'Вопрос',question:{id:'r',items:[{id:'q',prompt:'Выбор?',options:[]}],answered:{q:['a, b','c']}}}),/Ответ Антона на «Выбор\?»: a, b, c/);
 assert.deepEqual(parseAgentQuestions({questions:[{id:'a',question:'Q',options:null}]})[0],{prompt:'Q',options:[],multi:false});
});

test('Codex shell wrappers classify and grant the inner chain, never powershell in general',()=>{
 const request=command=>codexApproval('item/commandExecution/requestApproval',{command});
 for(const shell of ['powershell.exe -NoProfile -Command "cd C:/projects/trio; git status"',
   '"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" -Command "cd C:/projects/trio; git status"',
   'bash -lc "cd /tmp && git status"','cmd.exe /d /c "cd C:/projects/trio && git status"']){
   const r=request(shell);assert.equal(permissionClass(r.title,r.detail),'command');
   assert.equal(permissionSignature(r.title,r.detail),'cmd:cd+git status');
 }
 for(const command of ['powershell.exe -Command "Remove-Item a.txt"','powershell.exe -EncodedCommand YQ==',
   'bash -lc "rm a.txt"']){
   const r=request(command);assert.equal(permissionClass(r.title,r.detail),'danger');
 }
 assert.equal(extractCliVersion({userAgent:'trio_check/0.154.0-alpha.6.2 (Windows 10.0.19045; x86_64) dumb (trio_check; 0.1.0)'}),'0.154.0-alpha.6.2');
});

// Regression for Anton's live test: the question was plain text, with no modal.
for(const scenario of ['async-active','async-late','async-race'])
 test('Codex async question opens once and returns distinct selections: '+scenario,native,async t=>{
   let asked=0,completed;const ended=new Promise(resolve=>completed=resolve);
   const f=await fixture(t,scenario,{question:async items=>{
     asked++;
     assert.deepEqual(items.map(q=>q.id),['async-question:0','async-question:1']);
     assert.equal(items[0].prompt,'Какие элементы оставить в панели Trio?');
     assert.equal(items[0].multi,true);
     assert.equal(items[0].allowMultiple,undefined);
     assert.deepEqual(items[0].options.map(o=>o.label),['Очередь, включая следующие циклы','Расход токенов, включая выход']);
     if(scenario==='async-late')await ended;
     return {'async-question:0':['Очередь, включая следующие циклы','Расход токенов, включая выход','свой, первый','свой второй'],
       'async-question:1':['отдельный ответ']};
   }});
   const usage=f.o.usage;f.o.usage=(report,source)=>{usage(report,source);if(source==='turn/completed')completed();};
   const result=await runProvider(f.o);
   assert.equal(asked,1);assert.equal(result.error,undefined);assert.match(result.text,/Готово/);
   assert.match(result.text,/Заметка/);assert.doesNotMatch(result.text,/Какие элементы|DUPLICATE/);
   const wire=await f.wire(),steer=wire.filter(v=>v.method==='turn/steer');
   const starts=wire.filter(v=>v.method==='turn/start');
   assert.equal(starts.length,scenario==='async-active'?1:2);
   assert.equal(steer.length,scenario==='async-late'?0:1);
   if(steer.length)assert.equal(steer[0].params.expectedTurnId,'turn-test');
   const answer=(scenario==='async-active'?steer[0]:starts[1]).params;
   assert.equal(answer.threadId,'thread-test');
   const lines=answer.input[0].text.split('\n');
   assert.deepEqual(lines.filter(l=>l.startsWith('[')).map(JSON.parse),[
     ['Очередь, включая следующие циклы','Расход токенов, включая выход','свой, первый','свой второй'],['отдельный ответ']]);
   assert.equal(wire.filter(v=>v.method==='initialize').length,1);
   assert.equal(wire.filter(v=>v.method==='thread/resume').length,1);
 });
test('Codex dismisses async question without inventing an answer',native,async t=>{
 const f=await fixture(t,'async-cancel',{question:async()=>undefined});
 assert.equal((await runProvider(f.o)).error,undefined);
 const wire=await f.wire();assert.equal(wire.filter(v=>v.method==='turn/start').length,1);
 assert.match(wire.find(v=>v.method==='turn/steer').params.input[0].text,/закрыл вопрос без ответа/);
});
for(const scenario of ['async-stop','async-close','async-fail'])
 test('Codex removes pending async modal after '+scenario,native,async t=>{
   const abort=new AbortController();let asked=0,cancelled=0;
   const f=await fixture(t,scenario,{signal:abort.signal,question:(_items,signal)=>new Promise(resolve=>{
     asked++;signal.addEventListener('abort',()=>{cancelled++;resolve(undefined);},{once:true});
     if(scenario==='async-stop')abort.abort();
   })});
   const result=await runProvider(f.o);assert.equal(asked,1);assert.equal(cancelled,1);
   if(scenario==='async-stop'){assert.equal(result.interrupted,true);assert.equal(result.error,undefined);}
   else assert.match(result.error,scenario==='async-fail'?/denied/:/9/);
   const wire=await f.wire();assert.equal(wire.filter(v=>v.method==='turn/start').length,1);
   assert.equal(wire.filter(v=>v.method==='turn/steer').length,0);
 });
test('Codex failed async answer delivery fails visibly without a duplicate turn',native,async t=>{
 const f=await fixture(t,'async-steer-error',{question:async()=>({'async-question:0':['Да']})});
 const result=await runProvider(f.o);assert.match(result.error,/Steer unavailable/);
 const wire=await f.wire();assert.equal(wire.filter(v=>v.method==='turn/start').length,1);
 assert.equal(wire.filter(v=>v.method==='turn/steer').length,1);
});

test('question mode is fixed before display: async defaults to checkboxes, explicit single stays radio',()=>{
 const parse=(extra={},byId=true,multi=false)=>parseAgentQuestions({questions:[{id:'q',question:'Выбор',options:['a','b'],...extra}]},byId,multi)[0];
 assert.equal(parse({},true,true).multi,true);
 assert.equal(parse().multi,false);
 for(const flag of ['multiSelect','multi_select','multi']) {
  assert.equal(parse({[flag]:false},true,true).multi,false);
  assert.equal(parse({[flag]:true},false,false).multi,true);
 }
 assert.equal('allowMultiple' in parse({},true,true),false);
});

test('Codex decodes escaped PowerShell scripts before classifying here-string payloads',()=>{
 const scripts=[
  "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$layout = @'\nconst fs=require('fs');\nconst q = $('question-body');\nconst text = \"don't split these quotes\";\nfs.writeFileSync('webview/example.txt',text);\n'@\n$layout | node",
  "$layout = @'\nconst q = $('question-actions');\nconst text = \"Remove-Item; git commit\";\n'@\n$layout | node"
 ];
 for(const body of scripts){
  const command='powershell.exe -Command '+ "'" +body.replaceAll("'", "'\"'\"'")+ "'";
  const r=codexApproval('item/commandExecution/requestApproval',{command});
  const detail=JSON.parse(r.detail);
  assert.equal(detail.command,body);
  assert.equal(detail.shell,'powershell');
  assert.equal(permissionClass(r.title,r.detail),'command');
  assert.equal(permissionSignature(r.title,r.detail),undefined,'script is not a blanket shell grant');
 }
});
test('Codex quoted wrapper never ignores dangerous trailing commands or uses a policy prefix as the body',()=>{
 const request=command=>codexApproval('item/commandExecution/requestApproval',{
  command,proposedExecpolicyAmendment:['powershell.exe','-Command','git status']});
 const bodies=[
  "git status\nRemove-Item -LiteralPath a.txt",
  "$payload = @'\nconsole.log('read only');\n'@\nRemove-Item a.txt",
  "git status\ngit commit -m 'change'",
  "$payload = @'\nconsole.log('read only');\n'@\ngit push",
  "$payload = @'\nunterminated literal",
  '$payload = @"\n$(Remove-Item a.txt)\n"@\nWrite-Output $payload',
  'Write-Output $(Remove-Item a.txt)'
 ];
 for(const body of bodies){
  const r=request("powershell.exe -Command '"+body.replaceAll("'","'\"'\"'")+"'");
  assert.equal(permissionClass(r.title,r.detail),'danger',body);
 }
 for(const command of ['powershell.exe -Command "git status"; Remove-Item a.txt',
   'powershell.exe -Command "git status" "Remove-Item a.txt"',
   'powershell.exe -Command "unterminated',
   'powershell.exe -EncodedCommand YQ==']){
  const r=request(command);assert.equal(permissionClass(r.title,r.detail),'danger',command);
 }
});
test('Codex shell heredoc substitutions still require approval',()=>{
 const r=codexApproval('item/commandExecution/requestApproval',{command:"bash -lc 'cat <<EOF\n$(rm a.txt)\nEOF'"});
 assert.equal(permissionClass(r.title,r.detail),'danger');
});
test('Codex escaped nested wrappers preserve inner command chains',()=>{
 const command="powershell.exe -Command 'cmd.exe /d /c \"cd C:/projects/trio && git status\"'";
 const r=codexApproval('item/commandExecution/requestApproval',{command});
 assert.equal(permissionClass(r.title,r.detail),'command');
 assert.equal(permissionSignature(r.title,r.detail),'cmd:cd+git status');
});
