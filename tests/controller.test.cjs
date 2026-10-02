const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {Controller} = require('../dist/orchestrator/controller');
const {Store} = require('../dist/storage/store');
const {fresh, addressed, assignedMode, input, riskyPermission, permissionClass, permissionSignature, permissionCaption, diskImagePath, plainAttachment, context, contextFit, questionNumber, messageText, agentPromptPrefix, passLine, passMarks, providersFromMarks, rewritePassNames, syncPassMarks, placeDiscussLine, instructionLimit, normalizeInstruction, summaryPrompt, summaryComfort, dangerCover, privilegeIds, privilegeJournalHit, privilegeJournalFile} = require('../dist/shared/model');
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
  state.agents.find(a=>a.id==='claude').mode='execute';
  await c.send('Колян, исправь README','all');await c.idle();
  assert.equal(runs[0].provider,'claude');assert.equal(runs[0].execute,true);assert.equal(snapshots,1);
  assert.equal(state.turns[0].snapshot,'snapshot');
  assert.equal(addressed('Пример: «Колян, делай»'),undefined);
  assert.equal(assignedMode('Что значит «делай»?', 'discuss'),'discuss');
  assert.equal(assignedMode('Колян, делай файл','discuss'),'discuss');
  assert.equal(assignedMode('проверь проект','execute'),'execute');
  assert.equal(assignedMode('Колян, исправь файл. обсуждаем, код не трогать','execute'),'execute');
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
 assert.deepEqual(dangerCover('Execute git', JSON.stringify({kind:'execute',rawInput:{command:'git commit -m x'}})),{needs:['git'],safeCommand:false});
 assert.deepEqual(dangerCover('Execute chain', JSON.stringify({kind:'execute',rawInput:{command:'git add x && git commit -m x'}})),{needs:['git'],safeCommand:true});
 assert.deepEqual(dangerCover('Execute mix', JSON.stringify({kind:'execute',rawInput:{command:'rm a && curl https://example.test'}})),{needs:['network','shell'],safeCommand:false});
 assert.deepEqual(dangerCover('Execute broken', JSON.stringify({kind:'execute',rawInput:{command:"echo 'oops"}})),{needs:['unparsed'],safeCommand:false});
 assert.deepEqual(dangerCover('Выполнение команды', JSON.stringify({command:'powershell -EncodedCommand cgBtACAALQByACAAeAA=',kind:'danger'})),{needs:['unparsed'],safeCommand:false});
 assert.deepEqual(dangerCover('Выполнение команды', JSON.stringify({command:'',kind:'danger'})),{needs:['unparsed'],safeCommand:false});
 assert.deepEqual(dangerCover('Web Fetch', JSON.stringify({kind:'web_fetch'})),{needs:['network'],safeCommand:false});
 assert.deepEqual(dangerCover('Изменение файлов', JSON.stringify({type:'delete',path:'a.ts'})),{needs:['delete'],safeCommand:false});
 assert.deepEqual(dangerCover('mcp__other__tool', '{}'),{needs:['other'],safeCommand:false});
 assert.equal(dangerCover('Execute tsc', JSON.stringify({kind:'execute',rawInput:{command:'node --test tests'}})),undefined);
 assert.equal(dangerCover('Read file', JSON.stringify({kind:'read'})),undefined);
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
  assert.deepEqual(input({type:'copy',text:'план',clientId:'c'}),{type:'copy',text:'план'});
  assert.equal(input({type:'copy',text:'x'.repeat(20001)}),undefined);
  assert.equal(input({type:'copy'}),undefined);
  assert.equal(input({type:'permission',requestId:4,allow:true}),undefined);
  assert.equal(input({type:'answer',requestId:'x',answers:{q:'y'.repeat(2001)}}),undefined);
  assert.equal(input({type:'answer',requestId:'x',answers:Object.fromEntries([...Array(9)].map((_,i)=>['q'+i,'a']))}),undefined);
  assert.ok(input({type:'answer',requestId:'x',answers:{q:'ok'}}));
});

test('stop while preparing does not wait for a save dialog or start a CLI',async t=>{
 const {c,host,runs,state}=await fixture(t);
 let prepared;const ready=new Promise(r=>prepared=r);
 let release;host.prepare=async()=>{prepared();return new Promise(r=>release=r);};
 state.agents.find(a=>a.id==='claude').mode='execute';
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
 state.agents.find(a=>a.id==='claude').mode='execute';
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
 await assert.rejects(c.send('invalid','all',['codex','codex','codex','codex']),/Не больше 3/);
 assert.equal(state.messages.length,before);
});

test('second numbered answer cannot start first when the whole group is waiting',async t=>{
 const {c,state}=await fixture(t);
 // Hold an unrelated run in preparation while the group is queued.
 let release,ready; const preparing=new Promise(r=>ready=r);
 c.host.prepare=async()=>{ready();return new Promise(r=>release=r);};
 state.agents.find(a=>a.id==='claude').mode='execute';
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
 assert.ok(input({type:'send',text:'x',recipient:'all',responseOrder:['codex','codex']}));
 assert.ok(input({type:'send',text:'x',recipient:'all',responseOrder:Array(10).fill('codex')}));
 assert.equal(input({type:'send',text:'x',recipient:'all',responseOrder:Array(11).fill('codex')}),undefined);
 assert.equal(input({type:'send',text:'x',recipient:'all',responseOrder:['other']}),undefined);
 assert.equal(input({type:'send',text:'x',recipient:'all',conversationId:4}),undefined);
 assert.equal(input({type:'reset',mode:'delete-files'}),undefined);
 assert.ok(input({type:'reset',mode:'context'}));
 assert.ok(input({type:'fresh-summary',provider:'claude'}));
 assert.equal(input({type:'fresh-summary',provider:'both'}),undefined);
 assert.ok(input({type:'feed-max',count:1050}));
 assert.equal(input({type:'feed-max',count:0}),undefined);
 assert.equal(input({type:'feed-max',count:1.5}),undefined);
 assert.ok(input({type:'usage',provider:'grok'}));
 assert.equal(input({type:'usage',provider:'other'}),undefined);
 assert.ok(input({type:'project'}));
 assert.ok(input({type:'plugin-settings'}));
 assert.ok(input({type:'open-image',id:'abc.png'}));
 assert.equal(input({type:'open-image',id:1}),undefined);
 assert.equal(diskImagePath('Изображение на диске: C:/store/images/abc.png\nОткрой его'),'C:/store/images/abc.png');
 assert.equal(plainAttachment({id:'a',label:'x',text:'t',preview:'webview://x'}).preview,undefined);
 assert.ok(input({type:'flags',autoReply:true,autoEdits:true,autoCommands:false}));
 assert.ok(input({type:'flags',privilegeOn:true,privileges:['git','shell']}));
 assert.equal(input({type:'flags',privileges:['git','git']}),undefined);
 assert.equal(input({type:'flags',privileges:['nope']}),undefined);
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
test('pause lets the running agent finish, keeps the queue on disk, and Продолжить starts the next',async t=>{
 let release;const hold=new Promise(r=>release=r);let first=true;
 const {c,state,runs,store}=await fixture(t,async o=>{
  if(first){first=false;await hold;}
  return {text:'ok '+o.provider,interrupted:false};
 });
 await c.setFlags({autoReply:true});
 await c.send('первый','claude');
 await c.send('второй','codex');
 await c.pause(true);
 release();await c.idle();
 assert.equal(runs.length,1,'the next one does not start during a pause');
 assert.equal(state.turns[0].status,'completed','the running agent finished normally');
 assert.equal((await store.load()).paused,true,'pause survives a reload');
 await assert.rejects(c.handoff('codex',state.queue[0]),/паузе/);
 await c.pause(false);await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['claude','codex']);
 assert.equal(state.paused,false);
});
test('cancelling a pause before the turn ends lets auto-reply carry on',async t=>{
 let release;const hold=new Promise(r=>release=r);let first=true;
 const {c,runs}=await fixture(t,async o=>{
  if(first){first=false;await hold;}
  return {text:'ok',interrupted:false};
 });
 await c.setFlags({autoReply:true});
 await c.send('первый','claude');await c.send('второй','codex');
 await c.pause(true);await c.pause(false);
 assert.equal(runs.length,1,'Отменить паузу does not start anyone while a turn runs');
 release();await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['claude','codex']);
});
test('Продолжить without a pause restarts a queue stopped by Стоп одному',async t=>{
 let started;const ready=new Promise(r=>started=r);let first=true;
 const {c,runs}=await fixture(t,async o=>{
  if(first){first=false;started();await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));return {text:'x',interrupted:true};}
  return {text:'ok',interrupted:false};
 });
 await c.setFlags({autoReply:true});
 await c.send('всем','all',['claude','codex']);await ready;
 await c.stop('claude');await c.idle();
 assert.equal(runs.length,1);
 await c.pause(false);await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['claude','codex']);
});
test('a question sent during a pause goes first as a whole cycle and ends the pause',async t=>{
 let release;const hold=new Promise(r=>release=r);let first=true;
 const {c,state,runs}=await fixture(t,async o=>{
  if(first){first=false;await hold;}
  return {text:'ok '+o.provider,interrupted:false};
 });
 await c.setFlags({autoReply:true});
 await c.send('сценарий','claude');
 await c.send('дальше по сценарию','codex');
 await c.pause(true);
 await c.send('поправка','all',['codex','claude']);
 assert.equal(state.paused,false);
 const order=state.queue.map(id=>state.turns.find(t=>t.id===id));
 assert.deepEqual(order.map(t=>t.recipient),['codex','claude','codex']);
 assert.deepEqual(order.map(t=>t.cycle),[2,2,3],'cycles follow the new order');
 release();await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['claude','codex','claude','codex']);
 assert.match(runs[1].prompt,/поправка$/);
});
test('a question sent during a pause waits for the rest of the started one and goes before the untouched',async t=>{
 let release;const hold=new Promise(r=>release=r);let first=true;
 const {c,state,runs}=await fixture(t,async o=>{
  if(first){first=false;await hold;}
  return {text:'ok '+o.provider,interrupted:false};
 });
 await c.setFlags({autoReply:true});
 await c.send('сценарий','all',['codex','claude','codex']);
 await c.send('дальше','codex');
 await c.pause(true);
 await c.send('поправка','claude');
 const order=state.queue.map(id=>state.turns.find(t=>t.id===id));
 const text=t=>state.messages.find(m=>m.id===t.messageId).text;
 assert.deepEqual(order.map(text),['сценарий','сценарий','поправка','дальше']);
 assert.deepEqual(order.map(t=>t.cycle),[1,1,2,3],'cycles follow the launch order');
 release();await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['codex','claude','codex','claude','codex']);
});
test('each step of a chain is told its pass, a repeat keeps its own place, a single answer is not',async t=>{
 const {c,state,runs}=await fixture(t,async o=>({text:'ok '+o.provider,interrupted:false}));
 await c.setFlags({autoReply:true});
 await c.send('по проходам','all',['codex','claude','codex']);await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['codex','claude','codex']);
 const own = n => 'Твой проход — ' + n + ' из 3. Выполни задание этого прохода, учитывая общие указания сообщения.';
 assert.match(runs[0].prompt, new RegExp('^' + own(1).replace(/[.]/g, '\\.') + '$', 'm'));
 assert.match(runs[1].prompt, new RegExp('^' + own(2).replace(/[.]/g, '\\.') + '$', 'm'));
 assert.match(runs[2].prompt, new RegExp('^' + own(3).replace(/[.]/g, '\\.') + '$', 'm'));
 assert.equal(own(2).includes('['), false);
 assert.deepEqual(state.turns.map(t=>t.pass),[1,2,3]);
 await c.send('один','claude');await c.idle();
 assert.doesNotMatch(runs[3].prompt,/Проход/);
 assert.doesNotMatch(runs[3].prompt,/Твой проход/);
});
test('one recipient with three marks is told pass 1 of 3',async t=>{
 const {c,state,runs}=await fixture(t,async()=>({text:'ok',interrupted:false}));
 await c.setFlags({autoReply:true});
 const text='[Проход 1 из 3: Колян]\nа\n[Проход 2 из 3: Жека]\nб\n[Проход 3 из 3: Гриха]\nв';
 await c.send(text,'claude');await c.idle();
 assert.equal(state.turns.length,1);
 assert.equal(state.turns[0].pass,1);
 assert.match(runs[0].prompt,/^Твой проход — 1 из 3\. Выполни задание этого прохода, учитывая общие указания сообщения\.$/m);
});
test('a step removed after send keeps the pass number; the line is not renumbered',()=>{
 const chain=[
  {id:'a',messageId:'m',recipient:'grok',status:'completed',executor:'grok',pass:1},
  {id:'b',messageId:'m',recipient:'claude',status:'interrupted',pass:2},
  {id:'c',messageId:'m',recipient:'grok',status:'proposed',pass:3},
 ];
 const line = n => 'Твой проход — ' + n + ' из 3. Выполни задание этого прохода, учитывая общие указания сообщения.';
 assert.equal(passLine(chain[2],chain),line(3));
 assert.equal(passLine(chain[0],chain),line(1));
 chain[1].executor='claude';
 assert.equal(passLine(chain[2],chain),line(3));
 assert.equal(passLine(chain[1],chain),line(2));
 assert.equal(passLine({id:'only',messageId:'m',recipient:'grok',pass:1},[{id:'only',messageId:'m',recipient:'grok',pass:1}]),'');
 const marked='[Проход 1 из 3: Колян]\nа\n[Проход 2 из 3: Жека]\nб\n[Проход 3 из 3: ?]\nв';
 const two=[
  {id:'a',messageId:'m',recipient:'claude',pass:1},
  {id:'b',messageId:'m',recipient:'codex',pass:2},
 ];
 assert.equal(passLine(two[0],two,marked),'Твой проход — 1 из 3. Выполни задание этого прохода, учитывая общие указания сообщения.');
});
test('pass marks are whole lines only, and chip order rewrites names without touching numbers',()=>{
 const text = 'смотри [Проход 1 из 2: Колян]\n[Проход 1 из 2: Колян]\nсделай\n[Проход 2 из 2: Жека]\n[Проход 11 из 2: Гриха]\n[Проход 10 из 10: Гриха]\n  [Проход 3 из 2: Колян]\n[Проход 3 из 3: ?]';
 assert.equal(passMarks('[Проход 1: Колян]').length,0);
 assert.deepEqual(passMarks(text).map(m=>[m.pass,m.name,m.line]),[[1,'Колян',1],[2,'Жека',3],[10,'Гриха',5],[3,'?',7]]);
 assert.deepEqual(providersFromMarks('[Проход 1 из 2: ?]\r\n[Проход 2 из 2: Гриха]'),[]);
 assert.deepEqual(providersFromMarks('[Проход 2 из 2: Жека]\n[Проход 1 из 2: Колян]'),['claude','codex']);
 assert.deepEqual(providersFromMarks('[Проход 1 из 3: Колян]\n[Проход 3 из 3: Гриха]'),['claude']);
 assert.deepEqual(passMarks('[Проход 1 из 1: ?]\r\nдальше').map(m=>m.pass),[1]);
 const body = '[Проход 1 из 2: Колян]\nсделай\n[Проход 2 из 2: Жека]\nпроверь\n[Проход 4 из 4: Гриха]\nещё';
 assert.equal(rewritePassNames(body,['grok','claude']),
  '[Проход 1 из 4: Гриха]\nсделай\n[Проход 2 из 4: Колян]\nпроверь\n[Проход 4 из 4: ?]\nещё');
 assert.equal(rewritePassNames('без меток',['claude']),'без меток');
 assert.equal(rewritePassNames(body,['claude','codex','grok']),
  '[Проход 1 из 4: Колян]\nсделай\n[Проход 2 из 4: Жека]\nпроверь\n[Проход 4 из 4: ?]\nещё');
 const gapped = '[Проход 1 из 3: Колян]\nдело\n[Проход 3 из 3: Гриха]\nещё';
 assert.equal(rewritePassNames(gapped,['claude','codex','grok']),gapped);
 assert.equal(rewritePassNames(gapped,['codex','claude','grok']),
  '[Проход 1 из 3: Жека]\nдело\n[Проход 3 из 3: Гриха]\nещё');
 assert.equal(rewritePassNames(gapped,['claude','grok','codex']),
  '[Проход 1 из 3: Колян]\nдело\n[Проход 3 из 3: Жека]\nещё');
 const intro='общие указания';
 const added=syncPassMarks(intro,['claude','grok'],'add');
 assert.equal(added,'общие указания\n\n[Проход 1 из 2: Колян]\n\n[Проход 2 из 2: Гриха]\n');
 const third=syncPassMarks(added,['claude','grok','codex'],'add');
 assert.equal(third,'общие указания\n\n[Проход 1 из 3: Колян]\n\n[Проход 2 из 3: Гриха]\n\n[Проход 3 из 3: Жека]\n');
 assert.equal(syncPassMarks(third,['claude','grok'],'drop'),
  'общие указания\n\n[Проход 1 из 2: Колян]\n\n[Проход 2 из 2: Гриха]\n');
 assert.equal(syncPassMarks(third.replace('\n[Проход 3 из 3: Жека]\n','\n[Проход 3 из 3: Жека]\nещё'),['claude','grok'],'drop'),
  'общие указания\n\n[Проход 1 из 3: Колян]\n\n[Проход 2 из 3: Гриха]\n\n[Проход 3 из 3: ?]\nещё');
 assert.equal(syncPassMarks(added,[], 'clear'),
  'общие указания\n\n[Проход 1 из 2: ?]\n\n[Проход 2 из 2: ?]\n');
 assert.equal(syncPassMarks('обычное',['claude'],'add'),'обычное');
 assert.equal(syncPassMarks('[Проход 1 из 2: Колян]\n\n[Проход 2 из 2: Жека]\n',['claude'],'drop'),'');
 const hole='[Проход 1 из 2: Колян]\nа\n[Проход 3 из 3: Гриха]\nб';
 assert.equal(syncPassMarks(hole,['claude','codex','grok'],'names'),
  '[Проход 1 из 3: Колян]\nа\n[Проход 3 из 3: Гриха]\nб');
 assert.equal(syncPassMarks(hole,['claude','codex','grok'],'add'),
  '[Проход 1 из 3: Колян]\nа\n[Проход 3 из 3: Гриха]\nб');
 assert.equal(syncPassMarks(hole,['claude','codex','grok','claude'],'add'),
  '[Проход 1 из 4: Колян]\nа\n[Проход 3 из 4: Гриха]\nб\n\n[Проход 4 из 4: Колян]\n');
 assert.equal(placeDiscussLine('исправь файл'),'исправь файл\n\nобсуждаем, код не трогать');
 assert.equal(placeDiscussLine('уже обсуждаем'),'уже обсуждаем');
 assert.equal(placeDiscussLine('общие указания\n\n[Проход 1 из 2: Колян]\nсделай\n\n[Проход 2 из 2: Жека]\nпроверь'),
  'общие указания\n\nобсуждаем, код не трогать\n\n[Проход 1 из 2: Колян]\nсделай\n\n[Проход 2 из 2: Жека]\nпроверь');
 assert.equal(placeDiscussLine('[Проход 1 из 2: Колян]\nа\n\n[Проход 2 из 2: Жека]\nб'),
  'обсуждаем, код не трогать\n\n[Проход 1 из 2: Колян]\nа\n\n[Проход 2 из 2: Жека]\nб');
 assert.equal(placeDiscussLine('общие\n\n[Проход 1 из 2: Колян]\nсделай\n\n[Проход 2 из 2: Жека]\nкод не трогать'),
  'общие\n\nобсуждаем, код не трогать\n\n[Проход 1 из 2: Колян]\nсделай\n\n[Проход 2 из 2: Жека]\nкод не трогать');
 assert.equal(placeDiscussLine('[Проход 1 из 2: Колян]\nа\n\n[Проход 2 из 2: Жека]\nтут обсуждаем детали'),
  'обсуждаем, код не трогать\n\n[Проход 1 из 2: Колян]\nа\n\n[Проход 2 из 2: Жека]\nтут обсуждаем детали');
 assert.equal(placeDiscussLine('обсуждаем\n\n[Проход 1 из 2: Колян]\nа\n\n[Проход 2 из 2: Жека]\nб'),
  'обсуждаем\n\n[Проход 1 из 2: Колян]\nа\n\n[Проход 2 из 2: Жека]\nб');
});
test('a waiting question is edited, moved and removed; a started one is not',async t=>{
 let release;const hold=new Promise(r=>release=r);let first=true;
 const {c,state}=await fixture(t,async o=>{
  if(first){first=false;await hold;}
  return {text:'ok',interrupted:false};
 });
 await c.send('A','all',['claude','codex']);
 await c.send('B','codex');
 await c.send('C','claude');
 const id=text=>state.messages.find(m=>m.text===text).id;
 const order=()=>[...new Set(state.queue.map(q=>state.turns.find(t=>t.id===q).messageId))].map(m=>state.messages.find(x=>x.id===m).text);
 await assert.rejects(c.editQueued(id('A'),'A2'),/не начали отвечать/);
 await c.editQueued(id('B'),'B2');
 assert.equal(state.messages.find(m=>m.id===id('B2')).text,'B2');
 await assert.rejects(c.editQueued(id('C'),'   '),/Пустой вопрос/);
 await assert.rejects(c.moveQueued(id('A')),/не начали отвечать/);
 await c.moveQueued(id('C'),id('A'));
 assert.deepEqual(order(),['A','C','B2'],'the started question stays on top');
 assert.deepEqual(state.queue.map(q=>state.turns.find(t=>t.id===q).cycle),[1,2,3]);
 await c.moveQueued(id('C'));
 assert.deepEqual(order(),['A','B2','C']);
 await c.removeQueued(id('B2'));
 assert.deepEqual(order(),['A','C']);
 assert.equal(state.messages.find(m=>m.text==='B2').cancelled,true);
 assert.deepEqual(state.queue.map(q=>state.turns.find(t=>t.id===q).cycle),[1,2]);
 await c.removeQueued(id('A'));
 assert.deepEqual(order(),['C'],'remaining steps of a started question are dropped');
 assert.notEqual(state.messages.find(m=>m.text==='A').cancelled,true,'it was answered, so it is not struck out');
 release();await c.idle();
});
test('queue and pause messages from the panel are validated',()=>{
 assert.ok(input({type:'pause',on:true}));
 assert.equal(input({type:'pause',on:'yes'}),undefined);
 assert.ok(input({type:'queue-edit',messageId:'m',text:'x'}));
 assert.equal(input({type:'queue-edit',messageId:'m'}),undefined);
 assert.ok(input({type:'queue-move',messageId:'m'}));
 assert.ok(input({type:'queue-move',messageId:'m',before:'n'}));
 assert.equal(input({type:'queue-move',messageId:'m',before:3}),undefined);
 assert.ok(input({type:'queue-remove',messageId:'m'}));
 assert.ok(input({type:'layout',side:'right',width:400,agentsFolded:true,queueFolded:false}));
 assert.equal(input({type:'layout',side:'right',width:400,agentsFolded:'да'}),undefined);
 assert.equal(input({type:'layout',side:'right',width:400,draftHeight:64}).draftHeight,64);
 assert.equal(input({type:'layout',side:'right',width:400,draftHeight:4000}).draftHeight,4000);
 assert.equal(input({type:'layout',side:'right',width:400,draftHeight:63.9}),undefined);
 assert.equal(input({type:'layout',side:'right',width:400,draftHeight:4000.1}),undefined);
 assert.equal(input({type:'layout',side:'right',width:400,draftHeight:10}),undefined);
 assert.equal(input({type:'layout',side:'right',width:400,draftHeight:'120'}),undefined);
 assert.ok(input({type:'layout',side:'right',width:400}));
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
test('a failed turn inside a chain starts the next agent with the Trio reason',async t=>{
 let n=0;
 const {c,state,runs}=await fixture(t,async()=>{
  n++;
  if(n===1)return {text:'',error:'лимит окна',interrupted:false};
  return {text:'дальше',interrupted:false};
 });
 await c.setFlags({autoReply:true});
 await c.send('всем','all',['claude','codex']);await c.idle();
 assert.equal(runs.length,2);
 assert.match(runs[1].prompt,/лимит окна/);
 assert.equal(state.turns[0].status,'failed');
 assert.equal(state.turns[1].status,'completed');
});
test('a denied permission inside a chain starts the next agent with the Trio line',async t=>{
 let n=0;
 const {c,runs}=await fixture(t,async()=>{
  n++;
  if(n===1)return {text:'x',interrupted:false,denied:'Bash'};
  return {text:'дальше',interrupted:false};
 });
 await c.setFlags({autoReply:true});
 await c.send('всем','all',['claude','codex']);await c.idle();
 assert.equal(runs.length,2);
 assert.match(runs[1].prompt,/не разрешили Bash/);
});
test('a failed turn does not start the next message',async t=>{
 const {c,state,runs}=await fixture(t,async()=>({text:'',error:'лимит',interrupted:false}));
 await c.setFlags({autoReply:true});
 await c.send('первый','claude');
 await c.send('второй','codex');
 await c.idle();
 assert.equal(runs.length,1);
 assert.equal(state.turns.find(t=>t.recipient==='codex').status,'proposed');
});
test('a repeated agent in one chain is its own turn and sees the previous answer',async t=>{
 const {c,state,runs}=await fixture(t,withSession);
 await c.setFlags({autoReply:true});
 await c.send('всем','all',['codex','claude','codex']);await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['codex','claude','codex']);
 assert.equal(state.turns.length,3);
 assert.equal(runs[2].session,'session-codex');
 assert.match(runs[2].prompt,/Ответ claude/);
});
test('the responder ceiling comes from the host',async t=>{
 const {c,host,state}=await fixture(t);
 host.maxResponders=()=>2;
 await assert.rejects(c.send('x','all',['claude','codex','grok']),/Не больше 2/);
 await c.send('двое','all',['claude','codex']);await c.idle();
 assert.equal(state.turns.length,2);
});
test('a stored ceiling above 10 is cut to 10',async t=>{
 const {c,host}=await fixture(t);
 host.maxResponders=()=>12;
 await assert.rejects(c.send('x','all',Array(11).fill('claude')),/Не больше 10/);
});
test('a draft order longer than three loads trimmed instead of failing',async t=>{
 const {store,state}=await fixture(t);
 await store.save(state);
 const file=path.join(store.dir,'state.json');
 const disk=JSON.parse(await fs.readFile(file,'utf8'));
 disk.responseOrder=[...Array(13).fill('codex'),'nope'];
 await fs.writeFile(file,JSON.stringify(disk));
 const loaded=await store.load();
 assert.equal(loaded.responseOrder.length,10);
 assert.ok(loaded.responseOrder.every(p=>p==='codex'));
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
 state.agents.find(a=>a.id==='claude').mode='execute';
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
 state.agents.find(a=>a.id==='claude').mode='execute';
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
test('privileges allow a checked git commit and still ask for an unchecked delete',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const git=await o.permission('Execute git',JSON.stringify({kind:'execute',rawInput:{command:'git commit -m x'}}));
  const pending=o.permission('Bash','rm -rf build');
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  c.permission(c.permissions[0].id,false);
  const removed=await pending;
  return {text:String(git)+'/'+String(removed),interrupted:false};
 });
 await c.setFlags({privilegeOn:true,privileges:['git']});
 state.agents.find(a=>a.id==='claude').mode='execute';
 await c.send('Колян, делай коммит','claude');await c.idle();
 assert.equal(state.turns[0].mode,'execute');
 assert.ok(state.messages.some(m=>m.text==='Автопривилегии: Колян'));
 assert.ok(state.messages.some(m=>/Отказано/.test(m.text)&&/Bash/.test(m.text)));
 assert.equal(state.messages.find(m=>m.author==='Колян').text,'true/false');
});
test('a chain of an ordinary command and git needs both the checkbox and auto-commands',async t=>{
 const detail=JSON.stringify({kind:'execute',rawInput:{command:'npm test && git commit -m x'}});
 const once=async(privileges,autoCommands)=>{
  const {c,state}=await fixture(t,async o=>{
   const decision=o.permission('Execute chain',detail);
   if(c.permissions.length)c.permission(c.permissions[0].id,false);
   return {text:String(await decision),interrupted:false};
  });
  await c.setFlags({privilegeOn:true,privileges,autoCommands});
  state.agents.find(a=>a.id==='claude').mode='execute';
  await c.send('Колян, делай цепочку','claude');await c.idle();
  return state.messages.find(m=>m.author==='Колян').text;
 };
 assert.equal(await once(['git'],false),'false');
 assert.equal(await once(['git'],true),'true');
});
test('privileges do not skip a danger request while the turn is in read mode',async t=>{
 const {c,state}=await fixture(t,async o=>{
  const decision=o.permission('Execute git',JSON.stringify({kind:'execute',rawInput:{command:'git push'}}));
  if(c.permissions.length)c.permission(c.permissions[0].id,false);
  return {text:String(await decision),interrupted:false};
 });
 await c.setFlags({privilegeOn:true,privileges:[...privilegeIds]});
 await c.send('Колян, посмотри и не трогай','claude');await c.idle();
 assert.equal(state.turns[0].mode,'discuss');
 assert.equal(state.messages.find(m=>m.author==='Колян').text,'false');
 assert.equal(state.messages.some(m=>m.text==='Автопривилегии: Колян'),false);
});
test('stop everyone turns auto-reply off and leaves privileges on',async t=>{
 const {c,state,store}=await fixture(t);
 await c.setFlags({autoReply:true,privilegeOn:true,privileges:['git','shell']});
 await c.stop();
 assert.equal(state.autoReply,false);
 assert.equal(state.privilegeOn,true);
 assert.deepEqual(state.privileges,['git','shell']);
 const loaded=await store.load();
 assert.equal(loaded.privilegeOn,true);
 assert.deepEqual(loaded.privileges,['git','shell']);
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
test('the discuss line sits above the first pass mark',async t=>{
 const {c,state,runs}=await fixture(t,async()=>({text:'ok',interrupted:false}));
 await c.setFlags({autoReply:true});
 state.agents.forEach(a=>{a.enabled=true;});
 const text='общие указания\n\n[Проход 1 из 2: Колян]\nсделай\n\n[Проход 2 из 2: Жека]\nпроверь';
 await c.send(text,'all',['claude','codex'],[],true);await c.idle();
 const saved=state.messages[0].text;
 assert.equal(saved,'общие указания\n\nобсуждаем, код не трогать\n\n[Проход 1 из 2: Колян]\nсделай\n\n[Проход 2 из 2: Жека]\nпроверь');
 assert.equal(runs.length,2);
 for (const run of runs) {
  const note=run.prompt.indexOf('обсуждаем, код не трогать');
  const mark=run.prompt.indexOf('[Проход 1 из 2: Колян]');
  assert.ok(note>=0 && mark>note);
  assert.equal(run.execute,false);
 }
});
test('an extra opinion on an execution request is read-only and adds no invented human message',async t=>{
 const {c,state,runs}=await fixture(t);
 state.agents.find(a=>a.id==='claude').mode='execute';
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

test('a summary waits out the current answer, stays in read mode, and replaces the feed',async t=>{
 let release=()=>{}, entered=()=>{};
 const gate=new Promise(r=>{release=r;});
 const started=new Promise(r=>{entered=r;});
 let calls=0;
 const {c,state,runs,store}=await fixture(t,async o=>{
  calls++;
  if(calls===1){entered();await gate;return {text:'Готовый ответ',interrupted:false};}
  await o.onSession('summary-session');
  return {text:'Где остановились',interrupted:false};
 });
 state.agents[0].mode='execute';
 state.agents[0].instruction='пиши кратко';
 state.agents[2].enabled=true;
 state.autoReply=true;
 const sending=c.send('вопрос по проекту','claude');
 await started;
 await c.send('Жека, отдельный вопрос','codex');
 await c.beginSummary('claude');
 assert.equal(runs.length,1);
 assert.equal(runs[0].execute,true);
 assert.equal(state.turns.find(t=>t.summary).mode,'discuss');
 assert.equal(state.queue[0],state.turns.find(t=>t.summary).id);
 await assert.rejects(c.send('ещё','claude'),/Сводк/);
 await assert.rejects(c.handoff('codex'),/Сводк/);
 release();
 await sending;
 await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['claude','claude']);
 assert.equal(runs[1].execute,false);
 assert.match(runs[1].prompt,/Не изменяй файлы/);
 assert.match(runs[1].prompt,/Готовый ответ/);
 assert.ok(runs[1].prompt.includes(summaryPrompt));
 assert.equal(state.messages.length,1);
 assert.equal(state.messages[0].author,'Колян');
 assert.equal(state.messages[0].text,'Где остановились\n\n'+summaryComfort);
 assert.deepEqual(state.sessions,{});
 assert.equal(state.agents[0].mode,'execute');
 assert.equal(state.agents[0].instruction,'пиши кратко');
 assert.equal(state.autoReply,false);
 const archived=await fs.readdir(path.join(store.dir,'archives'));
 assert.equal(archived.length,1);
 const old=JSON.parse(await fs.readFile(path.join(store.dir,'archives',archived[0]),'utf8'));
 assert.ok(old.messages.some(m=>m.text==='вопрос по проекту'));
 assert.ok(old.messages.some(m=>m.text==='Готовый ответ'));
});

test('stopping the turn already running cancels the queued summary and keeps the feed',async t=>{
 let entered=()=>{};
 const started=new Promise(r=>{entered=r;});
 const {c,state,runs}=await fixture(t,async o=>{
  o.text('частично');
  entered();
  await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));
  return {text:'частично',interrupted:true};
 });
 state.messages.push({id:'old',author:'Антон',text:'старое'});
 const sending=c.send('вопрос по проекту','claude');
 await started;
 await c.beginSummary('claude');
 await c.stop();
 await sending;
 await c.idle();
 assert.equal(runs.length,1);
 assert.ok(state.messages.some(m=>m.text==='старое'));
 assert.ok(state.messages.some(m=>m.text==='вопрос по проекту'));
 assert.ok(state.messages.some(m=>/не закончился ответом/.test(m.text)));
 assert.ok(!state.messages.some(m=>m.text.includes(summaryComfort)));
});

test('an empty summary and a failed archive both keep the old feed',async t=>{
 const empty=await fixture(t,async()=>({text:'  \n',interrupted:false}));
 empty.state.messages.push({id:'old',author:'Антон',text:'старое'});
 await empty.c.beginSummary('claude');
 await empty.c.idle();
 assert.ok(empty.state.messages.some(m=>m.text==='старое'));
 assert.ok(empty.state.messages.some(m=>/сводка пустая/.test(m.text)));
 assert.ok(!empty.state.messages.some(m=>m.text.includes(summaryComfort)));
 const failed=await fixture(t,async()=>({text:'Где остановились',interrupted:false}));
 failed.state.messages.push({id:'old',author:'Антон',text:'старое'});
 failed.store.archive=async()=>{throw new Error('диск занят');};
 await failed.c.beginSummary('claude');
 await failed.c.idle();
 assert.ok(failed.state.messages.some(m=>m.text==='старое'));
 assert.ok(failed.state.messages.some(m=>m.text==='Где остановились'));
 assert.ok(failed.state.messages.some(m=>/архив не сохранился/.test(m.text)));
 assert.ok(!failed.state.messages.some(m=>m.text.includes(summaryComfort)));
});

test('a disabled participant cannot write the summary, and reload drops a queued one',async t=>{
 const {c,state}=await fixture(t);
 await assert.rejects(c.beginSummary('grok'),/выключен/);
 state.messages.push({id:'m',author:'Антон',text:summaryPrompt,turn:'s'});
 state.turns.push({id:'s',messageId:'m',recipient:'claude',status:'proposed',summary:true,mode:'discuss'});
 state.queue.push('s');
 await c.recover();
 assert.equal(state.turns.find(t=>t.id==='s').status,'interrupted');
 assert.equal(state.queue.includes('s'),false);
 assert.ok(state.messages.some(m=>/закрытием окна/.test(m.text)));
 await c.send('ещё вопрос','claude');
 await c.idle();
 assert.ok(state.messages.some(m=>m.author==='Колян'&&m.text.startsWith('Ответ')));
});


test('summary source preserves the full feed across limits, resets and session cursors',async t=>{
 let raw;
 const {c,state,host,runs}=await fixture(t,async o=>{raw=await fs.readFile(path.join(o.root,'.trio-summary.md'));return {text:'handoff',interrupted:false};});
 host.limit=()=>2000;
 state.messages.push(
  {id:'early',author:'Антон',text:'EARLY_FACT\r\nbefore reset',attachments:[{id:'a',label:'old.txt',text:'EARLY_ATTACHMENT'}]},
  {id:'reset',author:'Trio',text:'context reset',control:true},
  {id:'tail',author:'Колян',text:'TAIL_FACT '+ 'x'.repeat(5000)}
 );
 state.contextStart='reset';
 state.sessions['claude:discuss']={id:'existing-session',project:host.root,profile:'discuss',through:'tail'};
 host.gitState=async()=>'## main\r\n?? NEW_FILE\r M CHANGED_FILE';
 state.messages.find(m=>m.id==='early').actions=[{title:'PERMISSION_CARD_NOISE'}];
 await c.beginSummary('claude');await c.idle();
 const file=path.join(host.root,'.trio-summary.md');
 assert.ok(runs[0].prompt.includes(JSON.stringify(file)));
 assert.match(runs[0].prompt,/Целиком его не читай/);
 await assert.rejects(fs.stat(file),{code:'ENOENT'});
 assert.equal(raw.includes(13),false);
 const source=raw.toString('utf8');
 assert.match(source,/EARLY_FACT\nbefore reset/);
 assert.match(source,/Файл old\.txt:\nEARLY_ATTACHMENT/);
 assert.match(source,/### Колян[^\n]*\nTAIL_FACT/);
 assert.match(source,/## Git\n\n## main\n\?\? NEW_FILE\n M CHANGED_FILE/);
 assert.equal(source.includes('PERMISSION_CARD_NOISE'),false);
 assert.equal(state.messages[0].text,'handoff\n\n'+summaryComfort);
});

test('summary carries queued questions, attachments, recipients and order into its source',async t=>{
 let source='';
 const {c,state,runs}=await fixture(t,async o=>{
  if(o.prompt.includes('.trio-summary.md'))source=await fs.readFile(path.join(o.root,'.trio-summary.md'),'utf8');
  return {text:'handoff',interrupted:false};
 });
 await c.send('PENDING_FIRST','all',[],[{id:'a',label:'task.txt',text:'PENDING_ATTACHMENT'}]);
 await c.send('PENDING_SECOND','all',['codex','claude']);
 await c.idle();
 const pending=state.queue.slice();
 assert.ok(pending.length>=2);
 await c.beginSummary('claude');await c.idle();
 assert.match(source,/## Очередь \(2\)\n\n1\. #1 → всем\n2\. #2 → Колян/);
 assert.match(source,/PENDING_FIRST\n\nФайл task\.txt:\nPENDING_ATTACHMENT/);
 assert.match(source,/PENDING_SECOND/);
 assert.match(runs.at(-1).prompt,/PENDING_FIRST/);
 assert.match(runs.at(-1).prompt,/PENDING_ATTACHMENT/);
 assert.match(runs.at(-1).prompt,/ожидающие исполнения/);
 assert.deepEqual(state.queue,[]);
});

test('summary is refused during compaction without creating a blocking turn',async t=>{
 let entered,release;
 const started=new Promise(r=>{entered=r;});
 const gate=new Promise(r=>{release=r;});
 const {c,state,host,runs}=await fixture(t,withSession);
 await c.send('initial','claude');await c.idle();
 host.compact=async()=>{entered();await gate;};
 const work=c.compact('claude');await started;
 try {
  const before=structuredClone(state);
  await assert.rejects(c.beginSummary('claude'),/завершения сжатия/);
  assert.deepEqual(state,before);
  assert.equal(c.summarizing,false);
 } finally {release();await work;}
 await c.beginSummary('claude');await c.idle();
 assert.equal(runs.length,2);
 assert.equal(state.messages.length,1);
 assert.ok(state.messages[0].text.endsWith(summaryComfort));
});

test('retrying a failed summary retains the handoff and archives before clearing',async t=>{
 let attempt=0;
 const {c,state,store,runs}=await fixture(t,async()=>++attempt===1
  ? {text:'',error:'temporary failure',interrupted:false}
  : {text:'retried handoff',interrupted:false});
 state.agents[0].mode='execute';
 state.messages.push({id:'old',author:'Антон',text:'KEEP_IN_ARCHIVE'});
 await c.beginSummary('claude');await c.idle();
 const failed=state.turns.find(t=>t.summary);
 assert.equal(failed.status,'failed');
 Object.assign(state,await store.load());
 await c.retry(failed.id);await c.idle();
 assert.equal(runs.length,2);
 assert.equal(runs[1].execute,false);
 assert.equal(state.messages.length,1);
 assert.equal(state.messages[0].text,'retried handoff\n\n'+summaryComfort);
 const files=await fs.readdir(path.join(store.dir,'archives'));
 assert.equal(files.length,1);
 const archived=JSON.parse(await fs.readFile(path.join(store.dir,'archives',files[0]),'utf8'));
 assert.ok(archived.messages.some(m=>m.text==='KEEP_IN_ARCHIVE'));
 assert.equal(archived.turns.filter(t=>t.summary).length,2);
 assert.deepEqual(state.sessions,{});
});

test('failure to write the full summary source keeps the conversation and skips the CLI',async t=>{
 const {c,state,store,runs}=await fixture(t);
 state.messages.push({id:'old',author:'Антон',text:'KEEP'});
 store.summarySource=async()=>{throw new Error('source unavailable');};
 await c.beginSummary('claude');await c.idle();
 assert.equal(runs.length,0);
 assert.ok(state.messages.some(m=>m.text==='KEEP'));
 assert.equal(state.turns.find(t=>t.summary).status,'failed');
 assert.equal(c.summarizing,false);
 assert.ok(state.messages.some(m=>m.text.includes('source unavailable')));
});


for (const provider of ['claude','codex','grok']) {
 test(provider+' can prepare a new conversation with the complete source in read mode',async t=>{
  const {c,state,store,host}=await fixture(t,async o=>{
   assert.equal(o.execute,false);
   // Inside the project root, where every engine reads in Чтение without extra grants.
   const file=path.join(o.root,'.trio-summary.md');
   assert.ok(o.prompt.includes(JSON.stringify(file)));
   assert.match(await fs.readFile(file,'utf8'),/EARLY_SUMMARY_FACT/);
   return {text:'Preserved EARLY_SUMMARY_FACT',interrupted:false};
  });
  state.agents.find(a=>a.id===provider).enabled=true;
  state.agents.find(a=>a.id===provider).mode='execute';
  state.messages.push({id:'old',author:'Антон',text:'EARLY_SUMMARY_FACT'});
  await c.beginSummary(provider);await c.idle();
  assert.equal(state.messages.length,1);
  assert.ok(state.messages[0].text.endsWith(summaryComfort));
  const files=await fs.readdir(path.join(store.dir,'archives'));
  assert.equal(files.length,1);
  const archive=JSON.parse(await fs.readFile(path.join(store.dir,'archives',files[0]),'utf8'));
  assert.ok(archive.messages.some(m=>m.text==='EARLY_SUMMARY_FACT'));
  await assert.rejects(fs.stat(path.join(host.root,'.trio-summary.md')),{code:'ENOENT'});
 });
}
test('a failed or stopped summary still removes its source from the project',async t=>{
 const {c,state,host}=await fixture(t,async()=>({text:'',error:'boom',interrupted:false}));
 state.messages.push({id:'old',author:'Антон',text:'KEEP'});
 await c.beginSummary('claude');await c.idle();
 assert.ok(state.messages.some(m=>m.text==='KEEP'));
 await assert.rejects(fs.stat(path.join(host.root,'.trio-summary.md')),{code:'ENOENT'});
});
test('recovery after a closed window removes a leftover summary source',async t=>{
 const {c,state,host}=await fixture(t);
 const file=path.join(host.root,'.trio-summary.md');
 await fs.writeFile(file,'leftover');
 state.messages.push({id:'m',author:'Антон',text:'x',turn:'s'});
 state.turns.push({id:'s',messageId:'m',recipient:'claude',status:'running',mode:'discuss',summary:true});
 await c.recover();
 await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('.trio-summary.md is ignored by git',()=>{
 assert.match(require('fs').readFileSync(path.join(__dirname,'..','.gitignore'),'utf8'),/^\.trio-summary\.md\*$/m);
});
test('the privilege journal is ignored by git and omitted from the package',()=>{
 const root=path.join(__dirname,'..');
 assert.match(require('fs').readFileSync(path.join(root,'.gitignore'),'utf8'),/^\.trio-privileges\.jsonl$/m);
 assert.match(require('fs').readFileSync(path.join(root,'.vscodeignore'),'utf8'),/^\.trio-privileges\.jsonl$/m);
});
test('a privilege journal hit keeps the command name and drops its arguments',()=>{
 const secret='SECRETTOKEN';
 const shell=privilegeJournalHit('Bash',JSON.stringify({kind:'execute',rawInput:{command:'powershell -EncodedCommand '+secret}}));
 assert.equal(shell.privilege,'unparsed');
 assert.equal(shell.word,'powershell');
 assert.equal(shell.reason,'обёртка');
 assert.equal(JSON.stringify(shell).includes(secret),false);
 const loose=privilegeJournalHit('Bash',JSON.stringify({kind:'execute',rawInput:{command:'curl $('+secret+')'}}));
 assert.equal(loose.privilege,'unparsed');
 assert.equal(loose.word,'curl');
 assert.equal(loose.reason,'$()');
 assert.equal(JSON.stringify(loose).includes(secret),false);
 const named=privilegeJournalHit('MysteryTool',JSON.stringify({name:'MysteryTool',token:secret}));
 assert.equal(named.privilege,'other');
 assert.equal(named.word,'mysterytool');
 assert.equal(named.reason,'прочее');
 assert.equal(privilegeJournalHit('Execute git',JSON.stringify({kind:'execute',rawInput:{command:'git commit -m '+secret}})),undefined);
});
test('a visible command head keeps its checkbox and the journal says why the rest is unparsed',()=>{
 const cover=command=>dangerCover('Bash',JSON.stringify({kind:'execute',command}));
 const hit=command=>privilegeJournalHit('Bash',JSON.stringify({kind:'execute',rawInput:{command}}));
 const here="@'\n$(Remove-Item hidden)\n'@\nRemove-Item a.txt";
 assert.deepEqual(cover(here),{needs:['shell'],safeCommand:false});
 assert.equal(hit(here),undefined);
 const literal="$layout = @'\nconst q = $('x');\n'@\n$layout | node";
 assert.equal(permissionClass('Bash',JSON.stringify({kind:'execute',command:literal})),'command');
 assert.deepEqual(cover('Remove-Item a.txt; python script.py'),{needs:['shell'],safeCommand:true});
 assert.equal(hit('Remove-Item a.txt; python script.py'),undefined);
 assert.equal(permissionClass('Bash',JSON.stringify({kind:'execute',command:'python script.py SECRETTOKEN'})),'command');
 assert.equal(hit('python script.py SECRETTOKEN'),undefined);
 for (const command of ['python -m pytest','python3 script.py','py -3 script.py','pythonw script.py']) {
  assert.equal(permissionClass('Bash',JSON.stringify({kind:'execute',command})),'command',command);
  assert.equal(hit(command),undefined,command);
 }
 assert.deepEqual(cover('curl $(https://example.test)'),{needs:['network','unparsed'],safeCommand:false});
 assert.equal(hit('curl $(https://example.test)').reason,'$()');
 assert.deepEqual(cover('Remove-Item $(path)'),{needs:['shell','unparsed'],safeCommand:false});
 assert.equal(hit('Remove-Item $(path)').word,'remove-item');
 assert.equal(hit('echo $(Remove-Item a.txt)').reason,'$()');
 assert.deepEqual(cover('echo $(Remove-Item a.txt)'),{needs:['unparsed'],safeCommand:false});
 assert.equal(hit('Get-ChildItem ${name}').reason,'${}');
 assert.equal(hit('Get-ChildItem ${name}').word,'get-childitem');
 const called='& "C:\\\\Program Files\\\\python.exe" script.py';
 assert.equal(permissionClass('Bash',JSON.stringify({kind:'execute',command:called})),'command');
 assert.equal(hit(called),undefined);
 assert.deepEqual(cover('& { Remove-Item a.txt }'),{needs:['unparsed'],safeCommand:false});
 assert.equal(hit('& { Remove-Item a.txt }').reason,'&');
 assert.deepEqual(cover('powershell -Command "Remove-Item a.txt"'),{needs:['shell'],safeCommand:false});
 assert.equal(hit('powershell -Command "Remove-Item a.txt"'),undefined);
 assert.deepEqual(cover('bash -c "rm a && curl https://example.test"'),{needs:['network','shell'],safeCommand:false});
 assert.deepEqual(cover('powershell -EncodedCommand abc'),{needs:['unparsed'],safeCommand:false});
 assert.equal(hit('powershell -EncodedCommand abc').reason,'обёртка');
 assert.equal(permissionClass('Bash',JSON.stringify({kind:'execute',command:'node -e "git commit && rm -rf /"'})),'command');
});
test('a bash quote dressed as a here-string and a script from stdin do not pass as a plain command',()=>{
 const cover=(command,shell)=>dangerCover('Bash',JSON.stringify({kind:'execute',rawInput:{command},...(shell?{shell}:{})}));
 // In bash the quote closes at the first apostrophe and rm runs.
 const fake="echo @'\nfoo' ; rm -rf ~ ; echo '\n'@";
 assert.deepEqual(cover(fake),{needs:['shell'],safeCommand:true});
 assert.deepEqual(cover(fake,'bash'),{needs:['shell'],safeCommand:true});
 assert.equal(permissionSignature('Bash',JSON.stringify({kind:'execute',rawInput:{command:fake}})),undefined);
 // A real here-string with no shell field still shows the command after it.
 assert.deepEqual(cover("@'\nsome text\n'@ | Remove-Item a.txt"),{needs:['shell'],safeCommand:false});
 for (const command of ['echo Remove-Item x | powershell -NoProfile -Command -','Get-Content run.ps1 | pwsh -c -']) {
  assert.deepEqual(cover(command),{needs:['unparsed'],safeCommand:true},command);
 }
 for (const command of ['powershell -Command $script','bash -c "$cmd"']) {
  assert.deepEqual(cover(command),{needs:['unparsed'],safeCommand:false},command);
 }
});
test('compound wrapper scripts require unparsed without losing visible commands',()=>{
 for (const command of [
  "powershell -Command 'if ($true) { Remove-Item a.txt }'",
  "pwsh -c 'if($true){Remove-Item a.txt}'",
  "bash -c 'if true; then rm a.txt; fi'",
  "sh -c 'for f in a.txt; do rm $f; done'",
  "powershell -Command 'try { Remove-Item a.txt } catch { }'",
  "bash -c '(rm a.txt)'",
  "bash -c 'echo \x60rm a.txt\x60'"
 ]) {
  const detail=JSON.stringify({kind:'execute',command});
  assert.equal(permissionClass('Bash',detail),'danger',command);
  assert.deepEqual(dangerCover('Bash',detail),{needs:['unparsed'],safeCommand:false},command);
  assert.equal(privilegeJournalHit('Bash',detail).reason,'обёртка',command);
 }
 const chain=JSON.stringify({kind:'execute',command:"bash -c 'curl https://example.test; if true; then rm a.txt; fi'"});
 assert.deepEqual(dangerCover('Bash',chain),{needs:['network','unparsed'],safeCommand:false});
 const literal=JSON.stringify({kind:'execute',command:'powershell -Command "Write-Output if"'});
 assert.equal(permissionClass('Bash',literal),'command');
});
test('CMD wrapper variables remain opaque including quoted and delayed expansion',()=>{
 for (const command of ['cmd /c %SCRIPT%','cmd /c "%SCRIPT%"','cmd /c !SCRIPT!','cmd /c %1','cmd /c echo %SCRIPT%']) {
  const detail=JSON.stringify({kind:'execute',command});
  assert.deepEqual(dangerCover('Bash',detail),{needs:['unparsed'],safeCommand:false},command);
  assert.equal(privilegeJournalHit('Bash',detail).reason,'обёртка',command);
 }
 assert.equal(permissionClass('Bash',JSON.stringify({kind:'execute',command:'cmd /c echo hello'})),'command');
});
test('an ambiguous here-string preserves every known category when bash parsing fails',()=>{
 const prefix="@'\ncan't\n'@\n";
 for (const [command,category] of [['Remove-Item a.txt','shell'],['curl https://example.test','network'],['git push','git']]) {
  const detail=JSON.stringify({kind:'execute',command:prefix+command});
  assert.deepEqual(dangerCover('Bash',detail),{needs:[category,'unparsed'],safeCommand:false},command);
  assert.equal(permissionSignature('Bash',detail),undefined);
 }
 const chain=JSON.stringify({kind:'execute',command:prefix+'echo ok; Remove-Item a.txt; curl https://example.test; git push'});
 assert.deepEqual(dangerCover('Bash',chain),{needs:['network','git','shell','unparsed'],safeCommand:true});
});
test('auto commands cannot approve opaque wrappers and unparsed alone cannot approve a visible deletion',async t=>{
 for (const scenario of [
  {command:"powershell -Command 'if ($true) { Remove-Item a.txt }'",autoCommands:true,privileges:[]},
  {command:'cmd /c %SCRIPT%',autoCommands:true,privileges:[]},
  {command:"@'\ncan't\n'@\nRemove-Item a.txt",autoCommands:false,privileges:['unparsed']}
 ]) {
  const {command,autoCommands,privileges}=scenario;
  let pending;
  const {c,state}=await fixture(t,async o=>{
   const decision=o.permission('Bash',JSON.stringify({kind:'execute',command}));
   pending=c.permissions[0];
   if(pending)c.permission(pending.id,false);
   return {text:String(await decision),interrupted:false};
  });
  await c.setFlags({autoCommands,privilegeOn:true,privileges});
  state.agents.find(a=>a.id==='claude').mode='execute';
  await c.send('review','claude');await c.idle();
  assert.ok(pending,command+' must ask before execution');
  assert.equal(pending.standing,false,command);
  assert.ok(state.messages.some(m=>m.text==='false'),command);
 }
});
test('the privilege journal records unparsed and other requests without arguments',async t=>{
 const secret='SECRETTOKEN';
 let step=0;
 const {c,state,host}=await fixture(t,async o=>{
  step++;
  if(step>1){
   const again=await o.permission('Bash',JSON.stringify({kind:'execute',rawInput:{command:'powershell -EncodedCommand '+secret}}));
   return {text:String(again),interrupted:false};
  }
  const shell=o.permission('Bash',JSON.stringify({kind:'execute',rawInput:{command:'python script.py '+secret}}));
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  c.permission(c.permissions[0].id,true);
  const ran=await shell;
  const allow=o.permission('MysteryTool',JSON.stringify({name:'MysteryTool',token:secret}));
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  c.permission(c.permissions[0].id,true);
  const allowed=await allow;
  const deny=o.permission('OddTool',JSON.stringify({tool:'OddTool',password:secret}));
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  c.permission(c.permissions[0].id,false);
  const denied=await deny;
  return {text:[ran,allowed,denied].join('/'),interrupted:false};
 });
 await c.setFlags({privilegeOn:true,privileges:['unparsed']});
 state.agents.find(a=>a.id==='claude').mode='execute';
 const file=path.join(host.root,privilegeJournalFile);
 await fs.writeFile(file,'{"at":"old","agent":"Жека","word":"curl","privilege":"unparsed","outcome":"отказ"}','utf8');
 await c.send('Колян, делай','claude');await c.idle();
 await c.send('ещё','claude');await c.idle();
 const text=await fs.readFile(file,'utf8');
 assert.equal(text.includes('\r'),false);
 assert.equal(text.includes(secret),false);
 const rows=text.trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(rows.map(row=>row.word),['curl','mysterytool','oddtool','powershell']);
 assert.deepEqual(rows.map(row=>row.outcome),['отказ','разрешено','отказ','само']);
 assert.deepEqual(rows.map(row=>row.privilege),['unparsed','other','other','unparsed']);
 assert.deepEqual(rows.map(row=>row.reason),[undefined,'прочее','прочее','обёртка']);
 assert.equal(rows[1].agent,'Колян');
 assert.equal(rows[3].agent,'Колян');
 const notes=state.messages.filter(m=>m.text.startsWith('Журнал привилегий: '));
 assert.equal(notes.length,2);
 assert.equal(notes[0].control,true);
 assert.equal(notes[0].text,'Журнал привилегий: '+file);
 assert.equal(notes[0].text.includes(secret),false);
});
test('a checked git command does not enter the privilege journal',async t=>{
 const {c,state,host}=await fixture(t,async o=>{
  const git=await o.permission('Execute git',JSON.stringify({kind:'execute',rawInput:{command:'git commit -m x'}}));
  return {text:String(git),interrupted:false};
 });
 await c.setFlags({privilegeOn:true,privileges:['git']});
 state.agents.find(a=>a.id==='claude').mode='execute';
 await c.send('Колян, делай коммит','claude');await c.idle();
 await assert.rejects(fs.stat(path.join(host.root,privilegeJournalFile)),{code:'ENOENT'});
 assert.equal(state.messages.some(m=>/Журнал привилегий/.test(m.text)),false);
});
test('the privilege journal stays away until privileges are on',async t=>{
 const {c,state,host}=await fixture(t,async o=>{
  const decision=o.permission('Bash',JSON.stringify({kind:'execute',rawInput:{command:'powershell -Command dir'}}));
  while(!c.permissions.length)await new Promise(r=>setImmediate(r));
  c.permission(c.permissions[0].id,true);
  return {text:String(await decision),interrupted:false};
 });
 state.agents.find(a=>a.id==='claude').mode='execute';
 await c.send('Колян, делай','claude');await c.idle();
 await assert.rejects(fs.stat(path.join(host.root,privilegeJournalFile)),{code:'ENOENT'});
 assert.equal(state.messages.some(m=>/Журнал привилегий/.test(m.text)),false);
});


for(const status of ['completed','failed','interrupted',undefined]) {
 test('recovery removes both summary files after '+(status||'a conversation reset'),async t=>{
  const {c,state,store,host,runs}=await fixture(t);
  const file=path.join(host.root,'.trio-summary.md');
  await fs.writeFile(file,'leftover\n','utf8');
  await fs.writeFile(file+'.tmp','unfinished write\n','utf8');
  const keep=path.join(host.root,'.trio-summary.md.keep');
  await fs.writeFile(keep,'unrelated file\n','utf8');
  state.messages.push({id:'m',author:'Антон',text:'KEEP'});
  if(status) state.turns.push({id:'s',messageId:'m',recipient:'claude',mode:'discuss',summary:true,status});
  await store.save(state);
  await c.recover();
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
  await assert.rejects(fs.stat(file+'.tmp'),{code:'ENOENT'});
  assert.equal(await fs.readFile(keep,'utf8'),'unrelated file\n');
  assert.ok(state.messages.some(m=>m.text==='KEEP'));
  assert.equal(state.turns[0]?.status,status);
  assert.equal(runs.length,0);
 });
}

test('failed summary source write removes its temporary file and preserves the feed',async t=>{
 const {c,state,store,host,runs}=await fixture(t);
 const file=path.join(host.root,'.trio-summary.md');
 state.messages.push({id:'m',author:'Антон',text:'KEEP'});
 store.summarySource=async()=>{
  await fs.writeFile(file+'.tmp','partial source\n','utf8');
  throw new Error('summary write failed');
 };
 await c.beginSummary('claude');await c.idle();
 await assert.rejects(fs.stat(file),{code:'ENOENT'});
 await assert.rejects(fs.stat(file+'.tmp'),{code:'ENOENT'});
 assert.ok(state.messages.some(m=>m.text==='KEEP'));
 assert.equal(state.turns.find(t=>t.summary).status,'failed');
 assert.equal(runs.length,0);
});

test('stopping a summary removes both source files and keeps the old conversation',async t=>{
 let entered;
 const started=new Promise(resolve=>{entered=resolve;});
 const {c,state,host}=await fixture(t,async o=>{
  await fs.writeFile(path.join(o.root,'.trio-summary.md.tmp'),'leftover\n','utf8');
  entered();
  await new Promise(resolve=>o.signal.addEventListener('abort',resolve,{once:true}));
  return {text:'partial',interrupted:true};
 });
 state.messages.push({id:'m',author:'Антон',text:'KEEP'});
 const starting=c.beginSummary('claude');
 await started;
 await c.stop();await starting;await c.idle();
 for(const suffix of ['', '.tmp']) await assert.rejects(fs.stat(path.join(host.root,'.trio-summary.md'+suffix)),{code:'ENOENT'});
 assert.ok(state.messages.some(m=>m.text==='KEEP'));
 assert.equal(state.turns.find(t=>t.summary).status,'interrupted');
});

test('recovery and a rejected summary leave another window source under its lock',async t=>{
 const {ProjectLock}=require('../dist/processes/lock');
 const {c,state,host}=await fixture(t);
 const lock=await ProjectLock.for(host.root,host.lockBase);
 await lock.acquire();
 const file=path.join(host.root,'.trio-summary.md');
 await fs.writeFile(file,'another window\n','utf8');
 await fs.writeFile(file+'.tmp','another window temp\n','utf8');
 try {
  await c.recover();
  await c.beginSummary('claude');await c.idle();
  assert.equal(await fs.readFile(file,'utf8'),'another window\n');
  assert.equal(await fs.readFile(file+'.tmp','utf8'),'another window temp\n');
  assert.equal(state.turns.find(t=>t.summary).status,'failed');
 } finally {await lock.release();}
 await c.recover();
 await assert.rejects(fs.stat(file),{code:'ENOENT'});
 await assert.rejects(fs.stat(file+'.tmp'),{code:'ENOENT'});
});
test('a missing Codex rollout keeps the saved session',async t=>{
 const {c,state,runs}=await fixture(t,async()=>({
  text:'',error:'Сессия Жеки у Codex не найдена, сбросьте ему контекст.',interrupted:false
 }));
 state.sessions['codex:discuss']={id:'live-thread',project:c.host.root,profile:'discuss',through:'kept'};
 await c.send('посмотри файл','codex');await c.idle();
 assert.equal(runs[0].session,'live-thread');
 assert.equal(state.sessions['codex:discuss'].id,'live-thread');
 assert.equal(state.sessions['codex:discuss'].through,'kept');
 assert.ok(state.messages.some(m=>m.error&&m.text==='Сессия Жеки у Codex не найдена, сбросьте ему контекст.'));
});
test('a locked snapshot-refs file does not fail the turn',{timeout:30000,skip:process.platform!=='win32'},async t=>{
 const {c,state,store}=await fixture(t,async o=>{
  await o.onSession('session-'+o.provider);
  return {text:'Ответ '+o.provider,interrupted:false};
 });
 await c.send('первый','claude');await c.idle();
 const reader=await fs.open(path.join(store.dir,'snapshot-refs.json'),'r');
 try {
  await c.send('второй','claude');await c.idle();
  assert.equal(state.turns.at(-1).status,'completed');
  assert.equal(state.sessions['claude:discuss'].id,'session-claude');
  assert.ok(state.diagnostics.some(line=>/snapshot-refs:/.test(line)&&/EPERM/.test(line)));
  assert.equal(state.messages.some(m=>m.error&&/EPERM|snapshot-refs|сохранить чат/.test(m.text)),false);
 } finally {await reader.close();}
});

test('git global options keep dangerous subcommands behind the git checkbox', () => {
 for (const command of [
  'git -C repo push', 'git -C "my repo" push', "git -C '' push",
  'git -c user.name=Anton commit -m x', 'git -c "user.name=Anton User" commit -m "x"',
  'git -C "my repo" -c a=b --no-pager reset --hard',
  'git --git-dir=.git rebase main', 'git --work-tree "my repo" push',
  'git -Crepo -ca=b push', 'git --config-env=a=B commit --amend',
 ]) {
  const detail = JSON.stringify({kind:'execute', command});
  assert.equal(permissionClass('Bash', detail), 'danger', command);
  assert.deepEqual(dangerCover('Bash', detail), {needs:['git'], safeCommand:false}, command);
 }
 for (const command of ['git -C "my repo" status', 'git -c a=b diff']) {
  assert.equal(permissionClass('Bash', JSON.stringify({command})), 'command', command);
 }
 assert.equal(permissionSignature('Bash', JSON.stringify({command:'git -C "my repo" push'})), 'cmd:git push');
 assert.deepEqual(dangerCover('Bash', JSON.stringify({command:'git status & git -C repo push'})), {needs:['git'],safeCommand:true});
});
test('opaque shell requests and deletion metadata cannot use ordinary auto approvals', () => {
 for (const command of ['', 'powershell -EncodedCommand abc', 'git --unknown-option push', 'git -C']) {
  const detail = JSON.stringify({kind:'execute',command});
  assert.equal(permissionClass('Bash',detail),'danger',command);
  assert.deepEqual(dangerCover('Bash',detail),{needs:['unparsed'],safeCommand:false},command);
 }
 for (const detail of [{kind:'edit',operation:'delete'},{kind:'write',type:'remove'}]) {
  assert.equal(permissionClass('Edit',JSON.stringify(detail)),'danger');
  assert.deepEqual(dangerCover('Edit',JSON.stringify(detail)),{needs:['delete'],safeCommand:false});
 }
});
test('ordinary auto approvals cannot bypass the selected privilege categories', async t => {
 for (const checked of [false,true]) {
  const requests = [
   ['Bash',{kind:'execute',command:'git -C "my repo" push'}],
   ['Bash',{kind:'execute',command:'powershell -EncodedCommand abc'}],
   ['Edit',{kind:'edit',operation:'delete'}]
  ];
  const {c,state} = await fixture(t,async o => {
   const decisions=[];
   for (const [title,detail] of requests) {
    const pending=o.permission(title,JSON.stringify(detail));
    if(c.permissions.length)c.permission(c.permissions[0].id,false);
    decisions.push(await pending);
   }
   return {text:decisions.join('/'),interrupted:false};
  });
  await c.setFlags({autoCommands:true,autoEdits:true,privilegeOn:true,privileges:checked?['git','unparsed','delete']:['other']});
  state.agents.find(a=>a.id==='claude').mode='execute';
  await c.send('Колян, делай проверку','claude');await c.idle();
  assert.equal(state.messages.find(m=>m.author==='Колян').text,checked?'true/true/true':'false/false/false');
 }
});

test('a Codex patch containing deletion and editing requires both permissions', async t => {
 const {codexApproval}=require('../dist/providers/codexProtocol');
 const request=codexApproval('item/fileChange/requestApproval',{changes:[
  {path:'old.txt',kind:{type:'delete'}},{path:'keep.txt',kind:{type:'update'}}
 ]});
 assert.deepEqual(dangerCover(request.title,request.detail),{needs:['delete'],safeCommand:false,safeEdit:true});
 for (const autoEdits of [false,true]) {
  const {c,state}=await fixture(t,async o => {
   const pending=o.permission(request.title,request.detail);
   if(c.permissions.length)c.permission(c.permissions[0].id,false);
   return {text:String(await pending),interrupted:false};
  });
  await c.setFlags({autoEdits,privilegeOn:true,privileges:['delete']});
  state.agents.find(a=>a.id==='claude').mode='execute';
  await c.send('Колян, делай правку','claude');await c.idle();
  assert.equal(state.messages.find(m=>m.author==='Колян').text,String(autoEdits));
 }
});

test('words and the discuss phrase do not change the card mode',async t=>{
 const {c,state,runs}=await fixture(t);
 state.agents.find(a=>a.id==='claude').mode='execute';
 await c.send('Колян, исправь файл. обсуждаем, код не трогать','claude');await c.idle();
 assert.equal(state.turns[0].mode,'execute');
 assert.equal(runs[0].execute,true);
 state.agents.find(a=>a.id==='claude').mode='discuss';
 await c.send('делай','claude');await c.idle();
 assert.equal(state.turns[1].mode,'discuss');
 assert.equal(runs[1].execute,false);
});

test('a click uses the clicked card, and the discuss button keeps the next person in reading',async t=>{
 const {c,state,runs}=await fixture(t);
 state.agents.find(a=>a.id==='claude').mode='execute';
 state.agents.find(a=>a.id==='codex').mode='execute';
 await c.send('Колян, посмотри файл','claude');await c.idle();
 assert.equal(runs[0].execute,true);
 await c.handoff('codex');await c.idle();
 assert.equal(runs[1].execute,true);
 assert.equal(state.turns[1].mode,'execute');
 await c.send('ещё раз','claude',[],[],true);await c.idle();
 assert.equal(runs[2].execute,false);
 await c.handoff('codex');await c.idle();
 assert.equal(runs[3].execute,false);
});

test('a finished reading turn from the card does not force the next click into reading',async t=>{
 const {c,state,runs}=await fixture(t);
 state.agents.find(a=>a.id==='codex').mode='execute';
 await c.send('вопрос','claude');await c.idle();
 assert.equal(runs[0].execute,false);
 await c.handoff('codex');await c.idle();
 assert.equal(runs[1].execute,true);
 assert.equal(state.turns[1].mode,'execute');
});

test('the discuss button keeps the next click in reading when the first card is already reading',async t=>{
 const {c,state,runs,store}=await fixture(t);
 state.agents.find(a=>a.id==='claude').mode='discuss';
 state.agents.find(a=>a.id==='codex').mode='execute';
 await c.send('посмотри','claude',[],[],true);await c.idle();
 assert.equal(runs[0].execute,false);
 assert.equal(state.messages.find(m=>m.author==='Антон').discuss,true);
 assert.equal((await store.load()).messages.find(m=>m.author==='Антон').discuss,true);
 await c.handoff('codex');await c.idle();
 assert.equal(runs[1].execute,false);
 assert.equal(state.turns[1].mode,'discuss');
});

test('a card change after the answer does not invent or drop the discuss button',async t=>{
 const {c,state,runs}=await fixture(t);
 state.agents.find(a=>a.id==='claude').mode='discuss';
 state.agents.find(a=>a.id==='codex').mode='execute';
 await c.send('вопрос','claude');await c.idle();
 assert.equal(state.messages.find(m=>m.author==='Антон').discuss,false);
 state.agents.find(a=>a.id==='claude').mode='execute';
 await c.handoff('codex');await c.idle();
 assert.equal(runs[1].execute,true);
 assert.equal(state.turns[1].mode,'execute');
 state.agents.find(a=>a.id==='claude').mode='execute';
 await c.send('кнопка','claude',[],[],true);await c.idle();
 state.agents.find(a=>a.id==='claude').mode='discuss';
 await c.handoff('codex');await c.idle();
 assert.equal(runs[3].execute,false);
 assert.equal(state.turns.at(-1).mode,'discuss');
});

test('a message saved before the discuss flag still guesses the button from the card',async t=>{
 const {c,state,runs}=await fixture(t);
 state.agents.find(a=>a.id==='claude').mode='execute';
 state.agents.find(a=>a.id==='codex').mode='execute';
 await c.send('старое','claude',[],[],true);await c.idle();
 delete state.messages.find(m=>m.author==='Антон').discuss;
 await c.handoff('codex');await c.idle();
 assert.equal(runs[1].execute,false);
 assert.equal(state.turns[1].mode,'discuss');
});

test('Grok cancelled after a refusal lets the next agent in the same chain start',async t=>{
 const {c,state,runs}=await fixture(t,async o=>{
  if(o.provider==='grok')return {text:'Проверяю правки',interrupted:false,cancelled:true,refused:true};
  return {text:'дальше',interrupted:false};
 });
 state.agents.find(a=>a.id==='grok').enabled=true;
 await c.setFlags({autoReply:true});
 await c.send('вопрос','all',['grok','claude']);await c.idle();
 assert.deepEqual(runs.map(r=>r.provider),['grok','claude']);
 const turn=state.turns.find(t=>t.executor==='grok');
 assert.equal(turn.status,'interrupted');
 const reply=state.messages.find(m=>m.author==='Гриха'&&!m.control);
 assert.equal(reply.text,'Проверяю правки');
 assert.equal(reply.partial,true);
 const note=state.messages.find(m=>m.control&&/движок закрыл/.test(m.text));
 assert.equal(note.text,'Гриха: движок закрыл ход после отказа в действии');
 assert.equal(note.error,false);
 assert.equal(note.turn,turn.id);
 assert.match(runs[1].prompt,/движок закрыл ход после отказа в действии/);
 assert.equal(state.messages.some(m=>/: остановлен/.test(m.text)),false);
 assert.equal(state.queue.length,0);
 assert.equal(state.turns.find(t=>t.recipient==='claude').status,'completed');
});

test('Grok cancelled without a recorded refusal still hands the same chain to the next agent',async t=>{
 const {c,state,runs}=await fixture(t,async()=>({text:'кусок',interrupted:false,cancelled:true}));
 state.agents.find(a=>a.id==='grok').enabled=true;
 await c.setFlags({autoReply:true});
 await c.send('вопрос','all',['grok','claude']);await c.idle();
 const note=state.messages.find(m=>/движок закрыл/.test(m.text));
 assert.equal(note.text,'Гриха: движок закрыл ход');
 assert.equal(note.control,true);
 assert.equal(runs.length,2);
 assert.equal(state.queue.length,0);
 assert.equal(state.turns.find(t=>t.executor==='grok').status,'interrupted');
});

test('an engine cancel on the last step does not start the next message',async t=>{
 const {c,state,runs}=await fixture(t,async o=>{
  if(o.provider==='grok')return {text:'кусок',interrupted:false,cancelled:true};
  return {text:'не должен',interrupted:false};
 });
 state.agents.find(a=>a.id==='grok').enabled=true;
 await c.setFlags({autoReply:true});
 await c.send('первый','grok');
 await c.send('второй','claude');
 await c.idle();
 assert.equal(runs.length,1);
 assert.match(state.messages.find(m=>/движок закрыл/.test(m.text)).text,/Очередь остановлена/);
 assert.equal(state.turns.find(t=>t.recipient==='claude').status,'proposed');
});

test('Grok cancelled does not mention the queue when nobody is waiting on auto-reply',async t=>{
 const {c,state}=await fixture(t,async()=>({text:'кусок',interrupted:false,cancelled:true,refused:true}));
 state.agents.find(a=>a.id==='grok').enabled=true;
 await c.setFlags({autoReply:true});
 await c.send('один','grok');await c.idle();
 assert.equal(state.messages.find(m=>/движок закрыл/.test(m.text)).text,'Гриха: движок закрыл ход после отказа в действии');
 assert.equal(state.queue.length,0);
 let release;const hold=new Promise(r=>release=r);
 const second=await fixture(t,async o=>{
  if(o.provider==='grok')await hold;
  return {text:'кусок',interrupted:false,cancelled:true};
 });
 second.state.agents.find(a=>a.id==='grok').enabled=true;
 await second.c.send('первый','grok');
 await second.c.send('второй','claude');
 release();
 await second.c.idle();
 assert.equal(second.state.messages.find(m=>/движок закрыл/.test(m.text)).text,'Гриха: движок закрыл ход');
 assert.equal(second.state.queue.length,1);
});

test('an empty Grok cancel is interrupted without an empty-answer error',async t=>{
 const {c,state}=await fixture(t,async()=>({text:'',interrupted:false,cancelled:true,refused:true}));
 state.agents.find(a=>a.id==='grok').enabled=true;
 await c.send('пусто','grok');await c.idle();
 assert.equal(state.messages.some(m=>m.author==='Гриха'),false);
 assert.equal(state.messages.some(m=>/пустой ответ/.test(m.text)),false);
 assert.equal(state.turns[0].status,'interrupted');
 assert.equal(state.messages.find(m=>m.control).text,'Гриха: движок закрыл ход после отказа в действии');
 assert.equal(state.messages.some(m=>/остановлен/.test(m.text)),false);
});

test('Anton Stop still says остановлен when the engine also reports cancelled',async t=>{
 let started;const ready=new Promise(r=>started=r);
 const {c,state}=await fixture(t,async o=>{
  started();
  await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));
  return {text:'частично',interrupted:true,cancelled:true,refused:true};
 });
 state.agents.find(a=>a.id==='grok').enabled=true;
 await c.send('вопрос','grok');await ready;
 await c.stop('grok');
 assert.match(state.messages.at(-1).text,/Гриха: остановлен\. Частичный ответ сохранён\./);
 assert.equal(state.messages.some(m=>/движок закрыл/.test(m.text)),false);
 assert.equal(state.turns[0].status,'interrupted');
 assert.equal(state.messages.find(m=>m.author==='Гриха').partial,true);
});

test('a denied command stays the failure note even if the engine also cancelled',async t=>{
 const {c,state}=await fixture(t,async()=>({text:'x',interrupted:false,denied:'Bash',cancelled:true,refused:true}));
 await c.send('команда','claude');await c.idle();
 assert.equal(state.turns[0].status,'failed');
 assert.match(state.messages.find(m=>m.control).text,/остановился: не разрешили Bash/);
 assert.equal(state.messages.some(m=>/движок закрыл|остановлен/.test(m.text)),false);
});
