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

    const {Controller}=require('../dist/orchestrator/controller');
    const {Store}=require('../dist/storage/store');
    const store=new Store(path.join(root,'state')),state=await store.load();
    let received;
    const labels=['Usage обновился сам, без клика','Таблицы рамкой, не пайпами','Пропустить'];
    const host={root,lockBase:path.join(root,'locks'),jobRunner:'unused',cli:async p=>p,limit:()=>64000,
      timeout:()=>10000,ceiling:()=>3600000,changed:()=>{},trusted:()=>true,prepare:async()=>undefined,compact:async()=>{}};
    const controller=new Controller(state,store,host,async o=>{
      received=await o.question([{id:'choice',prompt:'Что уже работает?',multi:true,options:labels.map(label=>({label}))}]);
      return {text:'Ответ принят',interrupted:false};
    });
    const webview=path.resolve(__dirname,'../webview'),nonce='trioQuestionCheck';
    const {renderPanelHtml}=require('../dist/ui/panelConnection');
    const html=renderPanelHtml(fs.readFileSync(path.join(webview,'main.html'),'utf8'),
      fs.readFileSync(path.join(webview,'main.css'),'utf8'),fs.readFileSync(path.join(webview,'composer.js'),'utf8'),
      fs.readFileSync(path.join(webview,'main.js'),'utf8'),nonce,'file:',require('../package.json').version);
    const pageFile=path.join(root,'questions.html');fs.writeFileSync(pageFile,html);
    await call('Page.addScriptToEvaluateOnNewDocument',{source:
      'window.trioRequests=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.trioRequests.push(m),getState:()=>undefined,setState:()=>{}});'});
    await call('Emulation.setDeviceMetricsOverride',{width:1280,height:1080});
    await call('Page.navigate',{url:pathToFileURL(pageFile).href});
    await poll('window.trioRequests?.some(m=>m.type==="ready")');
    const publish=()=>evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({
      type:'state',state,active:controller.active,permissions:controller.permissions})+'}))');
    await controller.send('Жека, задай вопрос','codex');
    const deadline=Date.now()+5000;
    while(!state.messages.some(m=>m.question)){if(Date.now()>deadline)throw new Error('Question did not arrive');await delay(20);}
    await publish();
    const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
    assert.equal(await evaluate('document.querySelector("#question-dialog").open'),true);
    await delay(1100);
    assert.equal(await evaluate('document.querySelector("#floor-title").textContent'),'Ждёт ответа');
    assert.equal(await evaluate('document.querySelectorAll("#feed .message:not([hidden])").length'),2);
    assert.equal(await evaluate("document.querySelector('.question-multi') === null"),true);
    await click('.question-choice:nth-of-type(1)');
    await click('.question-choice:nth-of-type(1)');
    await click('.question-choice:nth-of-type(1)');
    await click('.question-choice:nth-of-type(2)');
    const longAnswer='Свой длинный ответ: хочу видеть варианты, добавление и отправку отдельными понятными группами, без разбросанных кнопок.';
    for(const text of ['Свой, первый',longAnswer,longAnswer]){
      await evaluate('document.querySelector(".question-free").value='+JSON.stringify(text));
      await evaluate('document.querySelector(".question-free").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
      assert.equal(await evaluate('document.querySelector(".question-free").value'),'');
    }
    assert.equal(await evaluate('document.querySelectorAll(".question-choice").length'),5);
    assert.equal(await evaluate('document.querySelectorAll(".question-choice[aria-checked=true]").length'),4);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".question-mark")].map(x=>x.textContent)'),['☑','☑','☐','☑','☑']);
    fs.mkdirSync(path.resolve('.protocol-tmp'),{recursive:true});
    for(const [width,height] of [[1280,1080],[460,600],[320,480]]){
      await call('Emulation.setDeviceMetricsOverride',{width,height});await delay(80);
      const layout=await evaluate('('+function(){
        const q=s=>document.querySelector(s),rect=s=>q(s).getBoundingClientRect().toJSON();
        const body=q('#question-body'),dialog=q('#question-dialog');
        return {cancel:rect('#question-deny'),done:rect('.question-done'),footer:rect('#question-actions'),
          field:rect('.question-free'),add:rect('.question-add'),height:innerHeight,
          overflow:Math.max(body.scrollWidth-body.clientWidth,dialog.scrollWidth-dialog.clientWidth),
          removals:[...document.querySelectorAll('.question-remove')].map(b=>({button:b.getBoundingClientRect().toJSON(),row:b.parentElement.getBoundingClientRect().toJSON()}))};
      }+')()');
      assert.equal(layout.cancel.y,layout.done.y,'footer actions share a row at '+width);
      assert.equal(layout.cancel.height,layout.done.height);
      assert(layout.cancel.right<layout.done.left,'cancel left, submit right');
      assert(layout.footer.bottom<=layout.height,'footer stays visible');
      assert.equal(layout.field.y,layout.add.y,'input and Add align');
      assert.equal(layout.field.height,layout.add.height);
      assert(layout.overflow<=1,'no horizontal overflow at '+width);
      for(const {button,row} of layout.removals)assert(button.left>=row.left&&button.right<=row.right&&button.top>=row.top&&button.bottom<=row.bottom,'remove inside own option');
      await evaluate('document.querySelector("#question-body").scrollTop=0');
      const screenshot=await call('Page.captureScreenshot');
      fs.writeFileSync(path.resolve('.protocol-tmp/questions-'+width+'.png'),Buffer.from(screenshot.data,'base64'));
      if(width===1280)fs.writeFileSync(path.resolve('.protocol-tmp/questions.png'),Buffer.from(screenshot.data,'base64'));
    }
    await call('Emulation.setDeviceMetricsOverride',{width:1280,height:1080});

    await evaluate('[...document.querySelectorAll(".question-remove")].at(-1).click()');
    await click('.question-done');await click('.question-done');
    const answers=await evaluate('window.trioRequests.filter(m=>m.type==="answer")');
    assert.equal(answers.length,1);
    assert.deepEqual(answers[0].answers.choice,[labels[0],labels[1],'Свой, первый']);
    controller.answer(answers[0].requestId,answers[0].answers);await controller.idle();await publish();
    assert.deepEqual(received,answers[0].answers);
    assert.equal(await evaluate('document.querySelector("#question-dialog").open'),false);
    assert.equal(await evaluate('document.querySelectorAll(".question-card").length'),1);
    assert.equal(await evaluate('document.querySelectorAll(".question-card .picked").length'),3);
    assert.equal((await store.load()).messages.filter(m=>m.question).length,1);
    assert.deepEqual(errors,[],'no browser exceptions');
    assert.deepEqual(requests.filter(url=>/^https?:/.test(url)),[],'no HTTP requests from the panel');
    console.log('Firefox questions: PASS (footer layout at 1280/460/320 px, long custom answer, checkboxes, Enter, removal, one submission, controller and storage).');
    console.log('Screenshot: '+path.resolve('.protocol-tmp/questions.png'));
  }finally{
    ws?.close();
    if(child.pid){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
    const expected=path.resolve(root)+path.sep;
    if(!path.resolve(profile).startsWith(expected))throw new Error('Unsafe profile cleanup path');
    try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch{}
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
