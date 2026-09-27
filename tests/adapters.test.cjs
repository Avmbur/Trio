const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {runProvider,remainingTimer,readUsage,sumTokens,isAutoCompact,formatUsage,readProviderUsage,extractQuota,extractQuotas,
  claudeAccessToken,readClaudeOauthUsage,grokAccessToken,normalizeGrokBilling,redactSecrets,clearUsageCache,expiryMs,
  parseAgentQuestions,withCustomAnswers,grokQuestionResult,spendTokens,spendHint,extractCliVersion,rememberCli,rememberedCli,pickContextWindow,joinChunks,
  parseResetAt,claudeLaunchSettings,isolatedEngineEnv}=require('../dist/providers/adapter');
for(const provider of ['codex','claude','grok']){
 test(provider+' native adapter handshake, streaming, permission and final response',{timeout:20000,skip:process.platform!=='win32'},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'trio-adapter-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.copyFile(path.join(__dirname,'fake-engine.cjs'),path.join(root,'fake.cjs'));
  const cli=path.join(root,'fake.cmd');await fs.writeFile(cli,'@node "%dp0%/fake.cjs" %*');
  let session,permissions=0,compacts=0,quota;const chunks=[],reported={},trace=[];
  const result=await runProvider({provider,cli,root,execute:true,prompt:'test',model:'',effort:'',
   jobRunner:path.resolve('dist/native/JobRunner.exe'),timeout:15000,signal:new AbortController().signal,
   onPid:async()=>{},onSession:async value=>{session=value;},text:value=>chunks.push(value),progress:()=>{},
   trace:steps=>{trace.splice(0,trace.length,...steps);},
   usage:report=>{
    if(report.tokens!==undefined)reported.tokens=report.tokens;
    if(report.window!==undefined)reported.window=report.window;
    const q=extractQuota(report.raw); if(q) quota=q.percent;
   },
   permission:async()=>{permissions++;return true;},compacted:()=>{compacts++;}});
  assert.equal(result.error,undefined);assert.equal(result.interrupted,false);assert.equal(result.text,'Начало готово');
  assert.equal(permissions,1);assert.ok(session);assert.ok(chunks.includes('Начало '));assert.equal(chunks.at(-1),'Начало готово');
  if(provider==='grok'){
    assert.ok(trace.some(s=>s.kind==='thought'&&/сверю/i.test(s.title)));
    assert.ok(trace.some(s=>s.kind==='tool'&&/Read adapter/.test(s.title)));
    assert.ok(trace.every(s=>s.status==='done'));
    assert.equal(quota,17);
  }
  assert.equal(compacts,1);
  // Each engine names its counters differently; Trio reads all three to the same pair.
  // For Claude that is the last iteration only: the turn total here is 313 508.
  assert.deepEqual(reported,{tokens:120000,window:500000});
 });
}

test('remaining timer does not fire while held',async()=>{
 let fired=0;
 const clock=remainingTimer(40,()=>{fired++;});
 clock.hold();
 await new Promise(r=>setTimeout(r,80));
 assert.equal(fired,0);
 clock.release();
 await new Promise(r=>setTimeout(r,80));
 assert.equal(fired,1);
 clock.stop();
});
test('remaining timer touch resets the idle budget',async()=>{
 let fired=0;
 const clock=remainingTimer(70,()=>{fired++;});
 await new Promise(r=>setTimeout(r,40));
 clock.touch();
 await new Promise(r=>setTimeout(r,40));
 assert.equal(fired,0);
 clock.stop();
});
test('remaining timer ceiling fires even while held',async()=>{
 let reason;
 const clock=remainingTimer(10000,r=>{reason=r;},50);
 clock.hold();
 await new Promise(r=>setTimeout(r,90));
 assert.equal(reason,'ceiling');
 clock.stop();
});
test('discuss mode keeps AskUserQuestion among allowed tools',()=>{
 const src=require('fs').readFileSync('src/providers/adapter.ts','utf8');
 assert.match(src,/Read,Grep,Glob,AskUserQuestion/);
 assert.match(src,/session\/cancel/);
});
test('Claude auth timeout is a failure, not a user stop',{timeout:15000,skip:process.platform!=='win32'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'trio-timeout-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'fake.cjs'),'setInterval(()=>{},1000)');
 const cli=path.join(root,'fake.cmd');await fs.writeFile(cli,'@node "%dp0%/fake.cjs" %*');
 const stages=[];
 const result=await runProvider({provider:'claude',cli,root,execute:false,prompt:'test',model:'',effort:'',
  jobRunner:path.resolve('dist/native/JobRunner.exe'),timeout:1000,signal:new AbortController().signal,
  onPid:async()=>{},onSession:async()=>{},text:()=>{},progress:v=>stages.push(v),permission:async()=>false});
 assert.equal(result.interrupted,false);assert.match(result.error,/Нет ответа 1 с/);
 assert.match(result.error,/проверка существующего входа/);assert.doesNotMatch(result.error,/Запуск отменён/);
 assert.equal(result.text,'');assert.ok(stages.length);
});

test('usage modal text shows occupancy and session totals without inventing limits',()=>{
 const text=formatUsage({tokens:183065,window:500000,source:'session/prompt',at:1},{session:{totalTokens:183065,limit:500000},turns:[1,2]});
 assert.match(text,/183\s?065/);
 assert.match(text,/500\s?000/);
 assert.match(text,/ходов: 2/);
 assert.match(text,/session\/prompt/);
 const limits=formatUsage(undefined,{rateLimitsByLimitId:{codex:{limitName:'Codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:1893456000}}}});
 assert.match(limits,/Лимиты подписки/);
 assert.match(limits,/25%/);
 const claude=formatUsage(undefined,{plan:'Pro',fiveHour:{usedPercent:12,resetsAt:'16:00'}});
 assert.match(claude,/Pro/);
 assert.match(claude,/12/);
});
for(const provider of ['codex','claude','grok']){
 test(provider+' usage is fetched without starting a turn',{timeout:20000,skip:process.platform!=='win32'},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'trio-usage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.copyFile(path.join(__dirname,'fake-engine.cjs'),path.join(root,'fake.cjs'));
  const cli=path.join(root,'fake.cmd');await fs.writeFile(cli,'@node "%dp0%/fake.cjs" %*');
  const account=await readProviderUsage({provider,cli,root,jobRunner:path.resolve('dist/native/JobRunner.exe'),
   signal:new AbortController().signal,timeout:15000,session:provider==='grok'?'sess-1':undefined,home:root});
  const text=formatUsage({tokens:100,window:1000,source:'test',at:1},account);
  assert.match(text,/100/);
  if(provider==='codex')assert.match(text,/25%/);
  if(provider==='claude')assert.match(text,/Pro/);
  if(provider==='grok')assert.match(text,/183\s?065/);
 });
}
test('expired Claude token refreshes and writes credentials atomically',async t=>{
 clearUsageCache();
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'trio-oauth-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.claude'));
 await fs.writeFile(path.join(home,'.claude','.credentials.json'),JSON.stringify({
  claudeAiOauth:{accessToken:'secret-token',refreshToken:'secret-refresh',expiresAt:Date.now()-60000,subscriptionType:'pro'}
 }));
 const calls=[];
 const fetcher=async(url,init)=>{
  calls.push({url:String(url),method:(init&&init.method)||'GET',body:String((init&&init.body)||'')});
  if(String(url).includes('/oauth/token'))
   return {status:200,ok:true,json:async()=>({access_token:'new-access',refresh_token:'new-refresh',expires_in:28800})};
  return {status:200,ok:true,json:async()=>({five_hour:{utilization:3}})};
 };
 const data=await readClaudeOauthUsage({provider:'claude',cli:'claude',root:home,jobRunner:'x',
  signal:new AbortController().signal,timeout:10000,home,fetcher,now:Date.now()});
 assert.equal(extractQuota(data).percent,3);
 assert.ok(calls.some(c=>c.method==='POST'&&/console\.anthropic\.com\/v1\/oauth\/token/.test(c.url)));
 assert.ok(calls.filter(c=>c.method!=='POST').every(c=>!/secret-refresh|secret-token/.test(c.body+' '+c.url)));
 const saved=JSON.parse(await fs.readFile(path.join(home,'.claude','.credentials.json'),'utf8'));
 assert.equal(saved.claudeAiOauth.accessToken,'new-access');
 assert.equal(saved.claudeAiOauth.refreshToken,'new-refresh');
 assert.equal((await fs.readdir(path.join(home,'.claude'))).includes('.credentials.json.tmp'),false);
 assert.doesNotMatch(JSON.stringify(data),/secret-token|secret-refresh|new-access|new-refresh/);
});
test('expired Claude token without refreshToken does not POST',async t=>{
 clearUsageCache();
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'trio-oauth-norefresh-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.claude'));
 await fs.writeFile(path.join(home,'.claude','.credentials.json'),JSON.stringify({
  claudeAiOauth:{accessToken:'secret-token',expiresAt:Date.now()-60000,subscriptionType:'pro'}
 }));
 const calls=[];
 const fetcher=async(url,init)=>{calls.push({url:String(url),method:(init&&init.method)||'GET'});throw new Error('network');};
 await assert.rejects(()=>claudeAccessToken({home,now:Date.now(),fetcher}),/просрочен/);
 await assert.rejects(()=>readClaudeOauthUsage({provider:'claude',cli:'claude',root:home,jobRunner:'x',
  signal:new AbortController().signal,timeout:10000,home,fetcher,now:Date.now()}),/просрочен/);
 assert.equal(calls.length,0);
});
test('Claude oauth usage is GET-only and never writes the token into the payload',async t=>{
 clearUsageCache();
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'trio-oauth-ok-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.claude'));
 await fs.writeFile(path.join(home,'.claude','.credentials.json'),JSON.stringify({
  claudeAiOauth:{accessToken:'secret-token',refreshToken:'secret-refresh',expiresAt:Date.now()+3600000,subscriptionType:'pro',rateLimitTier:'default'}
 }));
 const calls=[];
 const fetcher=async(url,init)=>({
  status:200,ok:true,
  json:async()=>({five_hour:{utilization:7.5,resets_at:'2026-09-12T16:00:00Z'},accessToken:'leaked'})
 });
 const recorded=async(url,init)=>{calls.push({url:String(url),method:(init&&init.method)||'GET'});return fetcher(url,init);};
 const data=await readClaudeOauthUsage({provider:'claude',cli:'claude',root:home,jobRunner:'x',
  signal:new AbortController().signal,timeout:10000,home,fetcher:recorded,now:Date.now()});
 assert.equal(calls.length,1);
 assert.match(calls[0].url,/api\.anthropic\.com\/api\/oauth\/usage/);
 assert.equal(calls[0].method,'GET');
 assert.equal(calls.some(c=>/console\.anthropic\.com/.test(c.url)),false);
 assert.equal(data.accessToken,undefined);
 assert.equal(extractQuota(data).percent,7.5);
 assert.match(data.plan,/pro/);
 const dump=JSON.stringify(data);
 assert.doesNotMatch(dump,/secret-token|secret-refresh/);
});
test('Claude oauth 401 refreshes once and retries',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'trio-oauth-401-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.claude'));
 await fs.writeFile(path.join(home,'.claude','.credentials.json'),JSON.stringify({
  claudeAiOauth:{accessToken:'secret-token',refreshToken:'secret-refresh',expiresAt:Date.now()+3600000}
 }));
 const calls=[];
 const fetcher=async(url,init)=>{
  calls.push({url:String(url),method:(init&&init.method)||'GET'});
  if(String(url).includes('/oauth/token'))
   return {status:200,ok:true,json:async()=>({access_token:'new-access',refresh_token:'new-refresh',expires_in:28800})};
  if(calls.filter(c=>/oauth\/usage/.test(c.url)).length===1)return {status:401,ok:false,json:async()=>({})};
  return {status:200,ok:true,json:async()=>({five_hour:{utilization:9}})};
 };
 const data=await readClaudeOauthUsage({provider:'claude',cli:'claude',root:home,jobRunner:'x',
  signal:new AbortController().signal,timeout:10000,home,fetcher,now:Date.now()});
 assert.equal(extractQuota(data).percent,9);
 assert.equal(calls.filter(c=>c.method==='POST').length,1);
 assert.equal(calls.filter(c=>/oauth\/usage/.test(c.url)).length,2);
});
test('Claude oauth 401 without refreshToken asks for a real turn',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'trio-oauth-401-norefresh-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.claude'));
 await fs.writeFile(path.join(home,'.claude','.credentials.json'),JSON.stringify({
  claudeAiOauth:{accessToken:'secret-token',expiresAt:Date.now()+3600000}
 }));
 const calls=[];
 const fetcher=async(url,init)=>{calls.push({url:String(url),method:(init&&init.method)||'GET'});return {status:401,ok:false,json:async()=>({})};};
 await assert.rejects(()=>readClaudeOauthUsage({provider:'claude',cli:'claude',root:home,jobRunner:'x',
  signal:new AbortController().signal,timeout:10000,home,fetcher,now:Date.now()}),/просрочен/);
 assert.equal(calls.every(c=>c.method==='GET'),true);
 assert.equal(calls.some(c=>c.method==='POST'),false);
});
test('expired Grok token does not refresh',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'trio-grok-oauth-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.grok'));
 await fs.writeFile(path.join(home,'.grok','auth.json'),JSON.stringify({'https://auth.x.ai::test':{key:'secret-key',expires_at:Date.now()-1000}}));
 await assert.rejects(()=>grokAccessToken({home,now:Date.now()}),/просрочен/);
});
test('Grok ISO expires_at is read as a date, not NaN',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'trio-grok-iso-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.grok'));
 const past=new Date(Date.now()-60000).toISOString();
 const future=new Date(Date.now()+3600000).toISOString();
 assert.equal(Number(past),Number.NaN);
 assert.ok(expiryMs(past)>0&&expiryMs(past)<Date.now());
 await fs.writeFile(path.join(home,'.grok','auth.json'),JSON.stringify({'https://auth.x.ai::test':{key:'secret-key',expires_at:past}}));
 await assert.rejects(()=>grokAccessToken({home,now:Date.now()}),/просрочен/);
 await fs.writeFile(path.join(home,'.grok','auth.json'),JSON.stringify({'https://auth.x.ai::test':{key:'secret-key',expires_at:future}}));
 const got=await grokAccessToken({home,now:Date.now()});
 assert.equal(got.token,'secret-key');
});
test('payload without percents is a dash, not zero',()=>{
 assert.equal(extractQuota({session:{totalTokens:10},plan:'Pro'}),undefined);
 assert.equal(extractQuota({five_hour:{hello:1}}),undefined);
});
test('Grok billing percent maps onto a subscription window',()=>{
 const data=normalizeGrokBilling({config:{creditUsagePercent:38,currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEK',end:'2026-09-18T00:00:00Z'}}},{subscriptionTier:'SuperGrok'});
 assert.equal(extractQuota(data).percent,38);
 assert.match(extractQuota(data).label,/неделя/);
 assert.equal(data.plan,'SuperGrok');
});
test('Grok billing keeps a wrapped percent and WEEKLY period after a CLI rename',()=>{
 const data=normalizeGrokBilling({config:{
  creditUsagePercent:{val:41},
  currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEKLY',end:'2026-09-24T06:00:00Z'}
 },subscription_tier:'SuperGrok Heavy'});
 assert.equal(data.plan,'SuperGrok Heavy');
 assert.equal(extractQuota(data).percent,41);
 assert.match(extractQuota(data).label,/неделя/);
 assert.equal(extractQuota(data).resetsAt,Date.parse('2026-09-24T06:00:00Z'));
});
test('Grok billing derives a percent from used/limit wrappers',()=>{
 const data=normalizeGrokBilling({config:{
  used:{val:25},monthlyLimit:{val:100},
  currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEK',end:'2026-09-24T00:00:00Z'}
 }});
 assert.equal(extractQuota(data).percent,25);
});
test('Grok 1.0.34 unified payload keeps the plan and does not invent zero',()=>{
 const live={config:{
  currentPeriod:{type:'USAGE_PERIOD_TYPE_WEEKLY',start:'2026-09-17T06:00:28.656155+00:00',end:'2026-09-24T06:00:28.656155+00:00'},
  onDemandCap:{val:0},onDemandUsed:{val:0},prepaidBalance:{val:0},
  isUnifiedBillingUser:true,
  billingPeriodStart:'2026-09-17T06:00:28.656155+00:00',
  billingPeriodEnd:'2026-09-24T06:00:28.656155+00:00'
 },subscription_tier:'SuperGrok Heavy'};
 const data=normalizeGrokBilling(live,live);
 assert.equal(data.plan,'SuperGrok Heavy');
 assert.equal(data.unified,true);
 assert.equal(extractQuota(data),undefined);
 assert.equal(extractQuotas(data).length,0);
 assert.match(data.hint,/не отдаёт/);
 assert.match(data.hint,/сброс/i);
});
test('quota percents unwrap protobuf val wrappers',()=>{
 const rows=extractQuotas({seven_day:{utilization:{val:40},resets_at:'2026-09-24T00:00:00Z'}});
 assert.equal(rows[0].percent,40);
 assert.match(rows[0].label,/неделя/);
});
test('agent answers preserve labels and never expand the engine option schema',()=>{
 const grok=parseAgentQuestions({questions:[{question:'Цвет?',options:[{label:'синий',description:'холодный'}],multi_select:true}]});
 assert.equal(grok[0].prompt,'Цвет?');
 assert.equal(grok[0].options[0].label,'синий');
 assert.equal(grok[0].multi,true);
 const patched=withCustomAnswers({questions:[{question:'Цвет?',options:[{label:'синий'}]}]},{'Цвет?':'бирюза'});
 assert.deepEqual(patched.questions[0].options,[{label:'синий'}]);
 assert.equal(patched.answers['Цвет?'],'бирюза');
 const result=grokQuestionResult({'Цвет?':'бирюза'});
 assert.equal(result.outcome,'accepted');
 assert.equal(result.answers['Цвет?'],'бирюза');
 assert.deepEqual(result.partial_answers,{});
 const multiIn=withCustomAnswers({questions:[{question:'Стек?',options:[{label:'node'},{label:'go'}],multiSelect:true}]},{'Стек?':['node','go']});
 assert.deepEqual(multiIn.answers['Стек?'],['node','go']);
 const multiOut=grokQuestionResult({'Стек?':['node','go']},[{prompt:'Стек?',multi:true}]);
 assert.deepEqual(multiOut.answers['Стек?'],['node','go']);
 const labels=['Usage обновился сам, без клика','свой 1','свой 2','свой 3'];
 const input={questions:[{question:'Что?',multiSelect:true,options:['a','b','c','d'].map(label=>({label}))}]};
 const result2=withCustomAnswers(input,{'Что?':labels});
 assert.equal(result2.questions[0].options.length,4);
 assert.deepEqual(result2.answers['Что?'],labels);
 assert.deepEqual(grokQuestionResult({'Что?':labels},[{prompt:'Что?',multi:true}]).answers['Что?'],labels);
});
test('redactSecrets drops tokens and keys',()=>{
 const out=redactSecrets({plan:'Pro',accessToken:'secret',refreshToken:'r',key:'k',totalTokens:183065,nested:{authorization:'Bearer x'}});
 assert.equal(out.plan,'Pro');
 assert.equal(out.totalTokens,183065);
 assert.equal(out.accessToken,undefined);
 assert.equal(out.key,undefined);
 assert.equal(out.nested.authorization,undefined);
});
test('quota uses the shortest subscription window, not context occupancy',()=>{
 const claude=extractQuota({plan:'Pro',fiveHour:{usedPercent:62,windowDurationMins:300,resetsAt:'16:00'}});
 assert.equal(claude.percent,62);
 assert.equal(claude.label,'5 ч');
 assert.equal(claude.resetsAt,undefined);
 assert.equal(parseResetAt('16:00'),undefined);
 assert.equal(parseResetAt(1893456000),1893456000000);
 assert.equal(parseResetAt('2026-09-11T16:00:00Z'),Date.parse('2026-09-11T16:00:00Z'));
 const mixed=extractQuota({rateLimitsByLimitId:{
  week:{primary:{usedPercent:10,windowDurationMins:10080,resetsAt:1893456000}},
  hours:{primary:{usedPercent:81,windowDurationMins:300,resetsAt:1893456000}}}});
 assert.equal(mixed.percent,81);
 assert.equal(mixed.label,'5 ч');
 assert.equal(extractQuota({session:{totalTokens:183065,limit:500000}}),undefined);
 const oauth=extractQuota({five_hour:{utilization:7.5,resets_at:'2026-09-11T16:00:00Z'},seven_day:{utilization:42,resets_at:'2026-09-18T16:00:00Z'}});
 assert.equal(oauth.percent,7.5);
 assert.equal(oauth.label,'5 ч');
 assert.equal(oauth.resetsAt,Date.parse('2026-09-11T16:00:00Z'));
 const snake=extractQuota({rate_limits:{primary:{used_percent:25,window_duration_mins:300,resets_at:1893456000}}});
 assert.equal(snake.percent,25);
 assert.equal(snake.label,'5 ч');
 const windows=extractQuotas({five_hour:{utilization:12,resets_at:'2026-09-11T16:00:00Z'},
  seven_day:{utilization:40},seven_day_sonnet:{utilization:18},extra_usage:{utilization:99}});
 assert.deepEqual(windows.map(q=>q.label),['5 ч','неделя · 7 д','неделя · Sonnet']);
 assert.equal(windows.find(q=>q.label==='неделя · Sonnet').percent,18);
 assert.equal(extractQuotas({nimbus_quill:{utilization:88},five_hour:{utilization:3}}).map(q=>q.label).join(),'5 ч');
 const weeks=extractQuotas({rateLimitsByLimitId:{
  short:{secondary:{usedPercent:11,windowDurationMins:10080}},
  long:{secondary:{usedPercent:44,windowDurationMins:20160}}}});
 assert.ok(weeks.some(q=>q.label==='неделя · 7 д'&&q.percent===11));
 assert.ok(weeks.some(q=>q.label==='неделя · 14 д'&&q.percent===44));
});
test('Codex keeps equal percentages in separate named limits and removes only the summary alias',()=>{
 const raw=require('./fixtures/codex-rate-limits.json');
 const rows=extractQuotas(raw);
 assert.deepEqual(rows.map(q=>[q.limitId,q.limitName,q.label,q.percent]),[
  ['codex','Codex','неделя · 7 д',43],
  ['codex_bengalfox','GPT-5.3-Codex-Spark','5 ч',0],
  ['codex_bengalfox','GPT-5.3-Codex-Spark','неделя · 7 д',0],
  ['base_model_inference','Резерв · gpt-5.6-luna','неделя · 7 д',0]
 ]);
 assert.equal(rows[2].resetsAt,1893974400000);
 assert.equal(extractQuota(raw).percent,43,'card uses main Codex even when Spark has a shorter window');
 const reversed={rateLimitsByLimitId:Object.fromEntries(Object.entries(raw.rateLimitsByLimitId).reverse()),rateLimits:raw.rateLimits};
 assert.deepEqual(extractQuotas(reversed).map(q=>[q.limitId,q.label,q.percent]),rows.map(q=>[q.limitId,q.label,q.percent]));
});
test('Codex primary and secondary remain distinct at equal percentages',()=>{
 const raw={rateLimits:{limitId:'codex',primary:{usedPercent:0,windowDurationMins:300},secondary:{usedPercent:0,windowDurationMins:10080}}};
 assert.deepEqual(extractQuotas(raw).map(q=>q.label),['5 ч','неделя · 7 д']);
 assert.equal(extractQuota(raw).label,'5 ч');
 assert.equal(extractQuotas({rateLimits:{primary:{usedPercent:29,windowDurationMins:300}}})[0].limitId,'codex');
 const spark={rateLimits:require('./fixtures/codex-rate-limits.json').rateLimitsByLimitId.codex_bengalfox};
 assert.equal(extractQuota(spark,'account/rateLimits/updated','codex'),undefined);
});
test('auto-compact notices are recognised and manual compact is not',()=>{
 assert.equal(isAutoCompact('x.ai/session_notification',{type:'auto_compact'}),true);
 assert.equal(isAutoCompact('system/compact_boundary',{subtype:'compact_boundary'}),true);
 assert.equal(isAutoCompact('thread/compact/completed',{reason:'auto'}),true);
 assert.equal(isAutoCompact('session/update',{update:{sessionUpdate:'auto_compact_start'}}),true);
 assert.equal(isAutoCompact('x.ai/session/update',{update:{sessionUpdate:'auto_compact_end'}}),true);
 assert.equal(isAutoCompact('',{sessionUpdate:'auto_compact'}),true);
 assert.equal(isAutoCompact('x.ai/session_notification',{type:'auto_compact_started'}),true);
 assert.equal(isAutoCompact('session/update',{update:{sessionUpdate:'compact_boundary'}}),true);
 assert.equal(isAutoCompact('session/prompt',{stopReason:'auto_compact'}),true);
 assert.equal(isAutoCompact('session/update',{sessionUpdate:'agent_message_chunk'}),false);
 assert.equal(isAutoCompact('x.ai/session_notification',{type:'diff_review'}),false);
 assert.equal(isAutoCompact('x.ai/session_notification',{type:'retry',hint:'will compact later'}),false);
 assert.equal(isAutoCompact('session/prompt',{stopReason:'end_turn',_meta:{totalTokens:1}}),false);
});
test('Trio launches never enable remote control',()=>{
 const settings=claudeLaunchSettings();
 assert.equal(settings.disableRemoteControl,true);
 assert.equal(settings.remoteControlAtStartup,false);
 assert.equal(settings.forceLoginMethod,'claudeai');
 const env=isolatedEngineEnv({GROK_WORKSPACE_COMMAND:'1',GROK_AGENT_DASHBOARD:'1',ANTHROPIC_API_KEY:'x'});
 assert.equal(env.GROK_WORKSPACE_COMMAND,'0');
 assert.equal(env.GROK_AGENT_DASHBOARD,'0');
 assert.equal(env.ANTHROPIC_API_KEY,undefined);
});
test('joinChunks inserts a blank line between glued sentences and leaves a live stream alone',()=>{
 assert.equal(joinChunks('пачкой.','Вношу правки'),'пачкой.\n\nВношу правки');
 assert.equal(joinChunks('Начало ','готово'),'Начало готово');
 assert.equal(joinChunks('Hel','lo'),'Hello');
 assert.equal(joinChunks('','Первое'),'Первое');
 assert.equal(joinChunks('trio-chat-0.1.48.','vsix'),'trio-chat-0.1.48.vsix');
 assert.equal(joinChunks('| 1. Install `trio-chat-0.1.48.','vsix` → Reload | шапка |'),
  '| 1. Install `trio-chat-0.1.48.vsix` → Reload | шапка |');
});
test('pickContextWindow prefers the modelUsage row that matches top-level usage, not the first window',()=>{
 const modelUsage={
  'claude-haiku-4-5':{contextWindow:200000,inputTokens:28183,outputTokens:40},
  'claude-opus-5':{contextWindow:1000000,inputTokens:12,cacheReadInputTokens:272260,cacheCreationInputTokens:36378,outputTokens:2351}
 };
 const usage={input_tokens:12,cache_read_input_tokens:272260,output_tokens:2351};
 assert.equal(pickContextWindow(usage,modelUsage),1000000);
 assert.equal(pickContextWindow({input_tokens:1,output_tokens:1},modelUsage),1000000);
});
test('spendTokens uses engine-specific formulas and ignores cache reads for Claude',()=>{
 assert.equal(spendTokens('claude',{modelUsage:{opus:{inputTokens:16,cacheCreationInputTokens:318029,cacheReadInputTokens:100000,outputTokens:6510}}}),324555);
 assert.equal(spendTokens('grok',{inputTokens:295040,cachedReadTokens:294784,cacheCreationTokens:318,outputTokens:36,reasoningTokens:0}),610);
 assert.match(spendHint('claude',{modelUsage:{opus:{inputTokens:16,cacheCreationInputTokens:207579,cacheReadInputTokens:1437512,outputTokens:4439}}}),/выход 4439/);
 assert.match(spendHint('claude',{modelUsage:{opus:{inputTokens:16,cacheCreationInputTokens:207579,outputTokens:4439}},total_cost_usd:2.4}),/по прайсу API/);
 assert.match(spendHint('grok',{inputTokens:302564,cachedReadTokens:302336,outputTokens:141,reasoningTokens:8}),/не сообщается/);
 assert.doesNotMatch(spendHint('grok',{inputTokens:100,cachedReadTokens:0,cacheCreationTokens:0,outputTokens:10}),/не сообщается/);
 assert.equal(spendTokens('codex',{inputTokens:100,outputTokens:20}),undefined);
});
test('extractCliVersion picks a string version and skips protocolVersion numbers',()=>{
 assert.equal(extractCliVersion({version:'2.1.270'}), '2.1.270');
 assert.equal(extractCliVersion({protocolVersion:1,_meta:{agentVersion:'1.0.30'}}),'1.0.30');
 assert.equal(extractCliVersion({version:'1'}),undefined);
 rememberCli('claude','C:/claude.exe',{version:'2.1.270'});
 assert.match(rememberedCli('claude'),/claude\.exe · 2\.1\.270/);
});
test('nested breakdowns are not counted twice; occupancy is one request, not the whole turn',()=>{
 // The live Claude payload repeats the same tokens: a turn total plus every iteration.
 const claude={usage:{input_tokens:8,cache_creation_input_tokens:28276,cache_read_input_tokens:1465835,output_tokens:1581,
  iterations:[{input_tokens:2,cache_read_input_tokens:374059,cache_creation_input_tokens:9000,output_tokens:330},
   {input_tokens:6,cache_read_input_tokens:491776,cache_creation_input_tokens:19276,output_tokens:1251}]}};
 assert.equal(readUsage(claude).tokens,1495700);
 assert.equal(sumTokens(claude.usage.iterations.at(-1)),512309);
 // A total on the same object wins over its own parts, and the session-wide block below it is ignored.
 const grok={totalTokens:183065,inputTokens:182829,outputTokens:236,usage:{totalTokens:545449,modelCalls:3}};
 assert.equal(readUsage(grok).tokens,183065);
 assert.equal(readUsage({modelUsage:{m:{contextWindow:1000000}}}).window,1000000);
 assert.deepEqual(readUsage({turn:{status:'completed'}}),{tokens:undefined,window:undefined});
});
