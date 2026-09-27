// Real chat and controller in Firefox, with fake model responses.
// WebDriver BiDi: https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn,execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
async function main(){
  const firefox=process.env.TRIO_TEST_FIREFOX||'C:/Program Files/Mozilla Firefox/firefox.exe';
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'trio-firefox-check-'));
  const profile=path.join(root,'browser-profile');fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile,'user.js'),[
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.page", 0);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    // Anton's Windows reports reduced motion, so the panel is checked under that setting:
    // this is exactly where the blinking queue button used to be switched off.
    'user_pref("ui.prefersReducedMotion", 1);'
  ].join('\n'));
  const child=spawn(firefox,['--headless','--no-remote','--profile',profile,'--remote-debugging-port','0','about:blank'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let launchLog='',browserError,ws;
  child.on('error',e=>{browserError=e;});
  child.stderr.on('data',d=>{launchLog+=d;});child.stdout.on('data',d=>{launchLog+=d;});
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  try{
    const until=Date.now()+20000;
    while(!/WebDriver BiDi listening on (ws:\/\/[^\s]+)/.test(launchLog)){
      if(browserError)throw browserError;
      if(Date.now()>until)throw new Error('Firefox BiDi did not start: '+launchLog);
      await delay(100);
    }
    const endpoint=launchLog.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/)[1];
    ws=new WebSocket(endpoint.replace(/\/$/,'')+'/session');
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    let sequence=0;const waiting=new Map(),errors=[],requests=[];
    ws.onmessage=({data})=>{
      const m=JSON.parse(data);
      if(m.id){
        const p=waiting.get(m.id);if(!p)return;
        waiting.delete(m.id);clearTimeout(p.timer);
        if(m.type==='error')p.reject(new Error(p.method+': '+m.error+': '+m.message));else p.resolve(m.result);
      }
      if(m.method==='log.entryAdded'&&m.params.level==='error')errors.push(m.params.text);
      if(m.method==='network.beforeRequestSent')requests.push(m.params.request.url);
    };
    function bidi(method,params={}){
      return new Promise((resolve,reject)=>{
        const id=++sequence,timer=setTimeout(()=>{waiting.delete(id);reject(new Error('BiDi timeout: '+method));},10000);
        waiting.set(id,{resolve,reject,timer,method});ws.send(JSON.stringify({id,method,params}));
      });
    }
    await bidi('session.new',{capabilities:{}});
    const context=(await bidi('browsingContext.create',{type:'tab'})).context;
    await bidi('session.subscribe',{events:['log.entryAdded','network.beforeRequestSent']});
    async function call(method,p={}){
      if(['Page.enable','Runtime.enable','Network.enable'].includes(method))return;
      if(method==='Page.addScriptToEvaluateOnNewDocument')return bidi('script.addPreloadScript',{functionDeclaration:'()=>{'+p.source+'}'});
      if(method==='Emulation.setDeviceMetricsOverride')return bidi('browsingContext.setViewport',{context,viewport:{width:p.width,height:p.height},devicePixelRatio:1});
      if(method==='Page.navigate')return bidi('browsingContext.navigate',{context,url:p.url,wait:'complete'});
      if(method==='Page.captureScreenshot')return bidi('browsingContext.captureScreenshot',{context,origin:'viewport',format:{type:'image/png'}});
      throw new Error('Unknown test operation '+method);
    }
    async function evaluate(expression){
      const result=await bidi('script.evaluate',{expression:'(async()=>JSON.stringify(await eval('+JSON.stringify(expression)+')))()',target:{context},awaitPromise:true,userActivation:true});
      if(result.type==='exception')throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.type==='undefined'?undefined:JSON.parse(result.result.value);
    }
    async function poll(expression){
      const until=Date.now()+10000;
      while(Date.now()<until){if(await evaluate(expression))return;await delay(100);}
      throw new Error('Firefox condition failed: '+expression);
    }
    const {Controller} = require('../dist/orchestrator/controller');
    const {Store} = require('../dist/storage/store');
    const store = new Store(path.join(root, 'state'));
    const state = await store.load(), runs = [];
    let detached = false, layout = {side:'right',width:340}, catalogs = {};
    const compacted = [];
    const host = {root, lockBase:path.join(root,'locks'), jobRunner:'unused',
      cli:async p=>p, limit:()=>64000, timeout:()=>10000, changed:()=>{}, trusted:()=>true, prepare:async()=>undefined,
      compact:async o=>{compacted.push(o.provider);}};
    const controller = new Controller(state,store,host,async o=>{
      runs.push(o); await o.onSession('session-'+runs.length);
      // Same path a real adapter takes: it reports the figures it read plus the untouched
      // payload, the window at handshake and the occupancy at the end of the turn.
      o.usage({window:500000,raw:{model_context_window:500000}},'initialize');
      o.usage({tokens:430000,raw:{usage:{input_tokens:420000,output_tokens:10000}}},'result');
      return {text:'Opinion '+o.provider,interrupted:false};
    });
    async function publish() {
      await evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({
        type:'state',state,active:controller.active,progress:controller.progress,permissions:controller.permissions,compacting:controller.compacting,detached,layout,catalogs
      })+'}))');
    }
    async function pump() {
      const posted = await evaluate('window.trioRequests.splice(0)');
      for (const m of posted) {
        let data;
        if (m.type==='draft') {state.draft=m.text;state.responseOrder=m.responseOrder;state.recipient=m.recipient;state.draftAttachments=m.attachments||[];}
        if (m.type==='send') {await controller.send(m.text,m.recipient,m.responseOrder,m.attachments);await controller.idle();}
        if (m.type==='handoff') {await controller.handoff(m.provider,m.turnId);await controller.idle();}
        if (m.type==='popout') detached=true;
        if (m.type==='layout') layout={side:m.side,width:m.width};
        if (m.type==='attach') data={attachment:{id:'fixture-code',label:'example.ts:1–3',text:'export const answer = 42;\n// Attached code\n'}};
        if (m.type==='reset') data={archive:await controller.reset(m.mode)};
        if (m.type==='agent') await controller.configure(m.agent);
        if (m.type==='compact') await controller.compact(m.provider);
        if (m.type==='catalog') catalogs={...catalogs,[m.provider]:[
          {value:'model-a',label:'Модель A',description:'фикстура',efforts:['low','high']},
          {value:'model-b',label:'Модель B',efforts:[]}]};
        await publish();
        await evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({type:'ack',requestId:m.clientRequestId,data})+'}))');
      }
    }
    async function click(selector) {await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');}
    async function send(text) {
      await evaluate('document.getElementById("draft").value='+JSON.stringify(text)+';document.getElementById("composer").requestSubmit()');
      await pump();
    }
    const nonce='trioBrowserCheck', webview=path.resolve(__dirname,'../webview');
    const {renderPanelHtml}=require('../dist/ui/panelConnection');
    const html=renderPanelHtml(fs.readFileSync(path.join(webview,'main.html'),'utf8'),
      fs.readFileSync(path.join(webview,'main.css'),'utf8'),fs.readFileSync(path.join(webview,'composer.js'),'utf8'),
      fs.readFileSync(path.join(webview,'main.js'),'utf8'),nonce,'file:',require('../package.json').version);
    const pageFile=path.join(root,'chat.html');fs.writeFileSync(pageFile,html);
    await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
    await call('Page.addScriptToEvaluateOnNewDocument',{source:
      'window.trioRequests=[];let saved;window.acquireVsCodeApi=()=>({postMessage:m=>window.trioRequests.push(m),getState:()=>saved,setState:s=>{saved=s;}});'});
    await call('Emulation.setDeviceMetricsOverride',{width:1280,height:1080,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:pathToFileURL(pageFile).href});
    await poll('window.trioRequests?.some(m=>m.type==="ready")');
    await pump();
    await poll('document.querySelectorAll("#response-order button").length===2');
    await controller.send('Старый вопрос, который пока не запускали','all');await publish();
    await click('#response-order button:nth-child(1)');
    await click('#response-order button:nth-child(2)');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#response-order button")].map(b=>b.textContent)'),['1 \u041a\u043e\u043b\u044f\u043d','2 \u0416\u0435\u043a\u0430']);
    await click('#response-order button:nth-child(1)');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#response-order button")].map(b=>b.textContent)'),['\u041a\u043e\u043b\u044f\u043d','1 \u0416\u0435\u043a\u0430']);
    await click('#response-order button:nth-child(1)');
    await send('Сравните два подхода к хранению контекста. Какие риски видите?');
    assert.deepEqual(runs.map(o=>o.provider),['codex']);
    assert.equal(state.queue.length,2);
    assert.equal(await evaluate('document.querySelectorAll("#handoffs button").length'),0);
    assert.match(await evaluate('document.querySelector("#queued").textContent'),/2\. \u041a\u043e\u043b\u044f\u043d/);
    assert.equal(await evaluate('document.getElementById("older-queue").hidden'),false);
    assert.equal(await evaluate('document.getElementById("older-queue").open'),false);
    assert.ok(await evaluate('document.querySelector("#queued").textContent.includes("Сравните")'));
    assert.ok(await evaluate('document.querySelector("#feed").getBoundingClientRect().height > innerHeight * .7'));
    assert.ok(await evaluate('document.querySelector("#controls-pane").getBoundingClientRect().width >= 330'));
    assert.ok(await evaluate('document.querySelector(".message").getBoundingClientRect().width > innerWidth * .65'));
    assert.ok(await evaluate('document.querySelector(".toolbar").getBoundingClientRect().height < 50'));
    const desktop=await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(root,'queue.png'),Buffer.from(desktop.data,'base64'));
    // The profile asks for reduced motion; the button whose turn it is must still blink.
    assert.equal(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'),true);
    const blink=await evaluate('(()=>{const s=getComputedStyle(document.querySelector("#queued .queue-actions .next"));return [s.animationName,s.animationDuration,s.animationIterationCount];})()');
    assert.deepEqual(blink,['awaiting-turn','1s','infinite']);
    await click('#queued .queue-actions .next');
    await pump();
    assert.deepEqual(runs.map(o=>o.provider),['codex','claude']);
    assert.equal(state.messages.filter(m=>m.author==='\u0410\u043d\u0442\u043e\u043d').length,2);
    assert.ok(runs[1].prompt.endsWith('Сравните два подхода к хранению контекста. Какие риски видите?'));
    assert.match(runs[1].prompt,/Opinion codex/);
    assert.doesNotMatch(runs[1].prompt,/\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u043b|\u0442\u0435\u0431\u0435 \u0441\u043b\u043e\u0432\u043e/);
    assert.equal(state.queue.length,1);
    // The bar is per participant: the one who answered shows a percentage, the untouched one a dash.
    const meters=await evaluate('[...document.querySelectorAll(".agent .meter")].map(m=>[m.querySelector(".meter-text").textContent,m.querySelector(".meter-fill").style.width,m.classList.contains("high")])');
    assert.deepEqual(meters[0],['430к из 500к','86%',true]);
    assert.deepEqual(meters[1],['430к из 500к','86%',true]);
    assert.deepEqual(meters[2],['—','0%',false]);
    // The percentage sits in the middle of the whole bar, not in the middle of the fill.
    const centres=await evaluate('(()=>{const m=document.querySelector(".agent .meter"),t=m.querySelector(".meter-text").getBoundingClientRect(),f=m.querySelector(".meter-fill").getBoundingClientRect(),b=m.getBoundingClientRect();return [(t.left+t.right)/2-(b.left+b.right)/2,(f.left+f.right)/2-(b.left+b.right)/2];})()');
    assert.ok(Math.abs(centres[0])<=1,'percentage is centred on the bar: '+centres[0]);
    assert.ok(centres[1]<-5,'fill centre differs from the label centre: '+centres[1]);
    const savedActive=controller.active,savedPerm=controller.permissions.slice();
    controller.active={provider:'grok',turnId:'perm-turn'};
    controller.permissions=[{id:'perm-1',provider:'grok',title:'Read spec.md',detail:'{}'}];
    await publish();
    assert.equal(await evaluate('document.getElementById("floor-title").textContent'),'Ждёт разрешения');
    assert.equal(await evaluate('document.getElementById("permission-dialog").open'),true);
    assert.match(await evaluate('document.getElementById("permission-what").textContent'),/Read spec.md/);
    assert.equal(await evaluate('document.getElementById("permissions-block")'),null);
    controller.permissions=[{id:'perm-2',provider:'grok',title:'Bash',detail:'{"command":"rm"}'}];
    await publish();
    assert.equal(await evaluate('document.getElementById("permission-dialog").open'),true);
    assert.match(await evaluate('document.getElementById("permission-what").textContent'),/Bash/);
    controller.active=savedActive;controller.permissions=savedPerm;await publish();
    await click('#search-toggle');
    await evaluate('document.getElementById("search").value="Opinion";document.getElementById("search").dispatchEvent(new Event("input"))');
    assert.equal(await evaluate('document.querySelectorAll("mark.search-match").length'),2);
    assert.equal(await evaluate('document.getElementById("search-count").textContent'),'1 / 2');
    await click('#search-next');
    assert.equal(await evaluate('document.getElementById("search-count").textContent'),'2 / 2');
    await click('#search-prev');
    assert.equal(await evaluate('document.getElementById("search-count").textContent'),'1 / 2');
    assert.equal(await evaluate('document.querySelectorAll("#feed .message:not([hidden])").length'),4);
    await click('#search-close');
    assert.equal(await evaluate('document.querySelectorAll("mark").length'),0);
    await click('#swap-panels');await pump();
    assert.equal(layout.side,'left');
    assert.ok(await evaluate('document.getElementById("controls-pane").getBoundingClientRect().right < document.getElementById("feed").getBoundingClientRect().left'));
    await evaluate('document.getElementById("panel-divider").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
    await pump();assert.equal(layout.width,360);
    const dividerPoint=await evaluate('(()=>{const r=document.getElementById("panel-divider").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+50)}})()');
    await bidi('input.performActions',{context,actions:[{type:'pointer',id:'divider-mouse',parameters:{pointerType:'mouse'},actions:[
      {type:'pointerMove',x:dividerPoint.x,y:dividerPoint.y},
      {type:'pointerDown',button:0},
      {type:'pointerMove',x:dividerPoint.x+60,y:dividerPoint.y,duration:150},
      {type:'pointerUp',button:0}
    ]}]});
    await pump();assert.ok(layout.width>=418&&layout.width<=425);
    const savedWidth=layout.width;

    assert.equal(await evaluate('document.querySelectorAll("#more-actions button").length'),2);
    assert.equal(await evaluate('document.getElementById("more-actions").hidden'),true);
    await click('#more-toggle');
    assert.equal(await evaluate('document.getElementById("more-actions").hidden'),false);
    await click('#more-toggle');
    assert.equal(await evaluate('document.querySelectorAll("#agents .agent-field select").length'),6);
    assert.equal(await evaluate('document.querySelector("#agents .agent-field select").value'),'');
    await evaluate('(()=>{const b=[...document.querySelectorAll("#agents .agent-mode button")].find(x=>x.textContent==="Правки");b.click()})()');
    await pump();
    assert.equal(state.agents.find(a=>a.id==='claude').mode,'execute');
    await evaluate('(()=>{const b=[...document.querySelectorAll("#agents .agent-mode button")].find(x=>x.textContent==="Чтение");b.click()})()');
    await pump();
    assert.equal(state.agents.find(a=>a.id==='claude').mode,'discuss');
    await click('#agents .reload-models');await pump();
    assert.equal(await evaluate('document.querySelectorAll("#agents .agent-field select")[0].options.length'),3);
    await evaluate('(()=>{const s=document.querySelectorAll("#agents .agent-field select")[0];s.value="model-a";s.onchange()})()');
    await pump();
    assert.equal(state.agents.find(a=>a.id==='claude').model,'model-a');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#agents .agent-field select")[1].options].map(o=>o.value)'),['','low','high']);
    await click('#attach');await pump();
    assert.equal(await evaluate('document.getElementById("draft").value'),'');
    assert.equal(await evaluate('document.querySelectorAll("#attachments details").length'),1);
    assert.equal(await evaluate('document.querySelector("#attachments details").open'),false);
    await click('#popout');await pump();
    assert.equal(await evaluate('document.getElementById("popout").hidden'),true);
    const runsBeforeReload=runs.length;
    await call('Page.navigate',{url:pathToFileURL(pageFile).href});
    await poll('window.trioRequests?.some(m=>m.type==="ready")');await pump();
    assert.equal(runs.length,runsBeforeReload);
    assert.equal(await evaluate('document.getElementById("layout").classList.contains("controls-left")'),true);
    assert.equal(await evaluate('document.getElementById("panel-divider").getAttribute("aria-valuenow")'),String(savedWidth));
    assert.equal(await evaluate('document.querySelectorAll("#attachments details").length'),1);
    assert.equal(await evaluate('document.getElementById("popout").hidden'),true);
    await click('#response-order button:nth-child(2)');
    await send('Проверь приложенный фрагмент');
    assert.equal(state.messages.at(-2).attachments.length,1);
    assert.ok(runs.at(-1).prompt.includes('export const answer = 42'));
    assert.equal(await evaluate('document.querySelectorAll(".message-attachments details").length'),1);
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"f",ctrlKey:true,bubbles:true}))');
    await evaluate('document.getElementById("search").value="export const";document.getElementById("search").dispatchEvent(new Event("input"))');
    assert.equal(await evaluate('document.querySelector(".message-attachments details").open'),true);
    assert.equal(await evaluate('document.querySelector("mark.current-match").textContent'),'export const');
    assert.ok(await evaluate('(()=>{const m=document.querySelector("mark.current-match").getBoundingClientRect(),f=document.getElementById("feed").getBoundingClientRect();return m.top>=f.top&&m.bottom<=f.bottom})()'));
    await evaluate('document.getElementById("search").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))');
    assert.equal(await evaluate('document.getElementById("search-box").hidden'),true);

    await click('#compact-all');await pump();
    assert.ok(compacted.length,'сжатие дошло до движков');
    assert.ok(await evaluate('document.querySelector("#feed").textContent.includes("контекст сжат движком")'));
    await click('#reset-context');
    await pump();
    assert.deepEqual(state.sessions,{});
    assert.ok(await evaluate('document.querySelector("#feed").textContent.includes("Сравните два подхода")'));
    assert.equal(await evaluate('document.querySelectorAll("#handoffs button").length'),0);
    await click('#response-order button:nth-child(2)');
    await send('Fresh question');
    assert.doesNotMatch(runs.at(-1).prompt,/Сравните два подхода|Opinion/);
    assert.equal(runs.at(-1).session,undefined);
    await click('#new-conversation');
    await pump();
    assert.ok(state.messages.length,'один клик не очищает разговор');
    await click('#new-conversation');
    await pump();
    assert.deepEqual(state.messages,[]);
    assert.equal(await evaluate('document.querySelector("#draft").value'),'');
    assert.equal(await evaluate('document.querySelectorAll("#feed .message").length'),0);
    assert.equal(await evaluate('document.querySelectorAll("#response-order [aria-pressed=true]").length'),0);
    assert.equal(fs.readdirSync(path.join(store.dir,'archives')).length,2);
    await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),'no narrow layout overflow');
    assert.deepEqual(errors,[],'no browser exceptions');
    assert.deepEqual(requests.filter(url=>/^https?:/.test(url)),[],'no HTTP requests from chat');
    console.log('Two-column chat Firefox checks passed: search highlights/navigation, panel swap/resize/restore, model and effort dropdowns, mode switch in the card, overflow menu, attachments, reload, detached controls, old/current questions, numbered selection, manual second answer, original question, context reset, new conversation, archive, narrow layout.');
    console.log('Screenshot: '+path.join(root,'queue.png'));

  }finally{
    ws?.close();
    if(child.pid){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
    const expected=path.resolve(root)+path.sep;
    if(!path.resolve(profile).startsWith(expected))throw new Error('Unsafe profile cleanup path');
    try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch{}
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
