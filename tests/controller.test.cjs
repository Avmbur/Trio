const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {Controller} = require('../dist/orchestrator/controller');
const {Store} = require('../dist/storage/store');
const {fresh, addressed, assignedMode, input, riskyPermission, permissionClass, permissionSignature, permissionCaption, diskImagePath, plainAttachment, context, contextFit, questionNumber, messageText, agentPromptPrefix, instructionLimit, normalizeInstruction} = require('../dist/shared/model');
const {brief} = require('../dist/orchestrator/controller');
test('a tool title never reaches the feed as a wall of script',()=>{
  const script='node -e "'+'const x=1; '.repeat(200)+'"';
  const label=brief(script);
  assert.ok(label.length<=60,'метка короткая');
  assert.equal(label.includes('\n'),false);
  assert.match(label,/^node -e/,'начало команды видно');
  assert.equal(brief('Bash'),'Bash','короткий заголовок не трогается');
  assert.equal(brief('Изменение   файлов\nв проекте'),'Изменение файлов в проекте');
});

async function fixture(t, custom) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trio-test-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const store = new Store(path.join(root,'state')); await store.load();
  const runs = [], state = fresh();
  const compacted = [];
  const notes=[];
  const host = {root, lockBase:path.join(root,'locks'), jobRunner:'unused', cli:async p=>p,
    limit:()=>64000, timeout:()=>10000, ceiling:()=>3600000, notify:(k,t)=>notes.push(k+':'+t),
    changed:()=>{}, trusted:()=>true, prepare:async()=>path.join(root,'snapshot'),
    compact:async o=>{compacted.push(o);}};
  host.compacted = compacted;
  const c = new Controller(state,store,host,async o => {
    runs.push(o);
    if(custom)return custom(o);
    o.text('Ответ ' + o.provider);
    return {text:'Ответ '+o.provider,interrupted:false};
  });
  host.notes = notes;
  return {c,state,runs,store,host,compacted,notes};
}
const withSession = async o => {await o.onSession('session-'+o.provider); return {text:'Ответ '+o.provider,interrupted:false};};
test('compact reaches only enabled participants with a session and never touches the feed history', async t => {
  const {c,state,compacted} = await fixture(t, withSession);
  await assert.rejects(c.compact(), /ещё нет сессии/);
  await c.send('Колян, посмотри проект','claude'); await c.idle();
  const before = state.messages.filter(m => m.author === 'Антон' || m.author === 'Колян').length;
  await c.compact('codex').catch(e => {assert.match(String(e),/ещё нет сессии/);});
  assert.deepEqual(compacted.map(x=>x.provider),[]);
  state.usage.claude={tokens:120000,window:500000,source:'result',at:1};
  await c.compact('claude');
  assert.deepEqual(compacted.map(x=>x.provider),['claude']);
  assert.equal(state.messages.filter(m => m.author === 'Антон' || m.author === 'Колян').length, before);
  assert.ok(state.messages.at(-1).text.includes('контекст сжат движком'));
  assert.equal(state.usage.claude.tokens,undefined);
  assert.equal(state.usage.claude.window,500000);
  assert.equal(c.busy,false);
});
test('compact refuses while an agent works and a failure is reported without stopping the rest', async t => {
  const {c,state,host} = await fixture(t, withSession);
  await c.send('Колян, посмотри проект','claude'); await c.idle();
  await c.send('Жека, посмотри проект','codex'); await c.idle();
  host.compact = async o => {if (o.provider === 'claude') throw new Error('движок отказал'); };
  await c.compact();
  assert.ok(state.messages.some(m => m.error && m.text.includes('движок отказал')));
  assert.ok(state.messages.some(m => m.text.includes('Жека: контекст сжат движком')));
});
test('all requires a human to choose first; completion never starts another agent', async t => {
  const {c,state,runs} = await fixture(t);
  await c.send('Обсудим проект','all'); assert.equal(runs.length,0);
  const turnId=state.queue[0]; await c.handoff('claude',turnId); await c.idle();
  assert.deepEqual(runs.map(r=>r.provider),['claude']);
  await c.send('прочитал','all'); await c.idle(); assert.equal(runs.length,1);
  await c.handoff('codex'); await c.idle();
  assert.deepEqual(runs.map(r=>r.provider),['claude','codex']);
  assert.match(runs[1].prompt,/Ответ claude/);
  assert.deepEqual(state.messages.filter(m=>m.author==='Антон').map(m=>m.text),['Обсудим проект','прочитал']);
  assert.ok(runs[1].prompt.endsWith('Обсудим проект'));
  assert.doesNotMatch(runs[1].prompt,/тебе слово|отвечай на выбранное/);
});
test('busy sends queue; stop keeps partial output and does not release queue', async t => {
  let started; const ready=new Promise(r=>started=r);
  const {c,state,runs}=await fixture(t,async o=>{
    o.text('Успел прочитать файл'); started();
    await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));
    return {text:'Успел прочитать файл',interrupted:true};
  });
  await c.send('Жека, посмотри проект','all'); await ready;
  await c.send('Колян, объясни результат','all');
  await c.stop('claude'); assert.equal(c.busy,true);
  await c.send('Жека, стоп','all');
  assert.equal(c.busy,false); assert.equal(runs.length,1); assert.equal(state.queue.length,1);
  const reply=state.messages.find(m=>m.author==='Жека');
  assert.equal(reply.text,'Успел прочитать файл'); assert.equal(reply.partial,true);
  assert.equal(state.turns[0].status,'interrupted');
});
test('rapid sends and duplicate handoffs cannot race past the reservation',async t=>{
  const {c,state,runs}=await fixture(t);
  await Promise.all([c.send('первое','codex'),c.send('второе','claude')]); await c.idle();
  assert.equal(runs.length,1); assert.equal(state.queue.length,1);
  const id=state.queue[0];
  const results=await Promise.allSettled([c.handoff('claude',id),c.handoff('claude',id)]);
  assert.equal(results.filter(x=>x.status==='rejected').length,1);
  await c.idle();assert.equal(runs.length,2);
});
test('one participant runs addressed-all directly; three are representable',async t=>{
  const {c,state,runs}=await fixture(t);
  await c.configure({...state.agents[1],enabled:false});
  await c.send('объясни проект','all');await c.idle();assert.equal(runs[0].provider,'claude');
  await assert.rejects(c.configure({...state.agents[0],enabled:false}),/хотя бы/);
  await c.configure({...state.agents[1],enabled:true});await c.configure({...state.agents[2],enabled:true});
  await c.send('вопрос всем','all');assert.equal(runs.length,1);assert.equal(state.agents.filter(a=>a.enabled).length,3);
});
test('executor assigned in chat; explicit action snapshots once before invoking',async t=>{
  const {c,runs,host,state}=await fixture(t);let snapshots=0;
  host.prepare=async()=>{snapshots++;return 'snapshot';};
  await c.send('Колян, исправь README','all');await c.idle();
  assert.equal(runs[0].provider,'claude');assert.equal(runs[0].execute,true);assert.equal(snapshots,1);
  assert.equal(state.turns[0].snapshot,'snapshot');
  assert.equal(addressed('Пример: «Колян, делай»'),undefined);
  assert.equal(assignedMode('Что значит «делай»?', 'discuss'),'discuss');
  assert.equal(assignedMode('Колян, исправь файл. обсуждаем, код не трогать','execute'),'discuss');
  assert.equal(riskyPermission('Read spec.md'),false);
  assert.equal(riskyPermission('Grep','{"pattern":"foo"}'),false);
  assert.equal(riskyPermission('Bash','{"command":"rm -rf"}'),true);
  assert.equal(riskyPermission('Edit `webview/main.css`'),true);
  assert.equal(riskyPermission('Выполнение команды'),true);
  assert.equal(riskyPermission('правка main.css'),true);
  assert.equal(permissionClass('Editing package.json', JSON.stringify({kind:'edit',rawInput:{content:'run bash and delete network'}})),'edit');
  assert.equal(permissionClass('Действие агента', JSON.stringify({kind:'execute',title:'fake-test'})),'command');
  assert.equal(permissionClass('Execute tsc', JSON.stringify({kind:'execute',rawInput:{command:'node --test tests'}})),'command');
  assert.equal(permissionClass("Execute git", JSON.stringify({kind:'execute',rawInput:{command:"git add x && git commit -m 'm'"}})),'danger');
  assert.equal(permissionClass('Read file', JSON.stringify({kind:'read',rawInput:{path:'src/shell.ts'}})),'read');
});
test('permissionSignature names the tool or the first command, and ssh keeps the host',()=>{
 assert.equal(permissionSignature('Read spec.md','{}'),'tool:read');
 assert.equal(permissionSignature('Execute git', JSON.stringify({kind:'execute',rawInput:{command:'git add src/a.ts'}})),'cmd:git add');
 assert.equal(permissionSignature('Execute ssh', JSON.stringify({kind:'execute',rawInput:{command:'ssh -o BatchMode=yes u26 hostname'}})),'cmd:ssh u26');
 assert.notEqual(permissionSignature('Execute ssh', JSON.stringify({kind:'execute',rawInput:{command:'ssh other hostname'}})),
  permissionSignature('Execute ssh', JSON.stringify({kind:'execute',rawInput:{command:'ssh u26 hostname'}})));
 assert.equal(permissionSignature('Выполнение команды', JSON.stringify({command:'git commit -m x'})),'cmd:git commit');
 assert.equal(permissionSignature('Execute chain', JSON.stringify({kind:'execute',rawInput:{command:'cd /c/projects/trio && git status && git log'}})),'cmd:cd+git status+git log');
 assert.equal(permissionSignature('Bash', JSON.stringify({command:'cd /c/projects/trio && git status'})),'cmd:cd+git status');
 assert.match(permissionCaption('Bash', JSON.stringify({rawInput:{command:'ssh u26 uptime'}})),/ssh u26 uptime/);
 assert.match(permissionCaption('Read', JSON.stringify({path:'src/a.ts'})),/Read src\/a\.ts/);
});
test('permission captions preserve filenames in long paths and identify multiple files',()=>{
 const filename='unique-target.txt';
 for (const sep of ['/', '\\']) {
  const target=['C:',...Array(10).fill('длинный каталог'),filename].join(sep);
  for (const fields of [{path:target},{file_path:target},{filePath:target},{rawInput:{path:target}}]) {
   const caption=permissionCaption('Удаление файлов',JSON.stringify(fields));
   assert(caption.endsWith(sep+filename),caption);
   assert(caption.length<=60,caption);
   assert.match(caption,/^Удаление файлов .*…/);
  }
 }
 const longName='very-long-filename-'.repeat(8)+'.txt';
 assert(permissionCaption('Edit',JSON.stringify({path:'/a/b/'+longName})).endsWith(longName));
 assert.equal(permissionCaption('Edit',JSON.stringify({path:longName})),'Edit '+longName);
 const paths=['C:/'+('dir/'.repeat(20))+'first, target.txt','C:/elsewhere/second.txt'];
 const detail=JSON.stringify({path:paths.join(', '),changes:paths.map(path=>({path}))});
 assert.match(permissionCaption('Изменение файлов',detail),/first, target\.txt \(\+1\)$/);
 assert.equal(permissionCaption('Read',JSON.stringify({path:'src/a.ts'})),'Read src/a.ts');
 assert.equal(permissionCaption('Bash',JSON.stringify({command:'git status',path:paths[0]})),'git status');
 assert.equal(permissionCaption('Edit','invalid JSON'),'Edit');
});
test('permissionClass splits command chains and ignores heredoc and quoted payloads',()=>{
 assert.equal(permissionClass('Execute cat', JSON.stringify({kind:'execute',rawInput:{command:"cat >> tests/foo.cjs <<'EOF'\nfs.rm(dir)\nEOF"}})),'command');
 assert.equal(permissionClass('Execute node', JSON.stringify({kind:'execute',rawInput:{command:'node -e "git commit && rm -rf /"'}})),'command');
 assert.equal(permissionClass('Execute git add', JSON.stringify({kind:'execute',rawInput:{command:'git add src/a.ts'}})),'command');
 assert.equal(permissionClass('Execute git chain', JSON.stringify({kind:'execute',rawInput:{command:'git add x && git commit -m x'}})),'danger');
 assert.equal(permissionClass('TodoWrite', JSON.stringify({todos:[]})),'read');
 assert.equal(permissionClass('Edit file', JSON.stringify({kind:'edit',_meta:{'x.ai/tool':{name:'todo_write',read_only:false}}})),'read');
 assert.equal(permissionClass('Edit file', JSON.stringify({kind:'write',_meta:{'x.ai/tool':{name:'search_replace'}}})),'edit');
 assert.equal(permissionClass('Web Fetch', JSON.stringify({kind:'web_fetch',_meta:{'x.ai/tool':{name:'web_fetch',read_only:true}}})),'danger');
 assert.equal(permissionClass('mcp__other__tool', '{}'),'danger');
 assert.equal(permissionClass('Выполнение команды', JSON.stringify({command:'git commit -m x'})),'danger');
 assert.equal(permissionClass('Выполнение команды', JSON.stringify({command:'git add src/a.ts'})),'command');
 assert.equal(permissionClass('Изменение файлов', JSON.stringify({path:'a.ts'})),'edit');
 assert.equal(permissionClass('Execute broken', JSON.stringify({kind:'execute',rawInput:{command:"echo 'oops"}})),'danger');
});
test('permissions are bound to a pending request and stop resolves denial',async t=>{
  let started;const ready=new Promise(r=>started=r);let decision;
  const {c,state}=await fixture(t,async o=>{
    const permission=o.permission('Bash','npm test');started();
    decision=await permission;return {text:'Готово',interrupted:o.signal.aborted};
  });
  await c.send('Колян, сделай тест','all');await ready;
  c.permission('invented',true);assert.equal(c.permissions.length,1);
  const id=c.permissions[0].id;c.permission(id,true);await c.idle();
  assert.equal(decision,true);assert.equal(c.permissions.length,0);
  assert.equal(state.messages.at(-1).author,'Trio');
  assert.equal(state.messages.at(-1).control,true,'решение не выдаётся за реплику Антона');
  assert.match(state.messages.at(-1).text,/Разрешено один раз/);
  assert.match(state.messages.at(-1).text,/Bash/);
  assert.ok(state.messages.at(-1).text.length<=110,'в ленту идёт метка, а не команда целиком');
  assert.equal(state.messages.at(-1).detail,'npm test');
  await c.send('Колян, сделай ещё','all');
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  await c.stop();assert.equal(decision,false);assert.equal(c.permissions.length,0);
});
test('standing approval covers the same signature until reset and never covers danger',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const first=await o.permission('Execute ssh',JSON.stringify({kind:'execute',rawInput:{command:'ssh u26 hostname'}}));
  const again=await o.permission('Execute ssh',JSON.stringify({kind:'execute',rawInput:{command:'ssh -o BatchMode=yes u26 uptime'}}));
  const other=o.permission('Execute ssh',JSON.stringify({kind:'execute',rawInput:{command:'ssh other hostname'}}));
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  assert.equal(c.permissions[0].standing,true);
  c.permission(c.permissions[0].id,false);
  const otherHost=await other;
  const danger=o.permission('Execute git',JSON.stringify({kind:'execute',rawInput:{command:'git commit -m x'}}));
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  assert.equal(c.permissions[0].standing,false);
  c.permission(c.permissions[0].id,true,false,true);
  const git=await danger;
  return {text:[first,again,otherHost,git].join('/'),interrupted:false};
 });
 await c.send('Колян, делай ssh','claude');
 while(!c.permissions.length)await new Promise(r=>setImmediate(r));
 assert.equal(c.permissions[0].standing,true);
 c.permission(c.permissions[0].id,true,false,true);
 await c.idle();
 assert.ok(state.messages.some(m=>m.control&&/до конца разговора/.test(m.text)));
 assert.match(state.messages.find(m=>m.author==='Колян').text,/true\/true\/false\/true/);
});
test('standing for live Claude Bash keeps cmd:ssh even after the modal shows the command',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const first=await o.permission('Bash',JSON.stringify({command:'ssh u26 hostname'}));
  const again=await o.permission('Bash',JSON.stringify({command:'ssh -o BatchMode=yes u26 uptime'}));
  const other=o.permission('Bash',JSON.stringify({command:'ssh other hostname'}));
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  c.permission(c.permissions[0].id,false);
  const otherHost=await other;
  return {text:[first,again,otherHost].join('/'),interrupted:false};
 });
 await c.send('Колян, делай ssh','claude');
 while(!c.permissions.length)await new Promise(r=>setImmediate(r));
 assert.equal(c.permissions[0].title,'Bash');
 assert.match(c.permissions[0].caption,/ssh u26 hostname/);
 assert.equal(c.permissions[0].standing,true);
 c.permission(c.permissions[0].id,true,false,true);
 await c.idle();
 assert.equal(state.messages.find(m=>m.author==='Колян').text,'true/true/false');
});
test('trace steps from the runner land on the turn',async t=>{
 const {c,state}=await fixture(t,async o=>{
  o.trace?.([{id:'1',kind:'tool',title:'Read adapter.ts',status:'running'}]);
  o.text('ok');
  return {text:'ok',interrupted:false};
 });
 await c.send('Колян, посмотри','claude');
 await c.idle();
 assert.equal(state.turns[0].trace[0].title,'Read adapter.ts');
});
test('a permission denial is a grey control line, not a red error',async t=>{
 const {c,state}=await fixture(t,async()=>({text:'',denied:'Bash',interrupted:false}));
 await c.send('Колян, сделай команду','claude');
 await c.idle();
 const note=state.messages.find(m=>m.control&&/не разрешили Bash/.test(m.text));
 assert.ok(note,'есть серая строка отказа');
 assert.equal(note.error,false);
 assert.equal(state.turns[0].status,'failed');
 assert.ok(!state.messages.some(m=>m.error),'красной ошибки нет');
 assert.ok(!state.messages.some(m=>m.author==='Колян'),'пустой ответ не остаётся');
});
test('standing approval of one agent does not apply to another, and reset clears it',async t=>{
 const {c}=await fixture(t,async o=>{
  const allow=await o.permission('Read spec.md','{}');
  return {text:String(allow)+o.provider,interrupted:false};
 });
 await c.send('Колян, посмотри','claude');
 while(!c.permissions.length)await new Promise(r=>setImmediate(r));
 c.permission(c.permissions[0].id,true,false,true);
 await c.idle();
 await c.send('Жека, посмотри','codex');
 while(!c.permissions.length)await new Promise(r=>setImmediate(r));
 assert.equal(c.permissions[0].provider,'codex');
 c.permission(c.permissions[0].id,false);
 await c.idle();
 await c.reset('context');
 await c.send('Колян, посмотри ещё','claude');
 while(!c.permissions.length)await new Promise(r=>setImmediate(r));
 assert.equal(c.permissions[0].provider,'claude');
 c.permission(c.permissions[0].id,false);
 await c.idle();
});
test('an unsupported protocol method is noted in the feed',async t=>{
 const {c,state}=await fixture(t,async o=>{
  o.notice?.('x.ai/foo','{"ok":1}');
  return {text:'ok',interrupted:false};
 });
 await c.send('привет','claude');await c.idle();
 const row=state.messages.find(m=>m.control&&/метод не поддержан/.test(m.text));
 assert.match(row.text,/x\.ai\/foo/);
 assert.match(row.detail,/ok/);
});
test('a whole-turn approval stops asking until the turn ends, then asks again',async t=>{
  let asked=0;
  const {c,state}=await fixture(t,async o=>{
    asked++; const first=await o.permission('Bash','npm test');
    const second=await o.permission('Bash','npm run build');
    return {text:'Готово '+first+second,interrupted:false};
  });
  const answer=async whole=>{
    while(!c.permissions.length)await new Promise(r=>setImmediate(r));
    c.permission(c.permissions[0].id,true,whole);
  };
  const run=c.send('Колян, сделай тест','all');
  await answer(true);
  await run; await c.idle();
  assert.equal(state.messages.filter(m=>m.control&&m.text.includes('Разрешено до конца хода')).length,1);
  const blanket=state.messages.find(m=>m.control&&m.text.includes('Разрешено до конца хода'));
  assert.equal(blanket.actions.length,2);
  assert.match(blanket.actions[0].detail,/npm test/);
  assert.match(blanket.actions[1].detail,/npm run build/);
  assert.doesNotMatch(blanket.text,/npm test/);
  const next=c.send('Колян, сделай ещё','all');
  await answer(false);
  assert.equal(asked,2,'следующий ход снова спрашивает');
  c.permission(c.permissions[0]?.id||'x',true);
  await next; await c.idle();
});
test('recovery preserves history and queue without running models',async t=>{
  const {c,state,store,host,runs}=await fixture(t);
  await c.send('queued','all');
  state.turns.push({id:'crashed',messageId:'x',status:'running',recipient:'claude'});
  await c.save();
  const recovered=await store.load();
  const second=new Controller(recovered,store,host,async()=>{throw new Error('must not run');});
  await second.recover();
  assert.equal(runs.length,0);assert.equal(recovered.turns.at(-1).status,'interrupted');
  assert.equal(recovered.queue.length,1);
});
test('invalid UI messages and unknown permission fields are rejected',()=>{
  assert.equal(input({type:'agent',agent:{id:'intruder'}}),undefined);
  const agent={id:'claude',enabled:true,mode:'discuss',model:'',effort:''};
  assert.ok(input({type:'agent',agent}));
  assert.ok(input({type:'agent',agent:{...agent,instruction:'кратко'}}));
  assert.equal(input({type:'agent',agent:{...agent,instruction:'x'.repeat(instructionLimit+1)}}),undefined);
  assert.equal(input({type:'send',text:'x',recipient:'both'}),undefined);
  assert.equal(input({type:'permission',requestId:4,allow:true}),undefined);
  assert.equal(input({type:'answer',requestId:'x',answers:{q:'y'.repeat(2001)}}),undefined);
  assert.equal(input({type:'answer',requestId:'x',answers:Object.fromEntries([...Array(9)].map((_,i)=>['q'+i,'a']))}),undefined);
  assert.ok(input({type:'answer',requestId:'x',answers:{q:'ok'}}));
});

test('stop while preparing does not wait for a save dialog or start a CLI',async t=>{
 const {c,host,runs,state}=await fixture(t);
 let prepared;const ready=new Promise(r=>prepared=r);
 let release;host.prepare=async()=>{prepared();return new Promise(r=>release=r);};
 await c.send('Колян, исправь файл','all');await ready;
 await c.stop();assert.equal(c.busy,false);assert.equal(runs.length,0);
 assert.equal(state.turns[0].status,'interrupted');release('late-snapshot');
 await new Promise(r=>setImmediate(r));assert.equal(runs.length,0);
});

test('failed startup has an error but no empty assistant message',async t=>{
 const {c,state,notes}=await fixture(t,async()=>{throw new Error('startup failed');});
 await c.send('привет','claude');await c.idle();
 assert.equal(state.messages.some(m=>m.author==='Колян'),false);
 assert.equal(state.turns[0].replyId,undefined);
 assert.equal(state.turns[0].status,'failed');
 assert.match(state.messages.at(-1).text,/startup failed/);
 assert.equal(state.messages.at(-1).turn,state.turns[0].id);
 assert.ok(notes.some(n=>n==='done:Колян: ошибка'));
});
test('retry repeats a failed execute turn without forcing discuss',async t=>{
 const {c,state,runs}=await fixture(t,async()=>{
  if(runs.length===1)return {text:'',interrupted:false,error:'Нет ответа 1 с'};
  return {text:'ok',interrupted:false};
 });
 await c.send('Колян, делай файл','claude');await c.idle();
 assert.equal(state.turns[0].status,'failed');
 assert.equal(state.turns[0].mode,'execute');
 await c.retry(state.turns[0].id);await c.idle();
 assert.equal(state.turns[1].messageId,state.turns[0].messageId);
 assert.equal(state.turns[1].mode,'execute');
 assert.equal(state.turns[1].recipient,'claude');
 assert.equal(state.turns[1].status,'completed');
 assert.ok(state.messages.some(m=>m.author==='Колян'&&m.text==='ok'));
});
test('a permission request toasts once when the queue was empty',async t=>{
 let started;const ready=new Promise(r=>started=r);
 const {c,notes}=await fixture(t,async o=>{
  started();
  o.permission('Bash','npm test');
  o.permission('Bash','npm run build');
  await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));
  return {text:'x',interrupted:true};
 });
 await c.send('Колян, делай тест','claude');await ready;
 while(!c.permissions.length)await new Promise(r=>setImmediate(r));
 assert.equal(notes.filter(n=>n.startsWith('permission:')).length,1);
 await c.stop();
});
test('manual stop before first token is recorded without an empty partial reply',async t=>{
 let started;const ready=new Promise(r=>started=r);
 const {c,state}=await fixture(t,async o=>{
  started();await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));
  return {text:'',interrupted:true};
 });
 await c.send('привет','claude');await ready;await c.stop();
 assert.equal(state.messages.some(m=>m.author==='Колян'),false);
 assert.match(state.messages.at(-1).text,/остановлен до получения ответа/);
});


test('numbered respondents share the exact question and persist without automatic continuation',async t=>{
 const {c,state,runs,store,host}=await fixture(t);
 await c.send('Нужны два мнения','all',['claude','codex']);await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['claude']);
 assert.equal(state.messages.filter(m=>m.author==='Антон').length,1);
 assert.equal(state.queue.length,1);
 const saved=await store.load(), resumedRuns=[];
 const second=new Controller(saved,store,host,async o=>{resumedRuns.push(o);return {text:'Второе мнение',interrupted:false};});
 await second.recover();assert.equal(resumedRuns.length,0);
 await second.handoff('codex',saved.queue[0]);await second.idle();
 assert.ok(resumedRuns[0].prompt.endsWith('Нужны два мнения'));
 assert.match(resumedRuns[0].prompt,/Ответ claude/);
 assert.doesNotMatch(resumedRuns[0].prompt,/Прочитал|тебе слово|отвечай на выбранное/);
 assert.equal(saved.messages.filter(m=>m.author==='Антон').length,1);
 assert.equal(saved.queue.length,0);
});

test('numbered order cannot be bypassed, including while queued behind another question',async t=>{
 const {c,state,runs}=await fixture(t);
 await c.send('ожидающий вопрос','all');
 await c.send('Колян, оцени вариант','all',['codex','claude']);await c.idle();
 assert.equal(runs[0].provider,'codex'); // explicit selection has priority
 const pending=state.queue.at(-1);
 await assert.rejects(c.handoff('codex',pending),/другой адресат/);
 await c.handoff('claude',pending);await c.idle();
 assert.equal(runs.length,2);
 const before=state.messages.length;
 await assert.rejects(c.send('invalid','all',['codex','codex']),/без повторов/);
 assert.equal(state.messages.length,before);
});

test('second numbered answer cannot start first when the whole group is waiting',async t=>{
 const {c,state}=await fixture(t);
 // Hold an unrelated run in preparation while the group is queued.
 let release,ready; const preparing=new Promise(r=>ready=r);
 c.host.prepare=async()=>{ready();return new Promise(r=>release=r);};
 await c.send('Колян, исправь файл','all');await preparing;
 await c.send('Два мнения','all',['claude','codex']);
 await c.stop();release('unused');
 const second=state.queue.at(-1);
 await assert.rejects(c.handoff('codex',second),/предыдущему/);
 assert.equal(state.turns.find(t=>t.id===second).status,'proposed');
});

test('a quota-only usage report refreshes the stored percent after occupancy',async t=>{
 const {c,state}=await fixture(t,async o=>{
  o.usage({tokens:100,window:1000,raw:{}},'result');
  o.usage({raw:{fiveHour:{usedPercent:44,windowDurationMins:300,resetsAt:'2026-09-11T16:00:00Z'}}},'oauth/usage');
  return {text:'ok',interrupted:false};
 });
 await c.send('hi','claude');await c.idle();
 assert.equal(state.usage.claude.tokens,100);
 assert.equal(state.usage.claude.quota.percent,44);
});
test('Codex card retains the main limit across Spark-only notifications and manual refreshes',async t=>{
 const raw=require('./fixtures/codex-rate-limits.json');
 const spark={rateLimits:raw.rateLimitsByLimitId.codex_bengalfox};
 const {c,state}=await fixture(t,async o=>{
  o.usage({tokens:99873,window:258400,raw},'account/rateLimits/read');
  o.usage({raw:spark},'account/rateLimits/updated');
  return {text:'ok',interrupted:false};
 });
 await c.send('hi','codex');await c.idle();
 assert.equal(state.usage.codex.quota.percent,43);
 assert.equal(state.usage.codex.quota.limitId,'codex');
 c.rememberQuota('codex',spark);
 assert.equal(state.usage.codex.quota.percent,43);
 c.rememberQuota('codex',{rateLimits:{limitId:'codex',primary:{usedPercent:44,windowDurationMins:10080}}});
 assert.equal(state.usage.codex.quota.percent,44);
 assert.equal(state.usage.codex.tokens,99873);
});
test('an idle session is not resumed',async t=>{
 const {c,state,runs,host}=await fixture(t, withSession);
 host.sessionIdle=()=>55*60*1000;
 await c.send('first','claude');await c.idle();
 assert.ok(state.sessions['claude:discuss']?.id);
 state.usage.claude={tokens:80000,window:200000,source:'result',at:Date.now()};
 state.turns[0].endedAt=Date.now()-60*60*1000;
 await c.send('second','claude');await c.idle();
 assert.equal(runs[1].session,undefined);
 assert.equal(state.usage.claude.tokens,80000);
 assert.equal(state.usage.claude.source,'fresh-session');
 assert.ok(state.diagnostics.some(d=>/fresh session: idle/.test(d)));
 assert.ok(state.messages.some(m=>m.control&&/Колян: новая сессия CLI \(простой /.test(m.text)));
});
test('a fat session is not resumed',async t=>{
 const {c,state,runs,host}=await fixture(t, withSession);
 host.sessionMaxTokens=()=>150000;
 await c.send('first','claude');await c.idle();
 assert.ok(state.sessions['claude:discuss']?.id);
 state.usage.claude={tokens:200000,window:1000000,source:'result',at:Date.now()};
 await c.send('second','claude');await c.idle();
 assert.equal(runs[1].session,undefined);
 assert.equal(state.usage.claude.tokens,200000);
 assert.equal(state.usage.claude.source,'fresh-session');
 assert.ok(state.diagnostics.some(d=>/fresh session: window/.test(d)));
 assert.ok(state.messages.some(m=>m.control&&m.text==='Колян: новая сессия CLI (окно 200k > 150k)'));
});
test('Grok ignores the session token ceiling',async t=>{
 const {c,state,runs,host}=await fixture(t, withSession);
 host.sessionMaxTokens=p=>p==='grok'?0:150000;
 for (const a of state.agents) a.enabled = a.id === 'grok';
 await c.send('first','grok');await c.idle();
 assert.ok(state.sessions['grok:discuss']?.id);
 state.usage.grok={tokens:200000,window:500000,source:'session/prompt',at:Date.now()};
 await c.send('second','grok');await c.idle();
 assert.equal(runs[1].session,'session-grok');
 assert.equal(state.usage.grok.tokens,200000);
 assert.equal(state.usage.grok.source,'session/prompt');
 assert.ok(!state.diagnostics.some(d=>/fresh session: window/.test(d)));
 assert.ok(!state.messages.some(m=>/новая сессия CLI/.test(m.text)));
});
test('Grok respects a configured session token ceiling',async t=>{
 const {c,state,runs,host}=await fixture(t, withSession);
 host.sessionMaxTokens=p=>p==='grok'?150000:0;
 for (const a of state.agents) a.enabled = a.id === 'grok';
 await c.send('first','grok');await c.idle();
 assert.ok(state.sessions['grok:discuss']?.id);
 state.usage.grok={tokens:200000,window:500000,source:'session/prompt',at:Date.now()};
 await c.send('second','grok');await c.idle();
 assert.equal(runs[1].session,undefined);
 assert.equal(state.usage.grok.source,'fresh-session');
 assert.ok(state.messages.some(m=>m.control&&m.text==='Гриха: новая сессия CLI (окно 200k > 150k)'));
});
test('a zero ceiling leaves a fat Claude session running',async t=>{
 const {c,state,runs,host}=await fixture(t, withSession);
 host.sessionMaxTokens=()=>0;
 await c.send('first','claude');await c.idle();
 assert.ok(state.sessions['claude:discuss']?.id);
 state.usage.claude={tokens:200000,window:1000000,source:'result',at:Date.now()};
 await c.send('second','claude');await c.idle();
 assert.equal(runs[1].session,'session-claude');
 assert.equal(state.usage.claude.source,'result');
 assert.ok(!state.messages.some(m=>/новая сессия CLI/.test(m.text)));
});
test('each participant uses their own session token ceiling',async t=>{
 const {c,state,runs,host}=await fixture(t, withSession);
 host.sessionMaxTokens=p=>p==='claude'?150000:0;
 state.agents.find(a=>a.id==='grok').enabled=true;
 await c.send('first','claude');await c.idle();
 await c.send('first grok','grok');await c.idle();
 state.usage.claude={tokens:200000,window:1000000,source:'result',at:Date.now()};
 state.usage.grok={tokens:200000,window:500000,source:'session/prompt',at:Date.now()};
 await c.send('second','claude');await c.idle();
 await c.send('second grok','grok');await c.idle();
 assert.equal(runs[2].session,undefined);
 assert.equal(runs[3].session,'session-grok');
 assert.ok(state.messages.some(m=>m.control&&m.text==='Колян: новая сессия CLI (окно 200k > 150k)'));
 assert.ok(!state.messages.some(m=>/Гриха: новая сессия CLI/.test(m.text)));
});
test('occupancy after a fresh session accepts a lower figure',async t=>{
 const {c,state,host}=await fixture(t, async o=>{
  await o.onSession('session-'+o.provider);
  if (o.prompt.includes('second')) {
   o.usage({window:500000,raw:{}},'initialize');
   o.usage({tokens:40000,window:500000,raw:{}},'session/prompt');
  }
  return {text:'ok',interrupted:false};
 });
 host.sessionMaxTokens=()=>150000;
 await c.send('first','claude');await c.idle();
 state.usage.claude={tokens:200000,window:1000000,source:'result',at:Date.now()};
 await c.send('second','claude');await c.idle();
 assert.equal(state.usage.claude.tokens,40000);
 assert.equal(state.usage.claude.window,500000);
 assert.equal(state.usage.claude.source,'session/prompt');
});
test('refreshQuota after a finished Claude turn does not run for Grok',async t=>{
 const seen=[];
 const {c,state,host}=await fixture(t);
 state.agents.forEach(a=>a.enabled=true);
 host.refreshQuota=async p=>seen.push(p);
 await c.send('hi','claude');await c.idle();
 assert.deepEqual(seen,['claude']);
 await c.send('hi','grok');await c.idle();
 assert.deepEqual(seen,['claude']);
});
test('quota from a short window is stored beside occupancy and kept after compact',async t=>{
 const {c,state}=await fixture(t,async o=>{
  o.usage({tokens:100,window:1000,raw:{fiveHour:{usedPercent:62,windowDurationMins:300,resetsAt:'2026-09-11T16:00:00Z'}}},'result');
  return {text:'ok',interrupted:false};
 });
 await c.send('hi','claude');await c.idle();
 assert.equal(state.usage.claude.tokens,100);
 assert.equal(state.usage.claude.quota.percent,62);
 assert.equal(state.usage.claude.quota.resetsAt,Date.parse('2026-09-11T16:00:00Z'));
 c.rememberQuota('claude',{fiveHour:{usedPercent:91,windowDurationMins:300,resetsAt:'2026-09-11T18:00:00Z'}});
 assert.equal(state.usage.claude.quota.percent,91);
 assert.equal(state.usage.claude.tokens,100);
});
test('occupancy keeps the high-water mark until compact',async t=>{
 const {c,state}=await fixture(t,async o=>{
  o.usage({tokens:303353,window:500000,raw:{totalTokens:303353}},'session/prompt');
  o.usage({tokens:245000,window:500000,raw:{totalTokens:245000}},'session/prompt');
  return {text:'ok',interrupted:false};
 });
 await c.send('hi','claude');await c.idle();
 assert.equal(state.usage.claude.tokens,303353);
});
test('after compact a lower occupancy is accepted',async t=>{
 const {c,state}=await fixture(t,async o=>{
  o.usage({tokens:300000,window:500000,raw:{totalTokens:300000}},'session/prompt');
  o.compacted();
  o.usage({tokens:100000,window:500000,raw:{totalTokens:100000}},'session/prompt');
  return {text:'ok',interrupted:false};
 });
 await c.send('hi','claude');await c.idle();
 assert.equal(state.usage.claude.tokens,100000);
});
test('auto-compact is written to the feed and clears occupancy',async t=>{
 const {c,state}=await fixture(t,async o=>{o.compacted?.();return {text:'ok',interrupted:false};});
 state.usage.claude={tokens:120000,window:500000,source:'result',at:1};
 await c.send('hi','claude');await c.idle();
 assert.ok(state.messages.some(m=>m.control&&m.text==='Колян: автосжатие контекста'));
 assert.equal(state.usage.claude.tokens,undefined);
 assert.equal(state.usage.claude.window,500000);
});
test('a turn keeps spend from the engine, not occupancy',async t=>{
 const {c,state}=await fixture(t,async o=>{
  o.usage({tokens:300000,spent:610,raw:{}},'session/prompt');
  return {text:'ok',interrupted:false};
 });
 await c.send('привет','claude');await c.idle();
 assert.equal(state.turns[0].spent,610);
 assert.equal(state.usage.claude.tokens,300000);
 assert.ok(state.diagnostics.some(d=>/spent=610/.test(d)));
});
test('reported context lands on the right card, keeps the raw payload in diagnostics and dies with the session',async t=>{
 const {c,state}=await fixture(t,async o=>{
  o.usage({window:500000,raw:{model_context_window:500000}},'initialize');
  o.usage({tokens:120000,raw:{usage:{input_tokens:100000,cache_read_input_tokens:19000,output_tokens:1000}}},'result');
  return {text:'Ответ',interrupted:false};
 });
 await c.send('Колян, посмотри проект','claude');await c.idle();
 assert.equal(state.usage.claude.tokens,120000);assert.equal(state.usage.claude.window,500000);
 assert.equal(state.usage.codex,undefined);
 assert.ok(state.diagnostics.some(d=>d.startsWith('claude result: ')&&d.includes('100000')));
 assert.ok(state.diagnostics.some(d=>/window=500000/.test(d)));
 // New sessions start empty, so the old occupancy must not survive a context reset.
 await c.reset('context');
 assert.deepEqual(state.usage,{});
});

test('resetting one agent drops only that session and leaves the others',async t=>{
 const {c,state}=await fixture(t, withSession);
 await c.send('hi','claude');await c.idle();
 state.sessions['codex:execute']={id:'keep-codex',project:c.host.root,profile:'execute'};
 state.usage.claude={tokens:100,window:1000,source:'result',at:1};
 state.usage.codex={tokens:50,window:1000,source:'result',at:1};
 const id=state.conversationId;
 await c.reset('context','claude');
 assert.equal(state.conversationId,id);
 assert.equal(state.sessions['codex:execute'].id,'keep-codex');
 assert.equal(state.sessions['claude:discuss'],undefined);
 assert.equal(state.usage.claude,undefined);
 assert.equal(state.usage.codex.tokens,50);
 assert.ok(state.messages.some(m=>/Колян/.test(m.text)&&/сброшен/.test(m.text)));
});
test('context reset preserves visible history but excludes it and all old sessions from both agents',async t=>{
 const {c,state,runs,store}=await fixture(t,async o=>{
   await o.onSession(o.provider+'-session');
   return {text:'OLD_REPLY',interrupted:false};
 });
 await c.send('OLD_SECRET','claude');await c.idle();
 await c.send('OLD_PENDING','all');
 const oldId=state.conversationId;
 state.sessions['codex:execute']={id:'old-codex',project:c.host.root,profile:'execute'};
 const archive=await c.reset('context');
 assert.equal(JSON.parse(await fs.readFile(archive,'utf8')).messages[0].text,'OLD_SECRET');
 assert.notEqual(state.conversationId,oldId);
 assert.equal(state.messages[0].text,'OLD_SECRET');
 assert.deepEqual(state.sessions,{});assert.deepEqual(state.queue,[]);
 await assert.rejects(c.handoff('codex'),/Сначала напишите/);
 await c.send('NEW_QUESTION','all',['claude','codex']);await c.idle();
 assert.equal(runs[1].session,undefined);
 assert.doesNotMatch(runs[1].prompt,/OLD_SECRET|OLD_PENDING|OLD_REPLY|Контекст сброшен/);
 await c.handoff('codex',state.queue[0]);await c.idle();
 assert.equal(runs[2].session,undefined);
 assert.doesNotMatch(runs[2].prompt,/OLD_SECRET|OLD_PENDING/);
 const reloaded=await store.load();
 assert.equal(reloaded.contextStart,state.contextStart);
});

test('new conversation archives state and resets conversation while preserving agent settings and files',async t=>{
 const {c,state,store,host}=await fixture(t);
 await fs.writeFile(path.join(host.root,'keep.txt'),'untouched');
 state.agents[0].model='custom';state.agents[0].instruction='пиши кратко';state.draft='draft';
 state.responseOrder=['codex','claude'];
 await c.send('old history','all');
 state.sessions.any={id:'s',project:host.root,profile:'discuss'};
 const before=structuredClone(state);
 const archive=await c.reset('conversation');
 assert.deepEqual(JSON.parse(await fs.readFile(archive,'utf8')),before);
 assert.deepEqual(state.messages,[]);assert.deepEqual(state.turns,[]);
 assert.deepEqual(state.sessions,{});assert.deepEqual(state.queue,[]);
 assert.equal(state.draft,'');assert.deepEqual(state.responseOrder,[]);
 assert.equal(state.agents[0].model,'custom');
 assert.equal(state.agents[0].instruction,'пиши кратко');
 assert.equal(await fs.readFile(path.join(host.root,'keep.txt'),'utf8'),'untouched');
 assert.notEqual(state.conversationId,before.conversationId);
 assert.deepEqual((await store.load()).messages,[]);
});

test('failed archive keeps conversation intact; reset reservation blocks concurrent sends',async t=>{
 const {c,state,store}=await fixture(t);
 await c.send('keep history','all');
 const before=structuredClone(state);
 let reject,started;const ready=new Promise(r=>started=r);
 store.archive=async()=>{started();return new Promise((resolve,r)=>reject=r);};
 const resetting=c.reset('conversation');await ready;
 await assert.rejects(c.send('too soon','codex'),/Дождитесь/);
 await assert.rejects(c.handoff('claude'),/Дождитесь/);
 reject(new Error('disk full'));
 await assert.rejects(resetting,/disk full/);
 assert.deepEqual(state,before);assert.equal(c.resetting,false);
});

test('reset requires active work to finish or stop, without dropping any partial answer',async t=>{
 let ready;const started=new Promise(r=>ready=r);
 const {c,state}=await fixture(t,async o=>{
   o.text('partial');ready();
   await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));
   return {text:'partial',interrupted:true};
 });
 await c.send('question','codex');await started;
 await assert.rejects(c.reset('context'),/остановите/);
 assert.equal(c.busy,true);
 await c.stop();
 assert.equal(state.messages.find(m=>m.author==='Жека').text,'partial');
});

test('UI order and reset input validates providers, duplicates, epoch and action',()=>{
 assert.equal(input({type:'send',text:'x',recipient:'all',responseOrder:['codex','codex']}),undefined);
 assert.equal(input({type:'send',text:'x',recipient:'all',responseOrder:['other']}),undefined);
 assert.equal(input({type:'send',text:'x',recipient:'all',conversationId:4}),undefined);
 assert.equal(input({type:'reset',mode:'delete-files'}),undefined);
 assert.ok(input({type:'reset',mode:'context'}));
 assert.ok(input({type:'usage',provider:'grok'}));
 assert.equal(input({type:'usage',provider:'other'}),undefined);
 assert.ok(input({type:'project'}));
 assert.ok(input({type:'plugin-settings'}));
 assert.ok(input({type:'open-image',id:'abc.png'}));
 assert.equal(input({type:'open-image',id:1}),undefined);
 assert.equal(diskImagePath('Изображение на диске: C:/store/images/abc.png\nОткрой его'),'C:/store/images/abc.png');
 assert.equal(plainAttachment({id:'a',label:'x',text:'t',preview:'webview://x'}).preview,undefined);
 assert.ok(input({type:'flags',autoReply:true,autoEdits:true,autoCommands:false}));
 assert.ok(input({type:'save-image',id:'abc.png'}));
 assert.ok(input({type:'answer',requestId:'r',answers:{'Цвет?':'синий'}}));
 assert.equal(input({type:'answer',requestId:'r',answers:[]}),undefined);
 assert.ok(input({type:'retry',turnId:'t1'}));
 assert.equal(input({type:'retry'}),undefined);
 assert.ok(input({type:'snippets',items:[{id:'s1',name:'пакет',text:'пакет коммит',flags:{autoCommands:true,responseOrder:['codex']}}]}));
 assert.equal(input({type:'snippets',items:[{id:'s1',name:'',text:'x'}]}),undefined);
 assert.equal(input({type:'snippets',items:[{id:'bad id',name:'n',text:'t'}]}),undefined);
 assert.equal(input({type:'snippets',items:Array.from({length:41},(_,i)=>({id:'s'+i,name:'n',text:'t'}))}),undefined);
});
test('deltaHints lists every enabled agent even if a reply order is already chosen',async t=>{
 const {c,state}=await fixture(t);
 state.responseOrder=['claude'];
 const who=c.deltaHints().map(h=>h.provider).sort();
 assert.deepEqual(who,['claude','codex']);
});
test('deltaHints names a missing session vs a compact that dropped the cursor',async t=>{
 const {c,state}=await fixture(t, withSession);
 await c.send('first','claude');await c.idle();
 assert.equal(c.deltaHints().find(h=>h.provider==='claude').kind,'delta');
 delete state.sessions['claude:discuss'].through;
 const compacted=c.deltaHints().find(h=>h.provider==='claude');
 assert.equal(compacted.kind,'full');
 assert.equal(compacted.reason,'compact');
 delete state.sessions['claude:discuss'];
 const fresh=c.deltaHints().find(h=>h.provider==='claude');
 assert.equal(fresh.kind,'full');
 assert.equal(fresh.reason,'fresh');
});
test('deltaHints reports a fat delta after a long silence',async t=>{
 const {c,state,host}=await fixture(t, withSession);
 await c.send('first','claude');await c.idle();
 assert.equal(c.deltaHints().find(h=>h.provider==='claude').kind,'delta');
 for(let i=0;i<8;i++) state.messages.push({id:'gap'+i,author:'Антон',text:'слой '.repeat(800)});
 state.draft='короткий вопрос';
 const hint=c.deltaHints().find(h=>h.provider==='claude');
 assert.equal(hint.kind,'delta');
 assert.ok(hint.chars>=20000,hint.chars);
 assert.ok(hint.messages>=8);
 assert.equal(hint.total,hint.messages);
 host.limit=()=>400;
 const tight=c.deltaHints().find(h=>h.provider==='claude');
 assert.ok(tight.total>tight.messages,tight.messages+' из '+tight.total);
});
test('contextFit reports how many messages actually fit',()=>{
 const messages=Array.from({length:5},(_,i)=>({id:'m'+i,author:'Антон',text:'слово '.repeat(20)}));
 const fit=contextFit(messages,'сейчас',80);
 assert.ok(fit.omitted>0);
 assert.equal(fit.shown+fit.omitted,5);
 assert.match(fit.text,/не поместилась: \d+ сообщений/);
});
test('prompt diagnostics name the size and whether the feed was a delta',async t=>{
 const {c,state}=await fixture(t);
 await c.send('hi','claude');await c.idle();
 assert.ok(state.diagnostics.some(d=>/claude prompt: \d+ символов, полная лента/.test(d)));
});
test('a finished turn records wall-clock startedAt and endedAt',async t=>{
 const {c,state}=await fixture(t);
 const before=Date.now();
 await c.send('hi','claude');await c.idle();
 const turn=state.turns[0];
 assert.equal(typeof turn.startedAt,'number');
 assert.equal(typeof turn.endedAt,'number');
 assert.ok(turn.endedAt>=turn.startedAt);
 assert.ok(turn.startedAt>=before-1000);
});
test('auto-reply runs the rest of the numbered queue',async t=>{
 const {c,runs}=await fixture(t);
 await c.setFlags({autoReply:true});
 await c.send('всем','all',['claude','codex']);await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['claude','codex']);
});
test('auto-reply continues to the next question as cycle 2',async t=>{
 let release;const hold=new Promise(r=>release=r);let first=true;
 const {c,state,runs}=await fixture(t,async o=>{
  if(first){first=false;await hold;}
  return {text:'ok '+o.provider,interrupted:false};
 });
 await c.setFlags({autoReply:true});
 await c.send('всем','all',['claude','codex']);
 await c.send('второй','claude');
 const questions=state.messages.filter(m=>m.author==='Антон');
 assert.equal(state.turns.filter(t=>t.messageId===questions[0].id).every(t=>t.cycle===1),true);
 assert.equal(state.turns.find(t=>t.messageId===questions[1].id).cycle,2);
 release();
 await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['claude','codex','claude']);
 assert.ok(state.messages.some(m=>m.control&&/цикл 2/.test(m.text)));
});
test('auto-reply with all and no numbers starts the first enabled agent',async t=>{
 const {c,runs}=await fixture(t);
 await c.setFlags({autoReply:true});
 await c.send('Обсудим проект','all');await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['claude']);
});
test('stop one person during auto-reply leaves the rest queued',async t=>{
 let started;const ready=new Promise(r=>started=r);
 const {c,state,runs}=await fixture(t,async o=>{
  started();
  await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));
  return {text:'x',interrupted:true};
 });
 await c.setFlags({autoReply:true});
 await c.send('всем','all',['claude','codex']);await ready;
 await c.stop('claude');await c.idle();
 assert.equal(runs.length,1);
 assert.equal(state.autoReply,true);
 assert.equal(state.queue.length,1);
 assert.equal(state.turns.find(t=>t.recipient==='codex').status,'proposed');
});
test('with auto-reply off a second question still waits for a click',async t=>{
 let release;const hold=new Promise(r=>release=r);let first=true;
 const {c,state,runs}=await fixture(t,async o=>{
  if(first){first=false;await hold;}
  return {text:'ok',interrupted:false};
 });
 await c.send('первый','claude');
 await c.send('второй','codex');
 release();await c.idle();
 assert.equal(runs.length,1);
 assert.ok(state.queue.includes(state.turns.find(t=>t.recipient==='codex').id));
});
test('a failed auto-reply turn does not start the next agent',async t=>{
 const {c,runs}=await fixture(t,async()=>({text:'',error:'лимит',interrupted:false}));
 await c.setFlags({autoReply:true});
 await c.send('всем','all',['claude','codex']);await c.idle();
 assert.equal(runs.length,1);
});
test('stop everyone turns auto-reply off',async t=>{
 let started;const ready=new Promise(r=>started=r);
 const {c,state}=await fixture(t,async o=>{
  started();
  await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));
  return {text:'x',interrupted:true};
 });
 await c.setFlags({autoReply:true});
 await c.send('hi','claude');await ready;
 await c.stop();
 assert.equal(state.autoReply,false);
});
test('auto-actions allow an execute-mode edit even if the file text mentions bash',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const allow=await o.permission('Editing package.json',JSON.stringify({kind:'edit',rawInput:{content:'please bash delete network'}}));
  return {text:String(allow),interrupted:false};
 });
 await c.setFlags({autoEdits:true});
 await c.send('Колян, делай правку package.json','claude');await c.idle();
 assert.equal(state.turns[0].mode,'execute');
 assert.ok(state.messages.some(m=>m.text==='Автоправки: Колян'));
 assert.equal(c.permissions.length,0);
});
test('auto-commands allow tests and still ask for git commit',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const testRun=await o.permission('Execute tsc',JSON.stringify({kind:'execute',rawInput:{command:'node --test tests'}}));
  const pending=o.permission('Execute git',JSON.stringify({kind:'execute',rawInput:{command:'git commit -m x'}}));
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  c.permission(c.permissions[0].id,false);
  const git=await pending;
  return {text:String(testRun)+'/'+String(git),interrupted:false};
 });
 await c.setFlags({autoCommands:true});
 await c.send('Колян, делай прогон тестов','claude');await c.idle();
 assert.ok(state.messages.some(m=>m.text==='Автокоманды: Колян'));
 assert.ok(state.messages.some(m=>/Отказано/.test(m.text)&&/git/i.test(m.text)));
});
test('auto-commands allow a read the same way auto-edits do',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const read=await o.permission('Read spec.md','{}');
  return {text:String(read),interrupted:false};
 });
 await c.setFlags({autoCommands:true,autoEdits:false});
 await c.send('Колян, посмотри','claude');await c.idle();
 assert.ok(state.messages.some(m=>m.text==='Автоправки: Колян'));
 assert.equal(c.permissions.length,0);
});
test('auto-actions allow a read and still ask for bash',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const read=await o.permission('Read spec.md','{}');
  const pending=o.permission('Bash','rm');
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  c.permission(c.permissions[0].id,false);
  const bash=await pending;
  return {text:String(read)+'/'+String(bash),interrupted:false};
 });
 await c.setFlags({autoEdits:true});
 await c.send('Колян, посмотри','claude');await c.idle();
 assert.ok(state.messages.some(m=>m.text==='Автоправки: Колян'));
 assert.ok(state.messages.some(m=>/Отказано/.test(m.text)&&/Bash/.test(m.text)));
});
test('an agent question lands in the feed and its answer travels with the card',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const answers=await o.question([{prompt:'Цвет?',options:[{label:'красный'},{label:'синий'}]}]);
  return {text:'ok '+JSON.stringify(answers),interrupted:false};
 });
 await c.send('спроси','claude');
 while(!state.messages.some(m=>m.question))await new Promise(r=>setImmediate(r));
 const card=state.messages.find(m=>m.question);
 c.answer(card.question.id,{'Цвет?':'синий'});
 await c.idle();
 assert.deepEqual(state.messages.find(m=>m.id===card.id).question.answered,{'Цвет?':['синий']});
 // The card already shows the picked option, so Anton is not quoted a second time.
 assert.equal(state.messages.filter(m=>m.author==='Антон'&&/синий/.test(m.text)).length,0);
 // The prompt and the export still read the answer out of the card.
 assert.match(messageText(state.messages.find(m=>m.id===card.id)),/Ответ Антона на «Цвет\?»: синий/);
});

test('a finished Codex turn removes its unanswered modal instead of reopening it on Reload',async t=>{
 const {c,state,store}=await fixture(t,async o=>{
   void o.question([{id:'q',prompt:'Вопрос?',options:[]}]);
   return {text:'Ход завершён движком',interrupted:false};
 });
 await c.send('спроси','codex');await c.idle();
 assert.equal(state.messages.filter(m=>m.question&&!m.question.answered).length,0);
 assert.equal((await store.load()).messages.filter(m=>m.question&&!m.question.answered).length,0);
});

test('Codex auto-edits do not swallow a file deletion',async t=>{
 const {codexApproval}=require('../dist/providers/codexProtocol');
 const {c,state}=await fixture(t,async o=>{
   const edit=codexApproval('item/fileChange/requestApproval',{}, {changes:[{path:'a',kind:{type:'update'}}]});
   assert.equal(await o.permission(edit.title,edit.detail),true);
   const del=codexApproval('item/fileChange/requestApproval',{}, {changes:[{path:'a',kind:{type:'delete'}}]});
   const denied=o.permission(del.title,del.detail);
   assert.equal(c.permissions.length,1);assert.equal(c.permissions[0].standing,false);
   c.permission(c.permissions[0].id,false);
   assert.equal(await denied,false);
   return {text:'Проверено',denied:del.title,interrupted:false};
 });
 await c.setFlags({autoEdits:true,autoCommands:true});
 state.agents.find(a=>a.id==='codex').mode='execute';
 await c.send('Жека, сделай правку','codex');await c.idle();
 const note=state.messages.find(m=>/остановился: не разрешили Удаление файлов/.test(m.text));
 assert.ok(note.control);assert.equal(note.error,false);
});

test('Codex question arrays survive storage by id and secrets stay out of the feed',async t=>{
 let received;
 const {c,state,store}=await fixture(t,async o=>{
   received=await o.question([{id:'a',prompt:'Выбор?',multi:true,options:[]},{id:'b',prompt:'Ключ?',options:[],secret:true}]);
   return {text:'ok',interrupted:false};
 });
 await c.send('спроси','codex');
 while(!state.messages.some(m=>m.question))await new Promise(r=>setImmediate(r));
 const card=state.messages.find(m=>m.question);
 c.answer(card.question.id,{a:['первый, с запятой','свой','свой'],b:['secret-test']});await c.idle();
 assert.deepEqual(received,{a:['первый, с запятой','свой'],b:['secret-test']});
 const saved=(await store.load()).messages.find(m=>m.id===card.id);
 assert.deepEqual(saved.question.answered,{a:['первый, с запятой','свой'],b:['[скрыто]']});
 assert.doesNotMatch(messageText(saved),/secret-test/);
});
test('dismissing an agent question does not invent an Anton utterance',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const answers=await o.question([{prompt:'Цвет?',options:[{label:'синий'}]}]);
  assert.equal(answers,undefined);
  return {text:'ok',interrupted:false};
 });
 await c.send('спроси','claude');
 while(!state.messages.some(m=>m.question))await new Promise(r=>setImmediate(r));
 const card=state.messages.find(m=>m.question);
 c.answer(card.question.id,{});
 await c.idle();
 assert.equal(state.messages.filter(m=>m.author==='Антон').length,1);
 assert.equal(state.messages.find(m=>m.id===card.id).question,undefined);
});
test('an empty agent question is noted and does not hang the turn',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const answers=await o.question([]);
  assert.equal(answers,undefined);
  return {text:'ok',interrupted:false};
 });
 await c.send('спроси','claude');await c.idle();
 assert.ok(state.messages.some(m=>m.control&&/пустой вопрос/.test(m.text)));
 assert.equal(state.messages.filter(m=>m.question).length,0);
 assert.ok(state.messages.some(m=>m.author==='Колян'&&m.text==='ok'));
});
test('recovery drops a hanging agent question',async t=>{
 const {c,state,store,host}=await fixture(t);
 await c.send('queued','all');
 state.messages.push({id:'ask',author:'Колян',text:'Цвет?',
  question:{id:'r',items:[{prompt:'Цвет?',options:[{label:'синий'}]}]}});
 state.messages.push({id:'done',author:'Колян',text:'Форма?',
  question:{id:'s',items:[{prompt:'Форма?',options:[{label:'круг'}]}],answered:{'Форма?':'круг'}}});
 await c.save();
 const recovered=await store.load();
 const second=new Controller(recovered,store,host,async()=>{throw new Error('must not run');});
 await second.recover();
 assert.equal(recovered.messages.find(m=>m.id==='ask').question,undefined);
 assert.deepEqual(recovered.messages.find(m=>m.id==='done').question.answered,{'Форма?':'круг'});
 assert.ok(recovered.messages.some(m=>/Вопрос агента снят/.test(m.text)));
});


test('a later answer stays with its question when a new one arrived in between',async t=>{
 const {c,state}=await fixture(t);
 await c.send('FIRST_Q','all',['claude','codex']);await c.idle();
 const queued=state.queue[0];
 await c.send('SECOND_Q','claude');await c.idle();
 await c.handoff('codex',queued);await c.idle();
 const texts=state.messages.filter(m=>!m.control).map(m=>m.author+':'+m.text);
 assert.deepEqual(texts,['Антон:FIRST_Q','Колян:Ответ claude','Жека:Ответ codex','Антон:SECOND_Q','Колян:Ответ claude']);
});
test('agent instruction is the third prompt line, per person, and not in the feed',async t=>{
 const {c,state,runs}=await fixture(t);
 assert.equal(normalizeInstruction('  a\r\nb  '),'a\nb');
 assert.equal(agentPromptPrefix(state.agents[0],'discuss').split('\n').length,2);
 state.agents.find(a=>a.id==='claude').instruction='Отвечай кратко.';
 state.agents.forEach(a=>{a.enabled=true;});
 await c.send('вопрос','all',['claude','codex']);await c.idle();
 assert.equal(runs[0].prompt.split('\n')[2],'Отвечай кратко.');
 assert.match(runs[0].prompt,/Сейчас обсуждение/);
 assert.ok(!state.messages.some(m=>/Отвечай кратко/.test(m.text)));
 assert.equal(state.turns.find(t=>t.executor==='claude').instruction,'Отвечай кратко.');
 await c.handoff('codex');await c.idle();
 assert.doesNotMatch(runs[1].prompt,/Отвечай кратко/);
 assert.equal(state.turns.find(t=>t.executor==='codex').instruction,undefined);
 await c.reset('context','claude');
 assert.equal(state.agents.find(a=>a.id==='claude').instruction,'Отвечай кратко.');
 await c.configure({id:'claude',enabled:true,mode:'discuss',model:'',effort:''});
 assert.equal(state.agents.find(a=>a.id==='claude').instruction,'Отвечай кратко.');
 await c.configure({...state.agents.find(a=>a.id==='claude'),instruction:''});
 assert.equal(state.agents.find(a=>a.id==='claude').instruction,undefined);
 assert.equal(state.turns.find(t=>t.executor==='claude').instruction,'Отвечай кратко.');
});

test('the discuss switch keeps execute-mode cards from editing',async t=>{
 const {c,state,runs}=await fixture(t);
 state.agents.find(a=>a.id==='claude').mode='execute';
 await c.send('Колян, исправь файл','claude',[],[],true);await c.idle();
 assert.equal(runs[0].execute,false);
 assert.match(state.messages[0].text,/обсуждаем, код не трогать/);
 assert.match(runs[0].prompt,/Сейчас обсуждение/);
});
test('an extra opinion on an execution request is read-only and adds no invented human message',async t=>{
 const {c,state,runs}=await fixture(t);
 await c.send('Колян, исправь файл','all');await c.idle();
 assert.equal(runs[0].execute,true);
 await c.handoff('codex');await c.idle();
 assert.equal(runs[1].execute,false);
 assert.equal(state.messages.filter(m=>m.author==='Антон').length,1);
 assert.ok(runs[1].prompt.endsWith('Колян, исправь файл'));
});

test('reset save failure restores the original in-memory conversation and retains the archive',async t=>{
 const {c,state,store}=await fixture(t);
 await c.send('preserve','all');const before=structuredClone(state);
 store.save=async()=>{throw new Error('cannot save');};
 await assert.rejects(c.reset('context'),/cannot save/);
 assert.deepEqual(state,before);
 assert.equal((await fs.readdir(path.join(store.dir,'archives'))).length,1);
});


test('attachments stay separate in storage and reach each respondent exactly once',async t=>{
 const {c,state,runs,store}=await fixture(t);
 const attachment={id:'code',label:'sample.ts:1',text:'const UNIQUE_ATTACHMENT = 1;'};
 await c.send('Review this','all',['claude','codex'],[attachment]);await c.idle();
 assert.equal(state.messages[0].text,'Review this');
 assert.deepEqual(state.messages[0].attachments,[attachment]);
 assert.equal(runs[0].prompt.split('UNIQUE_ATTACHMENT').length-1,1);
 const stored=await store.load();assert.deepEqual(stored.messages[0].attachments,[attachment]);
 await c.handoff('codex',state.queue[0]);await c.idle();
 assert.equal(runs[1].prompt.split('UNIQUE_ATTACHMENT').length-1,1);
});

test('oversized attachment context fails before saving a turn or clearing a draft',async t=>{
 const {c,state,host,runs}=await fixture(t);
 host.limit=()=>20;state.draft='keep';state.draftAttachments=[{id:'a',label:'f',text:'x'.repeat(25)}];
 await assert.rejects(c.send('question','codex',[],state.draftAttachments),/превышают лимит/);
 assert.equal(state.messages.length,0);assert.equal(state.draft,'keep');
 assert.equal(state.draftAttachments.length,1);assert.equal(runs.length,0);
});

test('discarded questions stay in the feed as cancelled and enter later prompts marked and numbered',async t=>{
 const {c,state,runs}=await fixture(t);
 await c.send('DISCARDED_EY','all');
 assert.equal(state.queue.length,1);
 await c.discard(state.queue[0]);
 assert.equal(state.queue.length,0);
 assert.equal(state.messages[0].cancelled,true);
 assert.equal(state.messages[0].text,'DISCARDED_EY');
 await c.send('REAL_QUESTION','codex');await c.idle();
 assert.match(runs[0].prompt,/Антон #1 \[снят\]: DISCARDED_EY/);
 assert.match(runs[0].prompt,/REAL_QUESTION/);
 assert.equal(questionNumber(state.messages,state.turns,state.messages[0].id),1);
});
test('context numbers Anton questions from the shared function',()=>{
 const messages=[
  {id:'q1',author:'Антон',text:'one'},
  {id:'a1',author:'Колян',text:'ok'},
  {id:'q2',author:'Антон',text:'two',cancelled:true}
 ];
 const turns=[{messageId:'q1'},{messageId:'q2'}];
 assert.equal(questionNumber(messages,turns,'q1'),1);
 assert.equal(questionNumber(messages,turns,'q2'),2);
 const text=context([messages[2]],'now',64000,{messages,turns});
 assert.match(text,/Антон #2 \[снят\]: two/);
 assert.match(text,/Текущее поручение Антона:\nnow/);
});
test('reply marks are per author and reach the prompt',()=>{
 const {replyNumber,messageMark,context}=require('../dist/shared/model');
 const messages=[
  {id:'q',author:'Антон',text:'q'},
  {id:'k',author:'Колян',text:'one'},
  {id:'card',author:'Колян',text:'вопрос?'},
  {id:'z',author:'Жека',text:'two'},
  {id:'k2',author:'Колян',text:'three'},
  {id:'g',author:'Гриха',text:'four'}
 ];
 const turns=[
  {messageId:'q',replyId:'k'},
  {messageId:'q',replyId:'z'},
  {messageId:'q',replyId:'k2'},
  {messageId:'q',replyId:'g'}
 ];
 assert.equal(replyNumber(messages,turns,'k'),1);
 assert.equal(replyNumber(messages,turns,'k2'),2);
 assert.equal(replyNumber(messages,turns,'z'),1);
 assert.equal(replyNumber(messages,turns,'g'),1);
 assert.equal(replyNumber(messages,turns,'card'),0);
 assert.equal(messageMark(messages,turns,'q'),'#1');
 assert.equal(messageMark(messages,turns,'k'),'#К1');
 assert.equal(messageMark(messages,turns,'z'),'#Ж1');
 assert.equal(messageMark(messages,turns,'g'),'#Г1');
 const text=context(messages,'now',64000,{messages,turns});
 assert.match(text,/Антон #1: q/);
 assert.match(text,/Колян #К1: one/);
 assert.match(text,/Колян: вопрос\?/);
 assert.match(text,/Жека #Ж1: two/);
 assert.match(text,/Колян #К2: three/);
 assert.match(text,/Гриха #Г1: four/);
});
test('unapproved questions and attachments do not enter another question context',async t=>{
 const {c,state,runs}=await fixture(t);
 await c.send('PENDING_QUESTION','all',[],[{id:'old',label:'old.ts',text:'PENDING_CODE'}]);
 await c.send('Current question','codex');await c.idle();
 assert.equal(state.queue.length,1);
 assert.doesNotMatch(runs[0].prompt,/PENDING_QUESTION|PENDING_CODE/);
});

test('a resumed session receives only new feed, not the previous dump',async t=>{
 const {c,state,runs}=await fixture(t,withSession);
 await c.send('FIRST_UNIQUE_QUESTION','claude');await c.idle();
 await c.send('SECOND_UNIQUE_QUESTION','claude');await c.idle();
 assert.match(runs[0].prompt,/FIRST_UNIQUE_QUESTION/);
 assert.match(runs[1].prompt,/SECOND_UNIQUE_QUESTION/);
 assert.doesNotMatch(runs[1].prompt,/FIRST_UNIQUE_QUESTION/);
 assert.doesNotMatch(runs[1].prompt,/Ответ claude/);
 assert.equal(runs[1].session,'session-claude');
 assert.equal(state.sessions['claude:discuss'].through,state.messages.find(m=>m.author==='Колян'&&m.turn===state.turns[1].id).id);
});
for (const provider of ['claude','codex','grok']) {
 test('session cursor is saved for '+provider+' so a reload does not resend the whole feed',async t=>{
  const {c,state,store,host}=await fixture(t,withSession);
  for (const a of state.agents) a.enabled = a.id === provider;
  await c.send('FIRST_UNIQUE_QUESTION',provider);await c.idle();
  const key=provider+':discuss';
  assert.ok(state.sessions[key].through, key);
  const saved=await store.load();
  const runs2=[];
  const c2=new Controller(saved,store,host,async o=>{runs2.push(o);await o.onSession(o.session||'session-'+provider);return {text:'later',interrupted:false};});
  await c2.send('SECOND_UNIQUE_QUESTION',provider);await c2.idle();
  assert.doesNotMatch(runs2[0].prompt,/FIRST_UNIQUE_QUESTION/);
  assert.match(runs2[0].prompt,/SECOND_UNIQUE_QUESTION/);
  assert.equal(runs2[0].session,state.sessions[key].id);
 });
}
test('another participant still gets the full feed on their first turn',async t=>{
 const {c,state,runs}=await fixture(t,withSession);
 await c.send('SHARED_QUESTION','claude');await c.idle();
 await c.handoff('codex');await c.idle();
 assert.match(runs[1].prompt,/SHARED_QUESTION/);
 assert.match(runs[1].prompt,/Ответ claude/);
 assert.equal(runs[1].session,undefined);
 assert.equal(state.sessions['codex:discuss'].id,'session-codex');
});
test('an engine that compacted itself gets the whole feed again, not a delta',async t=>{
 const {c,state,runs}=await fixture(t,async o=>{
  await o.onSession('session-'+o.provider);
  // The engine drops part of its own history mid-turn and says so.
  if(o.prompt.includes('SECOND_UNIQUE_QUESTION')) o.compacted();
  return {text:'Ответ '+o.provider,interrupted:false};
 });
 await c.send('FIRST_UNIQUE_QUESTION','claude');await c.idle();
 await c.send('SECOND_UNIQUE_QUESTION','claude');await c.idle();
 assert.equal(state.sessions['claude:discuss'].through,undefined);
 await c.send('THIRD_UNIQUE_QUESTION','claude');await c.idle();
 assert.match(runs[2].prompt,/FIRST_UNIQUE_QUESTION/);
 assert.match(runs[2].prompt,/THIRD_UNIQUE_QUESTION/);
 assert.equal(runs[2].session,'session-claude');
 assert.ok(state.messages.some(m=>m.author==='Trio'&&/автосжатие контекста/.test(m.text)));
});

test('manual compaction drops the cursor too, for every participant',async t=>{
 for (const provider of ['claude','codex','grok']) {
  const {c,state}=await fixture(t,withSession);
  for (const a of state.agents) a.enabled = a.id === provider;
  await c.send('FIRST_UNIQUE_QUESTION',provider);await c.idle();
  const key=provider+':discuss';
  assert.ok(state.sessions[key].through,key);
  await c.compact(provider);
  assert.equal(state.sessions[key].through,undefined,key);
 }
});

test('a turn that died without an answer keeps the question in the next prompt',async t=>{
 let fail=false;
 const {c,state,runs}=await fixture(t,async o=>{
  await o.onSession('session-'+o.provider);
  // A limit ends the turn with no text at all: the engine never saw this prompt through.
  if(fail) return {text:'',error:'You have hit your limit',interrupted:false};
  return {text:'Ответ '+o.provider,interrupted:false};
 });
 await c.send('FIRST_UNIQUE_QUESTION','claude');await c.idle();
 const settled=state.sessions['claude:discuss'].through;
 fail=true;
 await c.send('LOST_UNIQUE_QUESTION','claude');await c.idle();
 assert.equal(state.sessions['claude:discuss'].through,settled);
 fail=false;
 await c.send('NEXT_UNIQUE_QUESTION','claude');await c.idle();
 assert.match(runs[2].prompt,/LOST_UNIQUE_QUESTION/);
 assert.doesNotMatch(runs[2].prompt,/FIRST_UNIQUE_QUESTION/);
});

test('attachment-only messages are valid and resetting context excludes old attached content',async t=>{
 const {c,state,runs}=await fixture(t);
 await c.send('','codex',[],[{id:'a',label:'f',text:'PRIVATE_OLD_CODE'}]);await c.idle();
 assert.match(runs[0].prompt,/PRIVATE_OLD_CODE/);
 await c.reset('context');
 await c.send('new','codex');await c.idle();
 assert.doesNotMatch(runs[1].prompt,/PRIVATE_OLD_CODE/);
 assert.equal(runs[1].session,undefined);
 assert.equal(state.messages[0].attachments.length,1);
});

test('every new post is stamped, and the stamp survives a save and load',async t=>{
 const {c,state,store}=await fixture(t);
 const before=Date.now();
 await c.send('Колян, посмотри проект','claude');await c.idle();
 const after=Date.now();
 const question=state.messages.find(m=>m.author==='Антон');
 const reply=state.messages.find(m=>m.author==='Колян');
 for(const m of [question,reply]){
  assert.equal(typeof m.at,'number',m.author+' без времени');
  assert.ok(m.at>=before&&m.at<=after,m.author+' со временем вне хода');
 }
 c.note('служебная строка',false,true);
 assert.equal(typeof state.messages.at(-1).at,'number','служебная строка без времени');
 await store.save(state);
 const loaded=await store.load();
 assert.equal(loaded.messages.find(m=>m.author==='Антон').at,question.at);
});

test('Codex quoted PowerShell uses auto-command flags, while deletion still opens permission',async t=>{
 const {codexApproval}=require('../dist/providers/codexProtocol');
 for(const [autoCommands,mode] of [[true,'execute'],[false,'execute'],[true,'discuss']]){
  const prompted=[];
  const {c,state}=await fixture(t,async o=>{
   const script="$layout = @'\nconst q = $('question-body');\nconst label = \"it's literal\";\n'@\n$layout | node";
   const results=[];
   for(const body of [script,script+'\nRemove-Item a.txt']){
    const command="powershell.exe -Command '"+body.replaceAll("'","'\"'\"'")+"'";
    const {title,detail}=codexApproval('item/commandExecution/requestApproval',{command});
    const decision=o.permission(title,detail);
    prompted.push(c.permissions.length);
    if(c.permissions.length)c.permission(c.permissions[0].id,false);
    results.push(await decision);
   }
   return {text:results.join('/'),interrupted:false};
  });
  await c.setFlags({autoEdits:true,autoCommands});
  state.agents.find(a=>a.id==='codex').mode=mode;
  await c.send('Жека, проверка разрешения','codex');await c.idle();
  const allow=autoCommands&&mode==='execute';
  assert.deepEqual(prompted,[allow?0:1,1]);
  assert.equal(state.messages.find(m=>m.author==='Жека').text,allow?'true/false':'false/false');
 }
});
