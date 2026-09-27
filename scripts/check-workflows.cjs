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
    const {snapshot,compare}=require('../dist/snapshots/snapshots');
    const {codexApproval}=require('../dist/providers/codexProtocol');
    const evidence=path.resolve('.protocol-tmp/workflows');fs.mkdirSync(evidence,{recursive:true});
    const results=[],pending=[];
    const limits={file:4096,total:16384,count:30,excludes:[]};
    let controller,state,store,host,runs,notes,scenario,project,caseNo=0;
    let program=async()=>({text:'Готово',interrupted:false}),compactProgram=async()=>{};
    let changeLists=[];
    const nonce='trioWorkflowCheck',webview=path.resolve(__dirname,'../webview');
    const {renderPanelHtml}=require('../dist/ui/panelConnection');
    const html=renderPanelHtml(fs.readFileSync(path.join(webview,'main.html'),'utf8'),
      fs.readFileSync(path.join(webview,'main.css'),'utf8'),fs.readFileSync(path.join(webview,'composer.js'),'utf8'),
      fs.readFileSync(path.join(webview,'main.js'),'utf8'),nonce,'file:',require('../package.json').version);
    const pageFile=path.join(root,'workflows.html');fs.writeFileSync(pageFile,html);
    await call('Page.addScriptToEvaluateOnNewDocument',{source:'window.trioRequests=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.trioRequests.push(m),getState:()=>undefined,setState:()=>{}});'});
    async function publish(){
      await evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({
        type:'state',state,active:controller.active,progress:controller.progress,permissions:controller.permissions,
        compacting:controller.compacting,layout:{side:'right',width:400},deltas:controller.deltaHints()})+'}))');
    }
    async function pump(){
      const posted=await evaluate('window.trioRequests.splice(0)');
      for(const m of posted){
        let data;
        switch(m.type){
          case 'draft':state.draft=m.text;state.recipient=m.recipient;state.responseOrder=m.responseOrder;break;
          case 'send':await controller.send(m.text,m.recipient,m.responseOrder,m.attachments);break;
          case 'handoff':await controller.handoff(m.provider,m.turnId);break;
          case 'flags':await controller.setFlags(m);break;
          case 'agent':await controller.configure(m.agent);break;
          case 'stop':await controller.stop(m.provider);break;
          case 'retry':await controller.retry(m.turnId);break;
          case 'discard':await controller.discard(m.turnId);break;
          case 'permission':controller.permission(m.requestId,m.allow,m.whole,m.standing);break;
          case 'compact':{
            const done=controller.compact(m.provider).then(()=>ack(m)).catch(e=>{throw e;});
            pending.push(done);await publish();continue;
          }
          case 'changes':{
            const task=[...state.turns,...state.tasks].find(t=>t.id===m.taskId);
            changeLists.push(await compare(project,task.snapshot,limits));break;
          }
          case 'ready':case 'pong':break;
          default:throw new Error('Unhandled browser request '+m.type);
        }
        await publish();await ack(m,data);
      }
    }
    async function ack(m,data){await evaluate('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({type:'ack',requestId:m.clientRequestId,clientId:m.clientId,data})+'}))');}
    async function click(selector){await evaluate('(()=>{const b=document.querySelector('+JSON.stringify(selector)+');if(!b)throw Error("Missing button");if(b.disabled)throw Error("Disabled button");b.click()})()');await pump();}
    async function clickText(selector,text){await evaluate('(()=>{const b=[...document.querySelectorAll('+JSON.stringify(selector)+')].find(b=>b.textContent==='+JSON.stringify(text)+');if(!b||b.disabled)throw Error("Missing enabled button: "+'+JSON.stringify(text)+');b.click()})()');await pump();}
    async function send(text){if(!await evaluate('[...document.querySelectorAll("#response-order button")].some(b=>/^\\d+ Жека$/.test(b.textContent))'))await clickText('#response-order button','Жека');await evaluate('document.querySelector("#draft").value='+JSON.stringify(text)+';document.querySelector("#composer").requestSubmit()');await pump();}
    async function waitFor(fn){const until=Date.now()+10000;while(!fn()){if(Date.now()>until)throw Error('State timeout: '+fn);await delay(25);}await publish();}
    async function idle(){await controller.idle();await publish();}
    async function setup(label,width=1280){
      scenario=label;caseNo++;project=path.join(root,'case-'+caseNo,'project');fs.mkdirSync(project,{recursive:true});
      store=new Store(path.join(root,'case-'+caseNo,'state'));state=await store.load();
      state.agents.forEach(a=>{a.enabled=true;a.mode='execute';});
      state.recipient='codex';state.responseOrder=['codex'];runs=[];notes=[];changeLists=[];program=async()=>({text:'Готово',interrupted:false});
      compactProgram=async()=>{};
      host={root:project,lockBase:path.join(root,'locks'),jobRunner:'unused',cli:async p=>p,limit:()=>64000,
        timeout:()=>10000,ceiling:()=>60000,trusted:()=>true,changed:()=>{},notify:(kind,text)=>notes.push({kind,text}),
        prepare:async turn=>{const dest=path.join(root,'case-'+caseNo,'snap-'+turn.id);await snapshot(project,dest,limits);return dest;},
        compact:o=>compactProgram(o)};
      controller=new Controller(state,store,host,async o=>{runs.push(o);await o.onSession('fixture-'+o.provider);return program(o);});
      await call('Emulation.setDeviceMetricsOverride',{width,height:1080});
      await call('Page.navigate',{url:pathToFileURL(pageFile).href});
      await poll('window.trioRequests?.some(m=>m.type==="ready")');await pump();
    }
    function longProcess(o){
      return new Promise((resolve,reject)=>{
        const p=spawn(process.execPath,['-e','console.log("ready");setInterval(()=>console.log("working"),100)'],{cwd:project,windowsHide:true,stdio:['ignore','pipe','pipe']});
        let text='';const abort=()=>p.kill();o.signal.addEventListener('abort',abort,{once:true});
        p.stdout.on('data',chunk=>{if(!text){text='Частичный ответ';o.text(text);}o.progress('Тестовый процесс работает');});
        p.on('error',reject);p.on('close',()=>{o.signal.removeEventListener('abort',abort);resolve({text,interrupted:o.signal.aborted});});
      });
    }
    async function shot(name){const v=await call('Page.captureScreenshot');fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(v.data,'base64'));}
    async function check(label,fn){
      if(process.env.TRIO_WORKFLOW_CASE&&!new RegExp(process.env.TRIO_WORKFLOW_CASE).test(label))return;
      try{await fn();results.push({label,status:'PASS'});console.log('PASS '+label);}
      catch(e){results.push({label,status:'FAIL',error:String(e)});console.log('FAIL '+label+': '+e);await shot('failure-'+caseNo).catch(()=>{});}
      finally{if(state)fs.writeFileSync(path.join(evidence,'state-'+caseNo+'.json'),JSON.stringify(state,null,2));if(controller?.busy){await controller.stop();await controller.idle();}}
    }

    await check('Codex quota names and percentages in the usage dialog',async()=>{
      await setup('codex-usage');
      const {extractQuotas}=require('../dist/providers/adapter');
      const raw=require('../tests/fixtures/codex-rate-limits.json');
      controller.rememberQuota('codex',raw);
      await publish();
      await evaluate('document.querySelector(".usage-one[data-provider=codex]").click()');
      const request=(await evaluate('window.trioRequests.splice(0)')).find(m=>m.type==='usage');
      assert(request);
      await ack(request,{title:'Жека — расход',quotas:extractQuotas(raw),occupancy:{percent:39,tokens:99873,window:258400}});
      await poll('document.querySelector("#usage-dialog").open');
      for(const width of [1280,450,320]){
        await call('Emulation.setDeviceMetricsOverride',{width,height:844});
        const rows=await evaluate('[...document.querySelectorAll("#usage-body .usage-row")].map(row=>({label:row.querySelector(".usage-row-head span").textContent,fill:row.querySelector(".usage-bar-fill").style.width}))');
        assert.equal(rows.length,5);
        assert.equal(new Set(rows.map(r=>r.label)).size,5);
        assert.match(rows[0].label,/^Codex/);
        assert.deepEqual(rows.map(r=>r.fill),['43%','0%','0%','0%','39%']);
        assert.equal(await evaluate('document.querySelector(".usage-one[data-provider=codex] .usage-fill").style.width'),'43%');
        assert(await evaluate('(()=>{const d=document.querySelector("#usage-dialog");return d.scrollWidth<=d.clientWidth+1&&[...d.querySelectorAll(".usage-row-head")].every(h=>h.scrollWidth<=h.clientWidth+1)})()'),'usage overflow at '+width);
        await shot('codex-usage-'+width);
      }
    });
    await check('Queue height, FIFO and narrow viewport',async()=>{
      await setup('queue');program=longProcess;
      await click('#auto-reply-work');await send('Первый цикл');await waitFor(()=>state.messages.some(m=>m.text==='Частичный ответ'));
      await send('Второй вопрос '+ 'длинная подпись '.repeat(40));
      const sizes=[];
      const measure=()=>evaluate('(()=>{const work=document.querySelector(".work-head").closest(".control-block");const q=document.querySelector("#queued").getBoundingClientRect();return {work:work.getBoundingClientRect().height,queue:q.height,scroll:document.documentElement.scrollWidth,width:innerWidth}})()');
      sizes.push(await measure());
      for(let n=3;n<=8;n++)await send('Вопрос '+n);
      sizes.push(await measure());
      assert.match(await evaluate('document.querySelector("#queued .queue-title").textContent'),/Второй вопрос/);
      assert.equal(await evaluate('document.querySelectorAll("#older-rows .queued-question").length'),6);
      assert.equal(await evaluate('document.querySelector("#older-queue").open'),false);
      await shot('queue-desktop');
      // Compare both directions at each width, including removal of an open list.
      const queued=[...state.queue],firstOnly=[queued[0]];
      const stable=(a,b,label)=>assert(Math.abs(a.work-b.work)<=1,label+': '+(b.work-a.work)+' px');
      stable(sizes[0],sizes[1],'Collapsed queue changes desktop height');
      for(const width of [1280,390,320]){
        await call('Emulation.setDeviceMetricsOverride',{width,height:width===1280?1080:844});
        await publish();const collapsed=await measure();
        assert(collapsed.scroll<=collapsed.width+1,'horizontal page overflow');
        const header=await evaluate('(()=>{const h=document.querySelector(".queue-part h2").getBoundingClientRect(),s=document.querySelector("#older-summary").getBoundingClientRect();return {sameRow:Math.abs(h.top-s.top)<2,noOverlap:h.right-parseFloat(getComputedStyle(document.querySelector(".queue-part h2")).paddingRight)<=s.left}})()');
        assert(header.sameRow&&header.noOverlap,'queue disclosure overlaps heading at '+width);
        await click('#older-summary');const expanded=await measure();
        assert(expanded.work>collapsed.work+20,'Opening queue should expose rows');
        assert.equal(await evaluate('document.querySelector("#older-queue").open'),true);
        if(width===390)await shot('queue-narrow');
        await click('#older-summary');stable(collapsed,await measure(),'Closing queue at '+width);
        state.queue=firstOnly;await publish();stable(collapsed,await measure(),'Removing other questions at '+width);
        state.queue=queued;await publish();stable(collapsed,await measure(),'Adding other questions at '+width);
        assert.equal(await evaluate('document.querySelector("#older-queue").open'),false);
        await click('#older-summary');
        state.queue=firstOnly;await publish();stable(collapsed,await measure(),'Emptying open list at '+width);
        state.queue=queued;await publish();stable(collapsed,await measure(),'Restored list starts collapsed at '+width);
        sizes.push({width,...await measure()});
      }
      console.log('QUEUE_MEASURE '+JSON.stringify(sizes));
    });
    await check('Stop one freezes queued cycles; Stop all disables Auto',async()=>{
      await setup('stops');program=longProcess;
      await click('#auto-reply-work');await send('Первый');await waitFor(()=>state.messages.some(m=>m.text==='Частичный ответ'));
      await send('Второй');await send('Третий');
      await click('#agents .agent:nth-child(2) .stop-one');await idle();
      assert.equal(runs.length,1);assert.equal(state.autoReply,true);assert.equal(state.queue.length,2);
      assert.equal(state.turns[0].status,'interrupted');assert(state.messages.some(m=>m.partial&&m.text==='Частичный ответ'));
      assert.equal(await evaluate('document.querySelector("#queued .next").disabled'),false);
      const saved=await store.load();assert.equal(saved.queue.length,2);assert.equal(saved.autoReply,true);
      await click('#queued .next');await waitFor(()=>runs.length===2&&state.messages.some(m=>m.turn===state.turns[1].id&&m.text==='Частичный ответ'));
      await click('#stop-all');await idle();assert.equal(state.autoReply,false);assert.equal(state.queue.length,1);assert.equal(runs.length,2);
      assert.equal(await evaluate('document.querySelector("#auto-reply-work").getAttribute("aria-pressed")'),'false');
    });
    await check('Failure and Retry preserve question, recipient and mode',async()=>{
      await setup('retry');program=async()=>runs.length===1?{text:'',error:'Тестовый сбой',interrupted:false}:{text:'Повтор успешен',interrupted:false};
      await send('Проверка повтора');await idle();const first=state.turns[0];
      assert.equal(first.status,'failed');assert.equal(first.mode,'execute');
      await clickText('#feed button','Повторить');await idle();
      const second=state.turns.at(-1);
      for(const field of ['messageId','recipient','mode'])assert.equal(second[field],first[field],field);
      assert.equal(second.status,'completed');assert.equal(state.messages.filter(m=>m.author==='Антон').length,1);
      assert.equal((await store.load()).turns.at(-1).status,'completed');
    });
    await check('Deletion denial: grey line, stopped queue, Retry button',async()=>{
      await setup('denial');
      program=async o=>{
        const req=codexApproval('item/fileChange/requestApproval',{itemId:'file'},
          {changes:[{path:path.join(project,'delete.txt'),kind:{type:'delete'},diff:''}]});
        return (await o.permission(req.title,req.detail))?{text:'Разрешено',interrupted:false}:{text:'',denied:req.title,interrupted:false};
      };
      await click('#auto-edits');await click('#auto-reply-work');await send('Удаление');await waitFor(()=>controller.permissions.length===1);
      assert.equal(controller.permissions[0].standing,false);
      assert.equal(await evaluate('document.querySelector("#permission-standing").hidden'),true);
      assert.match(await evaluate('document.querySelector("#permission-detail").textContent'),/delete.txt/);
      // Modal blocks composer; queue the already-authorized next request via the same controller.
      await controller.send('Следующий вопрос','codex');await publish();
      await click('#permission-deny');await idle();
      assert.equal(runs.length,1);assert.equal(state.queue.length,1);assert.equal(state.turns[0].status,'failed');
      assert(!state.messages.some(m=>m.error));
      const denial=state.messages.find(m=>m.control&&m.turn===state.turns[0].id);assert(denial);
      assert.equal(await evaluate('[...document.querySelectorAll("#feed button")].filter(b=>b.textContent==="Повторить").length'),1);
      assert.equal(await evaluate('document.querySelectorAll("#feed .error").length'),0);
      await shot('denial');
    });
    await check('Command-chain standing and readable trace through modal buttons',async()=>{
      await setup('standing');
      program=async o=>{
        const cmd='powershell.exe -Command "cd C:/test; git status"';
        for(const command of [cmd,cmd,'git status']){
          const req=codexApproval('item/commandExecution/requestApproval',{command});
          if(!await o.permission(req.title,req.detail))return {text:'',denied:req.title,interrupted:false};
        }
        o.trace([{id:'think',kind:'thought',title:'Проверяю цепочку',status:'done'},
          {id:'tool',kind:'tool',title:'git status',status:'done'}]);
        return {text:'Цепочка пройдена',interrupted:false};
      };
      await send('Цепочка');await waitFor(()=>controller.permissions.length===1);
      assert.match(await evaluate('document.querySelector("#permission-title").textContent'),/cd C:\/test; git status/);
      assert.equal(await evaluate('document.querySelector("#permission-standing").hidden'),false);
      await click('#permission-standing');
      await waitFor(()=>controller.permissions.length===1&&controller.permissions[0].caption==='git status');
      await click('#permission-once');await idle();
      assert.equal(runs.length,1);assert.equal(notes.filter(n=>n.kind==='permission').length,2);
      assert.equal(state.turns[0].trace.length,2);
      assert.equal(await evaluate('document.querySelectorAll("#feed .trace-item").length'),2);
      // Same chain on a later turn stays approved; standalone status still asks.
      await send('Та же цепочка');await waitFor(()=>controller.permissions.length===1);
      assert.equal(controller.permissions[0].caption,'git status');
      await click('#permission-once');await idle();assert.equal(runs.length,2);
    });
    await check('Actual temporary files and snapshots via permission buttons',async()=>{
      await setup('files');fs.writeFileSync(path.join(project,'modified.txt'),'before');
      fs.writeFileSync(path.join(project,'deleted.txt'),'old');
      program=async o=>{
        for(const [file,type] of [['created.txt','add'],['modified.txt','update'],['deleted.txt','delete']]){
          const req=codexApproval('item/fileChange/requestApproval',{itemId:file},
            {changes:[{path:path.join(project,file),kind:{type},diff:''}]});
          if(!await o.permission(req.title,req.detail))return {text:'',denied:req.title,interrupted:false};
          if(type==='delete')fs.unlinkSync(path.join(project,file));else fs.writeFileSync(path.join(project,file),'after');
        }
        return {text:'Файлы изменены',interrupted:false};
      };
      await send('Файлы');await waitFor(()=>controller.permissions.length===1);
      assert.match(controller.permissions[0].detail,/created.txt/);await click('#permission-standing');
      await waitFor(()=>controller.permissions.length===1&&/deleted.txt/.test(controller.permissions[0].detail));
      assert.equal(controller.permissions[0].standing,false);await click('#permission-once');await idle();
      await clickText('#feed button','Изменения файлов');
      assert.deepEqual(changeLists[0].map(c=>[c.path,c.kind]).sort(),[['created.txt','created'],['deleted.txt','deleted'],['modified.txt','modified']]);
      assert.equal(fs.readFileSync(path.join(project,'modified.txt'),'utf8'),'after');
      assert(!fs.existsSync(path.join(project,'deleted.txt')));
    });

    await check('Whole-turn permission expires; auto-commands still ask for danger',async()=>{
      await setup('whole-turn');
      program=async o=>{
        for(const command of ['node first.cjs','node second.cjs']){
          const req=codexApproval('item/commandExecution/requestApproval',{command});
          if(!await o.permission(req.title,req.detail))return {text:'',denied:req.title,interrupted:false};
        }
        return {text:'Ход разрешён',interrupted:false};
      };
      await send('Первый ход');await waitFor(()=>controller.permissions.length===1);
      await click('#permission-whole');await idle();
      assert.equal(notes.filter(n=>n.kind==='permission').length,1,'second command should be covered');
      assert.equal(state.turns[0].status,'completed');
      await send('Новый ход');await waitFor(()=>controller.permissions.length===1);
      assert.equal(notes.filter(n=>n.kind==='permission').length,2,'new turn should ask again');
      await click('#permission-deny');await idle();
      await click('#auto-commands');
      program=async o=>{
        for(const command of ['node ordinary.cjs','powershell.exe -Command "Remove-Item danger.txt"']){
          const req=codexApproval('item/commandExecution/requestApproval',{command});
          if(!await o.permission(req.title,req.detail))return {text:'',denied:req.title,interrupted:false};
        }
        return {text:'Команды разрешены',interrupted:false};
      };
      await send('Команды');await waitFor(()=>controller.permissions.length===1);
      assert.match(controller.permissions[0].detail,/Remove-Item/);
      assert.equal(controller.permissions[0].standing,false);
      assert.equal(await evaluate('document.querySelector("#permission-standing").hidden'),true);
      await click('#permission-deny');await idle();
      assert.equal(state.turns.at(-1).status,'failed');
      assert.equal(state.autoCommands,true);
    });
    await check('Long permission path keeps the filename visible',async()=>{
      await setup('caption');
      program=async o=>{
        const req=codexApproval('item/fileChange/requestApproval',{itemId:'f'},
          {changes:[{path:path.join(project,'unique-target.txt'),kind:{type:'delete'},diff:''}]});
        await o.permission(req.title,req.detail);return {text:'',interrupted:true};
      };
      await send('Путь');await waitFor(()=>controller.permissions.length===1);
      const fullPath=path.join(project,'unique-target.txt');
      for(const width of [1280,390,320]){
        await call('Emulation.setDeviceMetricsOverride',{width,height:844});await publish();
        for(const selector of ['#permission-title','#permission-what','#floor-detail']){
          assert.match(await evaluate('document.querySelector('+JSON.stringify(selector)+').textContent'),/unique-target.txt/);
        }
        assert((await evaluate('document.querySelector("#permission-detail").textContent')).includes(JSON.stringify(fullPath).slice(1,-1)));
        const bounds=await evaluate('(()=>{const d=document.querySelector("#permission-dialog"),h=document.querySelector("#permission-title");return {overflow:d.scrollWidth-d.clientWidth,headingOverflow:h.scrollWidth-h.clientWidth}})()');
        assert(bounds.overflow<=1&&bounds.headingOverflow<=1,'permission dialog overflow at '+width);
        await shot('permission-path-'+width);
      }
      // An exceptionally long basename must wrap instead of being clipped or shortened.
      const longName='very-long-filename-'.repeat(8)+'.txt';
      const {permissionCaption}=require('../dist/shared/model');
      controller.permissions[0]={...controller.permissions[0],id:'long-basename',
        caption:permissionCaption('Изменение файлов',JSON.stringify({path:project+'/'+longName}))};
      await publish();
      assert((await evaluate('document.querySelector("#permission-title").textContent')).endsWith(longName));
      assert(await evaluate('(()=>{const h=document.querySelector("#permission-title");return h.scrollWidth<=h.clientWidth+1})()'));
      await shot('permission-long-basename');
    });
    await check('Read-only work has no empty auto-edit entry',async()=>{
      await setup('reads');fs.writeFileSync(path.join(project,'read.txt'),'content');
      program=async o=>{assert.equal(fs.readFileSync(path.join(project,'read.txt'),'utf8'),'content');o.trace([{id:'read',kind:'tool',title:'read.txt',status:'done'}]);return {text:'Файл прочитан',interrupted:false};};
      await click('#auto-edits');await send('Прочитай');await idle();
      assert(!state.messages.some(m=>/Автоправки/.test(m.text)&&!m.actions?.length));
      assert.deepEqual(await compare(project,state.turns[0].snapshot,limits),[]);
    });
    await check('Compaction button waits, clears cursor and resends history',async()=>{
      await setup('compact');await send('Первая запись');await idle();
      const key='codex:execute';assert(state.sessions[key].through);
      let release;compactProgram=()=>new Promise(r=>release=r);
      await clickText('#agents .agent:nth-child(2) .agent-actions button','Сжать');
      assert.equal(controller.compacting,'codex');
      assert.match(await evaluate('document.querySelector("#floor-title").textContent'),/сжатие/);
      assert(state.sessions[key].through,'cursor retained until completion');
      release();await Promise.all(pending.splice(0));await publish();
      assert.equal(controller.compacting,undefined);assert.equal(state.sessions[key].through,undefined);
      await send('После сжатия');await idle();assert.match(runs.at(-1).prompt,/Первая запись/);
      assert.equal((await store.load()).turns.at(-1).status,'completed');
    });
    assert.deepEqual(errors,[],'No browser exceptions');
    assert.deepEqual(requests.filter(url=>/^https?:/.test(url)),[],'No model/network requests from panel');
    fs.writeFileSync(path.join(evidence,(process.env.TRIO_WORKFLOW_CASE?'result-extra.json':'result.json')),JSON.stringify({version:require('../package.json').version,results},null,2));
    console.log('Evidence: '+evidence);
    if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
  }finally{
    ws?.close();
    if(child.pid){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
    const expected=path.resolve(root)+path.sep;
    if(!path.resolve(profile).startsWith(expected))throw new Error('Unsafe profile cleanup path');
    try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch{}
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
