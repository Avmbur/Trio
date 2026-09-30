const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {
  addAttachment, insertAtCursor, normalizeSnippets, filterSnippets, snippetCreateSource,
  snippetUndoPush, snippetUndoApply, moveSnippet,
  duplicateSnippet, upsertSnippet, removeSnippet, flagsHint, captureFlags, flagsActive, snippetLimits
} = require('../webview/composer');

// The fake DOM below only resolves the first match, so collections are walked by hand.
function collect(node, className, out = []) {
  for (const child of node.children || []) {
    if ((child.className || '').split(' ').includes(className)) out.push(child);
    collect(child, className, out);
  }
  return out;
}

// Search highlights text nodes. The fake DOM keeps element text in textContent until then.
function placeChildren(parent, nodes) {
  parent.childNodes = nodes;
  if (!parent.children) parent.children = [];
  for (const n of nodes) {
    n.parentNode = parent;
    n.parentElement = parent;
    if (parent.tag) n.parent = parent;
    if (n.tag && !parent.children.includes(n)) parent.children.push(n);
  }
}
function spliceNode(node, parts) {
  const parent = node.parentNode || node.parentElement || node.parent;
  if (!parent) return;
  const flat = [];
  for (const part of parts) {
    if (part && part.nodeType === 11) flat.push(...part.childNodes);
    else flat.push(part);
  }
  if (node.virtual) {
    parent.textContent = '';
    if (parent.children) parent.children = parent.children.filter(c => c !== node);
    placeChildren(parent, flat);
    return;
  }
  const list = (parent.childNodes || []).slice();
  const at = list.indexOf(node);
  if (at >= 0) list.splice(at, 1, ...flat);
  else list.push(...flat);
  if (parent.children) parent.children = parent.children.filter(c => c !== node);
  placeChildren(parent, list);
}

function webview() {
  const html = fs.readFileSync('webview/main.html', 'utf8');
  class Element {
    constructor(tag='div') {
      this.tag=tag;this.tagName=tag.toUpperCase();this.listeners={};this.children=[];this.value='';this.disabled=false;this.textContent='';
      this.hidden=false;this.className='';this.dataset={};this.attributes={};
      this.scrollHeight=0;this.scrollTop=0;this.clientHeight=0;
      this.checked=false;this.title='';this.draggable=false;
      this.style={setProperty:()=>{}};
      const tokens=()=>this.className.split(/\s+/).filter(Boolean);
      this.classList={
        add:(...names)=>{this.className=[...new Set([...tokens(),...names])].join(' ');},
        remove:(...names)=>{const drop=new Set(names);this.className=tokens().filter(n=>!drop.has(n)).join(' ');},
        toggle:(name,force)=>{const on=force===undefined?!tokens().includes(name):!!force;this.classList[on?'add':'remove'](name);return on;},
        contains:name=>tokens().includes(name)
      };
    }
    append(...children) {for(const child of children) this.insertBefore(child, null);}
    get firstElementChild() {return this.children[0] || null;}
    get nextElementSibling() {
      const kids = this.parent?.children || [];
      const at = kids.indexOf(this);
      return at < 0 ? null : kids[at + 1] || null;
    }
    insertBefore(node, before) {
      if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node);
      node.parent = this; node.parentNode = this; node.parentElement = this;
      if (before == null) this.children.push(node);
      else {
        const at = this.children.indexOf(before);
        if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
      }
      return node;
    }
    addEventListener(name, fn) {this.listeners[name]=fn;}
    click() {if(!this.disabled)this.onclick?.();}
    replaceChildren(...children) {this.children=[];this.childNodes=null;this.append(...children);}
    remove() {if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}
    setAttribute(key,value) {this.attributes[key]=value;}
    querySelector(selector) {
      const [first,...tail]=selector.split(' ');
      for(const child of this.children) {
        const matches=first.startsWith('.')?child.className.split(' ').includes(first.slice(1)):child.tag===first;
        if(matches) {if(!tail.length)return child;const nested=child.querySelector(tail.join(' '));if(nested)return nested;}
        const nested=child.querySelector(selector);if(nested)return nested;
      }
      return null;
    }
    querySelectorAll(selector) {
      const out=[];
      const walk=node=>{
        for(const child of node.children||[]){
          const matches=selector.startsWith('.')?child.className.split(' ').includes(selector.slice(1)):child.tag===selector;
          if(matches) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
    closest(selector) {
      for(let node=this;node;node=node.parent){
        if(selector.startsWith('.') && (node.className||'').split(' ').includes(selector.slice(1))) return node;
      }
      return null;
    }
    getBoundingClientRect() {return {left:0,top:0,right:0,bottom:0,width:0,height:0};}
    focus() {this.focused=true;}
    scrollIntoView() {this.scrolled=true;}
    normalize() {
      if (!this.childNodes) return;
      const out=[];
      for (const n of this.childNodes) {
        const prev=out[out.length-1];
        if (n.nodeType===3 && prev && prev.nodeType===3) prev.textContent+=n.textContent;
        else out.push(n);
      }
      this.childNodes=out;
    }
    replaceWith(...parts) {spliceNode(this, parts);}
    setSelectionRange(start,end) {this.selectionStart=start;this.selectionEnd=end;}
    showModal() {this.open=true;}
    close() {this.open=false;}
  }
  const nodes = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1],new Element()]));
  nodes['search-box'].hidden = true;
  const sent = [], listeners = {}, execCalls = [], timers = [];
  let state;
  const context = vm.createContext({
    document: {
      addEventListener:()=>{},
      createElement:tag=>new Element(tag),
      getElementById: id => {assert.ok(nodes[id], id); return nodes[id];},
      createTextNode: text => {
        const node={nodeType:3, textContent:String(text), parentNode:null, parentElement:null, parent:null};
        node.replaceWith=(...parts)=>spliceNode(node, parts);
        return node;
      },
      createDocumentFragment: () => {
        const fragment={nodeType:11, childNodes:[]};
        fragment.append=(...nodes)=>{for(const n of nodes) fragment.childNodes.push(n);};
        return fragment;
      },
      createTreeWalker: root => {
        const list=[];
        const walk=el=>{
          if (!el || typeof el!=='object') return;
          if (el.nodeType===3) {list.push(el); return;}
          if (el.childNodes && el.childNodes.length) {for(const n of el.childNodes) walk(n); return;}
          if (el.children && el.children.length) {for(const c of el.children) walk(c); return;}
          if (el.textContent) {
            const node={nodeType:3, textContent:el.textContent, parentNode:el, parentElement:el, virtual:true};
            node.replaceWith=(...parts)=>spliceNode(node, parts);
            list.push(node);
          }
        };
        walk(root);
        let i=0;
        return {currentNode:null, nextNode(){if(i>=list.length) return null; this.currentNode=list[i++]; return this.currentNode;}};
      },
      execCommand: (cmd, ui, value) => {
        execCalls.push({cmd, ui, value});
        if (cmd !== 'insertText') return false;
        const ta = nodes.draft;
        const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : (ta.value || '').length;
        const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start;
        const next = insertAtCursor(ta.value, start, end, String(value || ''));
        ta.value = next.value;
        ta.selectionStart = ta.selectionEnd = next.caret;
        return true;
      }
    },
    NodeFilter: {SHOW_TEXT: 4},
    window: {addEventListener: (name, handler) => {listeners[name] = handler;}, innerHeight: 800},
    acquireVsCodeApi: () => ({
      postMessage: value => sent.push(value), getState: () => state, setState: value => {state = value;}
    }),
    // Unref'd so a notice waiting to fade does not hold the test process open.
    setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref?.();timers.push({fn,ms,t});return t;}, clearTimeout, setInterval:()=>0, clearInterval:()=>{}, console,
    FileReader: class {
      readAsDataURL(file) {this.result = 'data:' + file.type + ';base64,' + file.body; this.onload?.();}
    }
  });
  vm.runInContext(fs.readFileSync('webview/composer.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('webview/main.js', 'utf8'), context);
  const requests = type => sent.filter(m => m.type === type);
  const respond = (request, data, error) => listeners.message({data: {
    type: error ? 'error' : 'ack', requestId: request.clientRequestId, data, text: error
  }});
  const publish = (state,active,detached=false,permissions=[],compacting,root,deltas,snippets,extra) => listeners.message({data: {type:'state',state:structuredClone(state),active,permissions,detached,compacting,root,deltas, ...(snippets!==undefined?{snippets}:{}), ...(extra||{})}});
  publish(require('../dist/shared/model').fresh());
  return {nodes, sent, requests, respond, publish, execCalls, timers};
}
test('attachments deduplicate without putting file contents into the draft',()=>{
 const {nodes,requests,respond}=webview();
 nodes.draft.value='Question';
 nodes.attach.onclick();nodes.attach.onclick();
 assert.equal(requests('attach').length,1);
 const data={attachment:{id:'a',label:'spec.md',text:'large file contents'}};
 respond(requests('attach')[0],data);
 assert.equal(nodes.draft.value,'Question');
 assert.equal(nodes.attachments.children.length,1);
 nodes.attach.onclick();respond(requests('attach')[1],data);
 assert.equal(nodes.attachments.children.length,1);
 assert.equal(nodes.draft.value,'Question');
 nodes.composer.onsubmit({preventDefault(){}});
 assert.equal(requests('send')[0].text,'Question');
 assert.equal(requests('send')[0].attachments[0].text,'large file contents');
 assert.equal(requests('send')[0].attachments.length,1);
 respond(requests('send')[0]);
 assert.equal(nodes.attachments.children.length,0);
});

test('different line endings deduplicate but different selections are kept',()=>{
 const first={id:'1',label:'file.ts:1',text:'a\r\nb'};
 assert.equal(addAttachment([first],{id:'2',label:'file.ts:1',text:'a\nb'}).added,false);
 assert.equal(addAttachment([first],{id:'3',label:'file.ts:5',text:'a\nb'}).added,true);
});

test('typing during file selection survives and removing attachment leaves only the human text',()=>{
 const {nodes,requests,respond}=webview();
 nodes.draft.value='before';nodes.attach.onclick();
 nodes.draft.value='typed during selection';
 nodes.composer.onsubmit({preventDefault(){}});
 assert.equal(requests('send').length,0);
 respond(requests('attach')[0],{attachment:{id:'a',label:'f.ts',text:'code'}});
 assert.equal(nodes.draft.value,'typed during selection');
 nodes.attachments.children[0].children[1].onclick();
 assert.equal(nodes.attachments.children.length,0);
 nodes.composer.onsubmit({preventDefault(){}});
 assert.equal(requests('send')[0].attachments.length,0);
});

test('cancelled or failed file selection preserves draft and unlocks send',()=>{
 const {nodes,requests,respond}=webview();
 nodes.draft.value='keep';
 nodes.attach.onclick();respond(requests('attach')[0],{cancelled:true});
 assert.equal(nodes.draft.value,'keep');assert.equal(nodes.send.disabled,false);
 nodes.attach.onclick();respond(requests('attach')[1],undefined,'unavailable');
 assert.equal(nodes.draft.value,'keep');assert.equal(nodes.send.disabled,false);
});

test('numbered selection submits order once and clears after acknowledgment',()=>{
 const {nodes,requests,respond}=webview();
 nodes['response-order'].children[1].onclick();nodes['response-order'].children[0].onclick();
 assert.deepEqual(nodes['response-order'].children.map(b=>b.textContent),['2 Колян','1 Жека']);
 nodes.draft.value='Two opinions';nodes.composer.onsubmit({preventDefault(){}});
 nodes.composer.onsubmit({preventDefault(){}});
 assert.equal(requests('send').length,1);
 assert.deepEqual(Array.from(requests('send')[0].responseOrder),['codex','claude']);
 respond(requests('send')[0]);assert.equal(nodes.draft.value,'');
 assert.ok(nodes['response-order'].children.every(b=>b.attributes['aria-pressed']==='false'));
});

test('current question approval is separated from an older pending question',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,requests,publish}=webview();const state=fresh();
 state.messages=[{id:'old',author:'Антон',text:'Old question',turn:'older'},
   {id:'m',author:'Антон',text:'Current question',turn:'first'},
   {id:'r',author:'Колян',text:'First answer',turn:'first'}];
 state.turns=[{id:'older',messageId:'old',recipient:'all',status:'proposed'},
   {id:'first',messageId:'m',recipient:'claude',executor:'claude',status:'completed',replyId:'r'},
   {id:'second',messageId:'m',recipient:'codex',status:'proposed',cycle:2}];state.queue=['older','second'];
 publish(state);
 assert.equal(nodes['older-queue'].hidden,false);
 assert.equal(nodes['older-rows'].children.length,1);
 assert.equal(nodes.queued.children.length,1);
 assert.match(nodes.queued.children[0].children[0].children[1].textContent,/Old question/);
 assert.match(nodes['older-rows'].children[0].children[0].children[1].textContent,/Current question/);
 assert.match(nodes['older-rows'].children[0].children[0].children[2].textContent,/цикл 2/);
 const actions=nodes['older-rows'].children[0].children[1];
 assert.match(actions.children[1].textContent,/Жека/);
 actions.children[1].onclick();
 assert.equal(requests('handoff')[0].turnId,'second');
 assert.equal(requests('handoff')[0].text,undefined);
});

test('detached panel hides move control and context generation clears old draft and attachments',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,requests,respond,publish}=webview();const state=fresh();
 state.messages=[{id:'old',author:'Антон',text:'Old conversation'}];
 publish(state,undefined,true);assert.equal(nodes.popout.hidden,true);
 nodes.draft.value='old draft';nodes.attach.onclick();
 respond(requests('attach')[0],{attachment:{id:'a',label:'f.ts',text:'code'}});
 nodes['new-conversation'].onclick();
 assert.equal(nodes['fresh-dialog'].open,true,'кнопка открывает модалку, а не чистит ленту');
 assert.equal(requests('reset').length,0);
 assert.equal(requests('fresh-summary').length,0);
 nodes['fresh-cancel'].onclick();
 assert.equal(nodes['fresh-dialog'].open,false);
 const next=fresh();publish(next,undefined,true);
 assert.equal(nodes.draft.value,'');assert.equal(nodes.attachments.children.length,0);
 assert.equal(nodes.feed.children.filter(n=>n.className.startsWith('message')).length,0);
 assert.equal(nodes.draft.disabled,false);
});


test('a pasted screenshot becomes one attachment and does not land in the message text',()=>{
 const {nodes,requests,respond}=webview();
 nodes.draft.value='смотри сюда';
 let prevented=false;
 const paste=body=>nodes.draft.onpaste({
   preventDefault(){prevented=true;},
   clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:()=>({type:'image/png',name:'shot.png',body})}]}
 });
 paste('QUJD');
 assert.equal(prevented,true,'обычная вставка текста подавлена только для картинки');
 const asked=requests('image');
 assert.equal(asked.length,1);assert.equal(asked[0].data,'QUJD');assert.equal(asked[0].mime,'image/png');
 respond(asked[0],{attachment:{id:'abc.png',label:'shot.png · 1 КБ',text:'Изображение на диске: C:/store/images/abc.png',preview:'vscode-webview://thumb/abc.png'}});
 assert.equal(nodes.attachments.children.length,1);
 assert.equal(nodes.attachments.querySelector('img').src,'vscode-webview://thumb/abc.png');
 assert.equal(nodes.draft.value,'смотри сюда','текст сообщения не тронут');
 paste('QUJD');
 respond(requests('image')[1],{attachment:{id:'abc.png',label:'shot.png · 1 КБ',text:'Изображение на диске: C:/store/images/abc.png',preview:'vscode-webview://thumb/abc.png'}});
 assert.equal(nodes.attachments.children.length,1,'тот же файл не дублируется');
 assert.equal(nodes.draft.disabled,false);
 nodes.attachments.querySelector('.image-thumb').onclick();
 assert.equal(nodes['image-dialog'].open,true);
 assert.equal(nodes['image-full'].src,'vscode-webview://thumb/abc.png');
});
test('a disk screenshot without a preview uri still shows a thumb, not a code fold',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'m',author:'Антон',text:'смотри',
  attachments:[{id:'abc.png',label:'image.png · 66 КБ',text:'Изображение на диске: C:/store/images/abc.png'}]}];
 publish(state);
 assert.ok(nodes.feed.querySelector('.image-thumb'));
 assert.match(nodes.feed.querySelector('.image-thumb').className,/\bbroken\b/);
 assert.equal(nodes.feed.querySelector('.code-attachment'),null);
});
test('a screenshot in the feed is a thumbnail, not a code fold',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 const state=fresh();
 state.messages=[{id:'m',author:'Антон',text:'смотри',
  attachments:[{id:'abc.png',label:'shot.png · 1 КБ',text:'Изображение на диске: C:/store/images/abc.png',preview:'vscode-webview://thumb/abc.png'}]}];
 publish(state);
 assert.equal(nodes.feed.querySelector('.image-thumb-img').src,'vscode-webview://thumb/abc.png');
 assert.equal(nodes.feed.querySelector('.code-attachment'),null);
 nodes.feed.querySelector('.image-thumb').onclick();
 assert.equal(nodes['image-dialog'].open,true);
 assert.equal(nodes['image-full'].src,'vscode-webview://thumb/abc.png');
});
test('standing permission button is hidden for danger and shown otherwise',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 const state=fresh();
 publish(state,{provider:'grok',turnId:'t'},false,[{id:'p',provider:'grok',title:'Edit a.ts',detail:'{}',standing:true}]);
 assert.equal(nodes['permission-standing'].hidden,false);
 nodes['permission-standing'].onclick();
 assert.equal(requests('permission')[0].standing,true);
 publish(state,{provider:'grok',turnId:'t'},false,[{id:'d',provider:'grok',title:'Bash',detail:'{"command":"rm"}',standing:false}]);
 assert.equal(nodes['permission-standing'].hidden,true);
});
test('every permission request opens the center dialog, including Read',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 publish(state,{provider:'grok',turnId:'t'},false,[{id:'p',provider:'grok',title:'Read spec.md',detail:'{}'}]);
 assert.equal(nodes['floor-title'].textContent,'Ждёт разрешения');
 assert.match(nodes['floor-detail'].textContent,/Гриха: Read spec.md/);
 assert.equal(nodes['permission-dialog'].open,true);
 assert.match(nodes['permission-what'].textContent,/Read spec.md/);
 publish(state,{provider:'grok',turnId:'t'},false,[{id:'b',provider:'grok',title:'Bash',caption:'ssh u26 uptime',detail:'{}'}]);
 assert.match(nodes['permission-title'].textContent,/ssh u26 uptime/);
 assert.match(nodes['floor-detail'].textContent,/ssh u26 uptime/);
 assert.equal(nodes['permissions-block'],undefined);
 publish(state,{provider:'grok',turnId:'t'});
 assert.equal(nodes['floor-title'].textContent,'Гриха отвечает');
 assert.equal(nodes['permission-dialog'].open,false);
});
test('a second permission waits its turn in the same dialog',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 publish(state,{provider:'grok',turnId:'t'},false,[
  {id:'p1',provider:'grok',title:'Read spec.md',detail:'{}'},
  {id:'p2',provider:'grok',title:'Edit main.css',detail:'{"path":"webview/main.css"}'}
 ]);
 assert.equal(nodes['floor-title'].textContent,'Ждёт разрешения: 2');
 assert.equal(nodes['permission-dialog'].open,true);
 assert.match(nodes['permission-what'].textContent,/Read spec.md/);
 publish(state,{provider:'grok',turnId:'t'},false,[{id:'p2',provider:'grok',title:'Edit main.css',detail:'{"path":"webview/main.css"}'}]);
 assert.equal(nodes['floor-title'].textContent,'Ждёт разрешения');
 assert.match(nodes['permission-what'].textContent,/Edit main.css/);
 publish(state,{provider:'grok',turnId:'t'});
 assert.equal(nodes['permission-dialog'].open,false);
});
test('permission details start collapsed on every new request',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 publish(state,{provider:'grok',turnId:'t'},false,[{id:'p1',provider:'grok',title:'Edit a.ts',detail:'{"a":1}'}]);
 nodes['permission-more'].open=true;
 publish(state,{provider:'grok',turnId:'t'},false,[{id:'p2',provider:'grok',title:'Edit b.ts',detail:'{"b":2}'}]);
 assert.equal(nodes['permission-more'].open,false);
 assert.match(nodes['permission-what'].textContent,/Edit b.ts/);
});
test('a permission decision is a compact event in the feed, not a Trio utterance',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'e',author:'Trio',text:'Разрешено до конца хода: Колян',control:true,
  actions:[{title:'Edit a.ts',detail:'{"file":"a.ts"}'},{title:'Edit b.ts',detail:'{"file":"b.ts"}'}]}];
 publish(state);
 const row=nodes.feed.children.find(n=>n.dataset&&n.dataset.messageId==='e');
 assert.match(row.className,/\bevent\b/);
 const outer=row.querySelector('.message-body').children[0];
 assert.equal(outer.tag,'details');
 const nested=outer.children.filter(c=>c.tag==='details');
 assert.equal(nested.length,2);
 assert.equal(nested[0].children[0].textContent,'Edit a.ts');
});
test('feed question numbers match shared questionNumber, including cancelled',()=>{
 const {fresh,questionNumber}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[
  {id:'q1',author:'Антон',text:'one',turn:'t1'},
  {id:'q2',author:'Антон',text:'two',turn:'t2',cancelled:true}
 ];
 state.turns=[
  {id:'t1',messageId:'q1',recipient:'claude',status:'completed',executor:'claude'},
  {id:'t2',messageId:'q2',recipient:'claude',status:'interrupted'}
 ];
 publish(state);
 assert.equal(questionNumber(state.messages,state.turns,'q1'),1);
 assert.equal(questionNumber(state.messages,state.turns,'q2'),2);
 const labels=[];
 const walk=n=>{
  if(n.className==='message-tools') for(const c of n.children||[]) if(typeof c.textContent==='string'&&c.textContent.startsWith('#')) labels.push(c.textContent);
  (n.children||[]).forEach(walk);
 };
 walk(nodes.feed);
 assert.ok(labels.some(t=>t.startsWith('#1')));
 assert.ok(labels.some(t=>t.startsWith('#2')));
});
test('search by #number opens that message and does not hit a longer number',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[
  {id:'q1',author:'Антон',text:'раньше #2',turn:'t1'},
  {id:'q2',author:'Антон',text:'десятый',turn:'t2'},
  {id:'a2',author:'Колян',text:'см. #2 и #20 и #12 и #1 конец',turn:'t2'}
 ];
 state.turns=[
  {id:'t1',messageId:'q1',recipient:'claude',status:'completed',executor:'claude',snapshot:'s1'},
  {id:'t2',messageId:'q2',recipient:'claude',status:'completed',executor:'claude',replyId:'a2',snapshot:'s2'}
 ];
 publish(state);
 const marks=()=>{
  const out=[];
  const walk=n=>{
   if((n.className||'').split(' ').includes('search-match')) out.push(n.textContent);
   const nested=n.childNodes&&n.childNodes.length?n.childNodes:(n.children||[]);
   for(const c of nested) walk(c);
  };
  walk(nodes.feed);
  return out;
 };
 const landed=()=>nodes.feed.children.filter(n=>n.scrolled).map(n=>n.dataset.messageId);
 const clearScrolled=n=>{n.scrolled=false; for(const c of n.children||[]) clearScrolled(c);};
 const find=term=>{
  clearScrolled(nodes.feed);
  nodes['search-box'].hidden=false;
  nodes.search.value=term;
  nodes.search.oninput();
 };
 find('# 2');
 assert.equal(nodes['search-count'].textContent,'2 / 3');
 assert.deepEqual(landed(),['q2']);
 assert.deepEqual(marks(),['#2','#2','#2']);
 find('#1');
 assert.equal(nodes['search-count'].textContent,'1 / 2');
 assert.deepEqual(landed(),['q1']);
 assert.deepEqual(marks(),['#1','#1']);
 find('#20');
 assert.equal(nodes['search-count'].textContent,'1 / 1');
 assert.deepEqual(marks(),['#20']);
 assert.deepEqual(landed(),[]);
 find('изменения');
 assert.equal(nodes['search-count'].textContent,'0 / 0');
 assert.deepEqual(marks(),[]);
 find('десятый');
 assert.equal(nodes['search-count'].textContent,'1 / 1');
 assert.deepEqual(marks(),['десятый']);
});
test('search in a folded message uses the body and opens it',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'q1',author:'Антон',text:'а'.repeat(6000)+'\nхвост-складки',turn:'t1'}];
 state.turns=[{id:'t1',messageId:'q1',recipient:'claude',status:'completed',executor:'claude'}];
 publish(state);
 const details=nodes.feed.children.find(n=>n.dataset.messageId==='q1').querySelector('.long-message');
 assert.equal(details.tag,'details');
 nodes['search-box'].hidden=false;
 nodes.search.value='раскрыть';
 nodes.search.oninput();
 assert.equal(nodes['search-count'].textContent,'0 / 0');
 nodes.search.value='хвост-складки';
 nodes.search.oninput();
 assert.equal(nodes['search-count'].textContent,'1 / 1');
 assert.equal(details.open,true);
});
test('a cited #number opens that message, and a longer or fenced number stays text',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 const reply={id:'a',author:'Колян',text:'см. #1 и #2 и #20 и v#1 и #01\n```\nкод #1\n```\n| n |\n|---|\n| #1 |',turn:'t1'};
 state.messages=[{id:'q1',author:'Антон',text:'первый',turn:'t1'},reply];
 state.turns=[{id:'t1',messageId:'q1',recipient:'claude',status:'completed',executor:'claude',replyId:'a'}];
 publish(state);
 const body=()=>nodes.feed.children.find(n=>n.dataset.messageId==='a').querySelector('.message-body');
 const refs=()=>collect(body(),'msg-ref').map(n=>n.textContent);
 assert.deepEqual(refs(),['#1','#1']);
 const fence=[...body().querySelectorAll('.md-run')].find(n=>(n.textContent||'').includes('код #1'));
 assert.ok(fence);
 assert.equal(collect(fence,'msg-ref').length,0);
 state.messages.splice(1,0,{id:'q2',author:'Антон',text:'а'.repeat(6000)+'\nвторой',turn:'t2'});
 state.turns.push({id:'t2',messageId:'q2',recipient:'claude',status:'completed',executor:'claude'});
 publish(state);
 assert.deepEqual(refs(),['#1','#2','#1']);
 const link2=collect(body(),'msg-ref').find(n=>n.textContent==='#2');
 assert.equal(link2.title,'К сообщению #2');
 link2.onclick();
 const row2=nodes.feed.children.find(n=>n.dataset.messageId==='q2');
 assert.equal(row2.scrolled,true);
 assert.equal(row2.querySelector('.long-message').open,true);
});
test('agent replies are #К #Ж #Г and link back to the question',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[
  {id:'q1',author:'Антон',text:'первый',turn:'t1'},
  {id:'a1',author:'Колян',text:'см. #ж1 и #К2 и #К10 и v#К1\n```\n#К1\n```\n| n |\n|---|\n| #К1 |',turn:'t1'},
  {id:'q2',author:'Антон',text:'второй',turn:'t2'},
  {id:'a2',author:'Жека',text:'ответ жеки',turn:'t2'},
  {id:'a3',author:'Колян',text:'ещё',turn:'t3'},
  {id:'g',author:'Гриха',text:'третье мнение',turn:'t4'}
 ];
 state.turns=[
  {id:'t1',messageId:'q1',replyId:'a1',recipient:'claude',status:'completed',executor:'claude'},
  {id:'t2',messageId:'q2',replyId:'a2',recipient:'codex',status:'completed',executor:'codex'},
  {id:'t3',messageId:'q1',replyId:'a3',recipient:'claude',status:'completed',executor:'claude'},
  {id:'t4',messageId:'q2',replyId:'g',recipient:'grok',status:'completed',executor:'grok'}
 ];
 publish(state);
 const row=id=>nodes.feed.children.find(n=>n.dataset.messageId===id);
 const chip=id=>collect(row(id).querySelector('.message-tools'),'question-no').map(n=>n.textContent);
 assert.deepEqual(chip('q1'),['#1']);
 assert.deepEqual(chip('a1'),['#К1']);
 assert.deepEqual(chip('a2'),['#Ж1']);
 assert.deepEqual(chip('a3'),['#К2']);
 assert.deepEqual(chip('g'),['#Г1']);
 const back=id=>collect(row(id).querySelector('.message-tools'),'answer-ref');
 assert.equal(back('a1')[0].textContent,'На вопрос #1');
 assert.equal(back('a3')[0].textContent,'На вопрос #1');
 assert.equal(back('g')[0].textContent,'На вопрос #2');
 assert.equal(back('a2')[0].title,'К вопросу #2');
 back('a3')[0].onclick();
 assert.equal(row('q1').scrolled,true);
 const refs=()=>collect(row('a1').querySelector('.message-body'),'msg-ref').map(n=>n.textContent);
 assert.deepEqual(refs(),['#Ж1','#К2','#К1']);
 const fence=[...row('a1').querySelector('.message-body').querySelectorAll('.md-run')].find(n=>(n.textContent||'').includes('#К1'));
 assert.ok(fence);
 assert.equal(collect(fence,'msg-ref').length,0);
 const link=collect(row('a1').querySelector('.message-body'),'msg-ref').find(n=>n.textContent==='#К2');
 assert.equal(link.title,'К сообщению #К2');
 link.onclick();
 assert.equal(row('a3').scrolled,true);
 const marks=()=>{
  const out=[];
  const walk=n=>{
   if((n.className||'').split(' ').includes('search-match')) out.push(n.textContent);
   const nested=n.childNodes&&n.childNodes.length?n.childNodes:(n.children||[]);
   for(const c of nested) walk(c);
  };
  walk(nodes.feed);
  return out;
 };
 const landed=()=>nodes.feed.children.filter(n=>n.scrolled).map(n=>n.dataset.messageId);
 const clearScrolled=n=>{n.scrolled=false; for(const c of n.children||[]) clearScrolled(c);};
 const find=term=>{
  clearScrolled(nodes.feed);
  nodes['search-box'].hidden=false;
  nodes.search.value=term;
  nodes.search.oninput();
 };
 find('# К2');
 assert.equal(nodes['search-count'].textContent,'2 / 2');
 assert.deepEqual(landed(),['a3']);
 assert.deepEqual(marks(),['#К2','#К2']);
 find('#К10');
 assert.equal(nodes['search-count'].textContent,'1 / 1');
 assert.deepEqual(marks(),['#К10']);
 assert.deepEqual(landed(),[]);
 find('#Г1');
 assert.deepEqual(landed(),['g']);
});
test('a late answer is painted beside its question, not after newer ones',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[
  {id:'q1',author:'Антон',text:'один',turn:'t1'},
  {id:'q2',author:'Антон',text:'два',turn:'t2'},
  {id:'q3',author:'Антон',text:'три',turn:'t3'}
 ];
 state.turns=[
  {id:'t1',messageId:'q1',recipient:'claude',status:'running',executor:'claude'},
  {id:'t2',messageId:'q2',recipient:'codex',status:'proposed'},
  {id:'t3',messageId:'q3',recipient:'grok',status:'proposed'}
 ];
 publish(state);
 const order=()=>nodes.feed.children.filter(n=>n.dataset&&n.dataset.messageId).map(n=>n.dataset.messageId);
 assert.deepEqual(order(),['q1','q2','q3']);
 state.messages.splice(1,0,{id:'a1',author:'Колян',text:'ответ на первый',turn:'t1'});
 state.turns[0].replyId='a1';
 state.turns[0].status='completed';
 publish(state);
 assert.deepEqual(order(),['q1','a1','q2','q3']);
 state.messages.splice(3,0,{id:'a2',author:'Жека',text:'ответ на второй',turn:'t2'});
 state.turns[1].replyId='a2';
 state.turns[1].status='completed';
 publish(state);
 assert.deepEqual(order(),['q1','a1','q2','a2','q3']);
});
test('a busy next respondent does not get the pulse class',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'q',author:'Антон',text:'обоим',turn:'t1'}];
 state.turns=[
  {id:'t1',messageId:'q',recipient:'claude',executor:'claude',status:'running'},
  {id:'t2',messageId:'q',recipient:'grok',status:'proposed'}
 ];
 state.queue=['t2'];
 publish(state,{provider:'claude',turnId:'t1'});
 const pulse=nodes.queued.querySelectorAll?null:null;
 const buttons=[];
 const walk=n=>{if(n.className&&String(n.className).includes('next'))buttons.push(n);(n.children||[]).forEach(walk);};
 walk(nodes.queued);
 assert.equal(buttons.length,0,'disabled Гриха must not blink');
});
test('a captured instruction leaves Инструкции включены on the reply',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[
  {id:'q',author:'Антон',text:'вопрос',turn:'t1'},
  {id:'a',author:'Колян',text:'ответ',turn:'t1'}
 ];
 state.turns=[{id:'t1',messageId:'q',recipient:'claude',status:'completed',executor:'claude',replyId:'a',
  instruction:'Отвечай кратко.'}];
 state.agents[0].instruction='уже другое';
 publish(state);
 const toolsOf=id=>{
  const row=nodes.feed.children.find(n=>n.dataset&&n.dataset.messageId===id);
  return row&&row.querySelector('.message-tools');
 };
 const chipOf=id=>(toolsOf(id).children||[]).find(n=>(n.className||'').split(' ').includes('instruction-used'));
 const chip=chipOf('a');
 assert.ok(chip);
 assert.equal(chip.children[0].textContent,'Инструкции включены');
 assert.equal(chip.children[1].textContent,'Отвечай кратко.');
 assert.equal(chipOf('q'),undefined);
 delete state.turns[0].instruction;
 publish(state);
 assert.equal(chipOf('a'),undefined);
});
test('instruction pencil sits under reload and saves per agent',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 publish(fresh());
 const pencil=nodes.agents.querySelector('.agent-instruction');
 assert.equal(pencil.textContent,'✎');
 assert.equal(pencil.title,'Инструкция Коляну');
 assert.doesNotMatch(pencil.className,/\bset\b/);
 assert.equal(nodes.agents.querySelector('.reload-spacer'),null);
 pencil.onclick();
 assert.equal(nodes['instruction-dialog'].open,true);
 assert.equal(nodes['instruction-dialog-title'].textContent,'Инструкция Коляну');
 nodes['instruction-text'].value='Отвечай кратко.';
 nodes['instruction-text'].oninput();
 assert.equal(nodes['instruction-count'].textContent,'15 / 1000');
 nodes['instruction-save'].onclick();
 const saved=requests('agent').at(-1).agent;
 assert.equal(saved.id,'claude');
 assert.equal(saved.instruction,'Отвечай кратко.');
 const state=fresh();
 state.agents[0].instruction='Отвечай кратко.';
 publish(state);
 const set=nodes.agents.querySelector('.agent-instruction');
 assert.match(set.className,/\bset\b/);
 assert.equal(set.title,'Отвечай кратко.');
 set.onclick();
 nodes['instruction-clear'].onclick();
 assert.equal(requests('agent').at(-1).agent.instruction,'');
});

test('each agent card stacks reset under compact and usage under stop',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 publish(fresh());
 const card=nodes.agents.querySelector('.agent');
 const actions=card.querySelector('.agent-actions').children;
 const side=card.querySelector('.agent-side').children;
 assert.equal(actions[0].textContent,'Сжать');
 assert.equal(actions[1].textContent,'■ Стоп');
 assert.equal(side[0].textContent,'Сброс');
 assert.match(side[1].className,/\busage-one\b/);
 side[0].onclick();
 assert.equal(requests('reset')[0].provider,'claude');
 assert.equal(requests('reset')[0].mode,'context');
});
test('each agent card has a usage button on the context row',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 publish(fresh());
 const usage=nodes.agents.querySelector('.usage-one');
 assert.equal(usage.querySelector('.usage-text').textContent,'Usage');
 assert.match(usage.className,/\busage-one\b/);
});
test('the header shows the project folder and opens it on click',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 publish(fresh());
 assert.equal(nodes.project.hidden,true);
 publish(fresh(),undefined,false,[],undefined,'c:\\projects\\trio');
 assert.equal(nodes.project.hidden,false);
 assert.equal(nodes.project.textContent,'Проект: c:\\projects\\trio');
 assert.match(nodes.project.title,/папк/);
 nodes.project.onclick();
 assert.equal(requests('project').length,1);
});
test('an expired quota is not painted on the usage button',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.usage={claude:{tokens:900,window:1000,source:'result',at:1,quota:{percent:62,label:'5 ч',source:'usage',at:1,resetsAt:1}}};
 publish(state);
 const usage=nodes.agents.querySelector('.usage-one');
 assert.equal(usage.querySelector('.usage-text').textContent,'Usage');
 assert.equal(usage.querySelector('.usage-fill').style.width,'0%');
});
test('the usage button title counts down a live reset and ages the reading',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 const at=Date.now()-6*60*1000, resetsAt=Date.now()+134*1000;
 state.usage={claude:{tokens:900,window:1000,source:'result',at,quota:{percent:17,label:'5 ч',source:'usage',at,resetsAt}}};
 publish(state);
 const usage=nodes.agents.querySelector('.usage-one');
 assert.match(usage.title,/17%/);
 assert.match(usage.title,/6 мин назад/);
 assert.match(usage.title,/сброс через 2:1/);
});
test('the usage button carries the quota fill, context stays a single meter',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.usage={claude:{tokens:900,window:1000,source:'result',at:1,quota:{percent:62,label:'5 ч',source:'usage',at:1}}};
 publish(state);
 const card=nodes.agents.querySelector('.agent');
 const bars=collect(card,'meter');
 assert.equal(bars.length,1,'only the context meter');
 assert.equal(bars[0].querySelector('.meter-text').textContent,'900 из 1к');
 const usage=card.querySelector('.usage-one');
 assert.match(usage.className,/\bhigh\b/);
 assert.equal(usage.querySelector('.usage-fill').style.width,'62%');
 const label=usage.querySelector('.usage-text');
 assert.equal(label.children[0].textContent,'62%');
 assert.equal(label.children[1].textContent,'usage');
});
test('context meter label is compact tokens of the engine window',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.usage={
  claude:{tokens:21067,window:200000,source:'result',at:1},
  grok:{tokens:17307,window:500000,source:'session/prompt',at:1}
 };
 publish(state);
 const meters=collect(nodes.agents,'meter');
 assert.equal(meters[0].querySelector('.meter-text').textContent,'21к из 200к');
 assert.equal(meters[0].querySelector('.meter-fill').style.width,'11%');
 assert.ok(!meters[0].className.split(' ').includes('high'));
 assert.match(meters[0].title,/Источник: result/);
 assert.equal(meters[1].querySelector('.meter-text').textContent,'—');
 assert.equal(meters[2].querySelector('.meter-text').textContent,'17к из 500к');
 assert.equal(meters[2].querySelector('.meter-fill').style.width,'3%');
 assert.match(meters[2].title,/Источник: session\/prompt/);
});
test('context meter uses millions and marks a figure above the window',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.usage={claude:{tokens:431000,window:1000000,source:'result',at:1},
  grok:{tokens:1200000,window:500000,source:'result',at:1}};
 publish(state);
 const meters=collect(nodes.agents,'meter');
 assert.equal(meters[0].querySelector('.meter-text').textContent,'431к из 1М');
 assert.equal(meters[2].querySelector('.meter-text').textContent,'! 1,2М из 500к');
 assert.ok(meters[2].className.split(' ').includes('over'));
});
test('usage caption stays Usage when the CLI has not reported a quota',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 publish(fresh());
 const usage=nodes.agents.querySelector('.usage-one');
 assert.equal(usage.querySelector('.usage-text').textContent,'Usage');
 assert.equal(usage.querySelector('.usage-fill').style.width,'0%');
 assert.equal(collect(nodes.agents.querySelector('.agent'),'meter').length,1);
});
test('usage dialog draws bars for occupancy and subscription windows',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests,respond}=webview();
 publish(fresh());
 nodes.agents.querySelector('.usage-one').onclick();
 respond(requests('usage')[0],{title:'Колян — расход',plan:'Pro',
  occupancy:{percent:51,tokens:510,window:1000,source:'result'},
  quotas:[{percent:12,label:'5 ч',resets:'16:00'},{percent:42,label:'неделя'}]});
 assert.equal(nodes['usage-title'].textContent,'Колян — расход');
 assert.equal(nodes['usage-dialog'].open,true);
 const rows=nodes['usage-body'].children.filter(n=>n.className==='usage-row');
 assert.equal(rows.length,3);
 assert.equal(rows[0].querySelector('.usage-row-head').children[0].textContent,'Сессия · 5 ч');
 assert.equal(rows[0].querySelector('.usage-bar-fill').style.width,'12%');
 assert.equal(rows[1].querySelector('.usage-row-head').children[0].textContent,'Неделя');
 assert.equal(rows[2].querySelector('.usage-row-head').children[0].textContent,'Окно контекста');
 assert.match(nodes['usage-body'].querySelector('.usage-plan').textContent,/Pro/);
});
test('Codex usage shows separate named limits and the main quota on the card',()=>{
 const {fresh}=require('../dist/shared/model');
 const {extractQuota,extractQuotas}=require('../dist/providers/adapter');
 const raw=require('./fixtures/codex-rate-limits.json');
 const {nodes,publish,requests,respond}=webview();
 const state=fresh();
 state.usage={codex:{tokens:99873,window:258400,source:'test',at:Date.now(),quota:extractQuota(raw)}};
 publish(state);
 const usage=collect(nodes.agents,'usage-one').find(n=>n.dataset.provider==='codex');
 assert.equal(usage.querySelector('.usage-fill').style.width,'43%');
 assert.match(usage.title,/Codex · Неделя/);
 usage.onclick();
 respond(requests('usage')[0],{title:'Жека — расход',quotas:extractQuotas(raw),occupancy:{percent:39,tokens:99873,window:258400}});
 const rows=nodes['usage-body'].children.filter(n=>n.className==='usage-row');
 assert.deepEqual(rows.map(row=>row.querySelector('.usage-row-head').children[0].textContent),[
  'Codex · Неделя · 7 д','GPT-5.3-Codex-Spark · Сессия · 5 ч',
  'GPT-5.3-Codex-Spark · Неделя · 7 д','Резерв · gpt-5.6-luna · Неделя · 7 д','Окно контекста'
 ]);
 assert.deepEqual(rows.map(row=>row.querySelector('.usage-bar-fill').style.width),['43%','0%','0%','0%','39%']);
});
test('a queued turn under auto-reply while busy says it will go by itself',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.autoReply=true;
 state.messages=[{id:'q',author:'Антон',text:'всем',turn:'t1'}];
 state.turns=[{id:'t1',messageId:'q',recipient:'claude',status:'running',executor:'claude'},
  {id:'t2',messageId:'q',recipient:'codex',status:'proposed'}];
 state.queue=['t2'];
 publish(state,{provider:'claude',turnId:'t1'});
 const actions=nodes.queued.querySelector('.queue-actions');
 assert.match(actions.children[1].textContent,/пойдёт сам/);
 assert.ok(!String(actions.children[1].className).includes('next'));
});
test('three queue replies fit as short name buttons',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.agents.forEach(a=>{a.enabled=true;});
 state.messages=[{id:'q',author:'Антон',text:'всем троим',turn:'t'}];
 state.turns=[{id:'t',messageId:'q',recipient:'all',status:'proposed'}];
 state.queue=['t'];
 publish(state);
 const actions=nodes.queued.querySelector('.queue-actions');
 const answers=(actions.children||[]).filter(c=>c.tag==='button'&&!String(c.className).includes('cancel'));
 assert.equal(answers.length,3);
 assert.deepEqual(answers.map(b=>b.textContent),['Колян\nответить','Жека\nответить','Гриха\nответить']);
 assert.equal(nodes['queue-empty'].hidden,true);
});
test('plugin settings are grouped so grokPath sits with the other CLI paths',()=>{
 const pkg=require('../package.json');
 const sections=pkg.contributes.configuration;
 assert.ok(Array.isArray(sections));
 assert.deepEqual(sections.map(s=>s.title),['Trio: CLI','Trio: потолок сессии','Trio: лента','Trio: ход','Trio: снимок правок']);
 assert.deepEqual(Object.keys(sections[0].properties),['trio.claudePath','trio.codexPath','trio.grokPath']);
 assert.equal(sections[0].properties['trio.grokPath'].order,3);
 assert.deepEqual(Object.keys(sections[1].properties),[
  'trio.claudeSessionMaxTokens','trio.codexSessionMaxTokens','trio.grokSessionMaxTokens']);
 assert.equal(sections[1].properties['trio.claudeSessionMaxTokens'].default,150000);
 assert.equal(sections[1].properties['trio.codexSessionMaxTokens'].default,150000);
 assert.equal(sections[1].properties['trio.grokSessionMaxTokens'].default,0);
 assert.equal(sections[3].properties['trio.sessionIdleMinutes'].default,55);
 assert.equal(sections[3].properties['trio.sessionMaxTokens'],undefined);
 const feed=sections[2].properties['trio.feedMaxMessages'];
 assert.equal(feed.default,1000);
 assert.equal(feed.minimum,1);
 assert.match(feed.markdownDescription,/не блокировка/);
 assert.match(feed.markdownDescription,/1050/);
 assert.match(feed.markdownDescription,/1200/);
});
test('effort menu is weak-to-strong even if Grok catalog lists the reverse',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 publish(state,undefined,false,[],undefined,undefined,undefined,undefined,{catalogs:{
  claude:[{value:'opus',label:'Opus',efforts:['low','medium','high']}],
  grok:[{value:'grok-4',label:'Grok 4',efforts:['high','medium','low']}]
 }});
 const cards=nodes.agents.children;
 const values=card=>card.querySelectorAll('select')[1].children.map(o=>o.value);
 assert.deepEqual(values(cards[0]),['','low','medium','high']);
 assert.deepEqual(values(cards[2]),['','low','medium','high']);
});
test('the work block stop-all control is labelled Стоп всем',()=>{
 const html=require('fs').readFileSync('webview/main.html','utf8');
 assert.match(html,/>■ Стоп всем</);
 assert.match(html,/выключить автоответ/);
});
test('compact shows on the floor and the stop-all control stays a real button',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 publish(state,undefined,false,[], 'grok');
 assert.equal(nodes['floor-title'].textContent,'Гриха: сжатие');
 assert.equal(nodes['stop-all'].disabled,false);
});
test('a fat delta is shown next to send before the turn starts',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 publish(state,undefined,false,[],undefined,undefined,[
  {provider:'claude',chars:43781,messages:58,total:189,kind:'delta'},
  {provider:'codex',chars:62834,messages:75,total:75,kind:'full'}
 ]);
 assert.equal(nodes['delta-hint'].hidden,true,'nobody selected — no hint');
 nodes['response-order'].children[0].onclick();
 assert.equal(nodes['delta-hint'].hidden,false);
 assert.match(nodes['delta-hint'].textContent,/Колян/);
 assert.match(nodes['delta-hint'].textContent,/43/);
 assert.match(nodes['delta-hint'].textContent,/58 из 189/);
 assert.doesNotMatch(nodes['delta-hint'].textContent,/Жека/);
 assert.match(nodes['delta-hint'].className,/\bwarn\b/);
 nodes['response-order'].children[0].onclick();
 assert.equal(nodes['delta-hint'].hidden,true);
 nodes['response-order'].children[1].onclick();
 assert.equal(nodes['delta-hint'].hidden,false);
 assert.match(nodes['delta-hint'].textContent,/Жека/);
 assert.match(nodes['delta-hint'].textContent,/первый ход \/ после сброса/);
 assert.doesNotMatch(nodes['delta-hint'].textContent,/Колян/);
 nodes['response-order'].children[1].onclick();
 publish(state,undefined,false,[],undefined,undefined,[
  {provider:'claude',chars:62351,messages:58,total:189,kind:'full',reason:'compact'}
 ]);
 nodes['response-order'].children[0].onclick();
 assert.match(nodes['delta-hint'].textContent,/сжал историю/);
});
test('auto-reply in the composer and in Работа share one flag',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 const state=fresh();state.autoReply=true;publish(state);
 assert.match(nodes['auto-reply'].className,/\bselected\b/);
 assert.match(nodes['auto-reply-work'].className,/\bselected\b/);
 nodes['auto-reply'].onclick();
 assert.equal(requests('flags').at(-1).autoReply,false);
});
test('an agent question opens the center dialog, not buttons in the feed',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 const state=fresh();
 state.messages=[{id:'q',author:'Колян',text:'Цвет?',
  question:{id:'r',items:[{prompt:'Цвет?',options:[{label:'красный'},{label:'синий',description:'холодный'}]}]}}];
 publish(state);
 assert.equal(nodes['question-dialog'].open,true);
 assert.match(nodes['question-who'].textContent,/Колян/);
 assert.equal(nodes['floor-title'].textContent,'Ждёт ответа');
 const card=nodes.feed.querySelector('.question-card');
 assert.equal(card.querySelector('.question-card-title').textContent,'Вопрос Коляна');
 const choices=(nodes['question-body'].children||[]).filter(n=>String(n.className||'').includes('question-choice'));
 assert.equal(choices.length,2);
 assert.ok(choices.every(c=>c.attributes.role==='radio'));
 assert.equal(choices[0].querySelector('.question-mark').textContent,'○');
 assert.equal(nodes['question-body'].querySelector('.question-multi'),null);
 assert.match(choices[0].querySelector('.question-choice-label').textContent,/^1\. /);
 assert.match(choices[1].querySelector('.question-choice-desc').textContent,/холодный/);
 assert.equal(nodes['question-body'].querySelector('input').placeholder,'Свой ответ');
 choices[1].onclick();
 assert.equal(requests('answer')[0].requestId,'r');
 assert.deepEqual(Array.from(requests('answer')[0].answers['Цвет?']),['синий']);
});
test('a multiSelect question toggles options and submits on Готово',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 const state=fresh();
 state.messages=[{id:'q',author:'Гриха',text:'Стек?',
  question:{id:'r',items:[{prompt:'Стек?',multi:true,options:[{label:'node'},{label:'go'},{label:'rust'}]}]}}];
 publish(state);
 assert.match(nodes['question-title'].textContent,/несколько/);
 const pick=i=>(nodes['question-body'].children||[]).filter(n=>String(n.className||'').includes('question-choice'))[i];
 pick(0).onclick();
 pick(2).onclick();
 assert.equal(requests('answer').length,0);
 const done=nodes['question-actions'].querySelector('.question-done');
 assert.equal(nodes['question-body'].querySelector('.question-done'),null);
 assert.ok(done.className.includes('primary'));
 assert.match(done.textContent,/Готово \(2\)/);
 done.onclick();
 assert.deepEqual(Array.from(requests('answer')[0].answers['Стек?']),['node','rust']);
});
test('two agent questions accumulate and submit together',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 const state=fresh();
 state.messages=[{id:'q',author:'Колян',text:'два',
  question:{id:'r',items:[
   {prompt:'Цвет?',options:[{label:'красный'},{label:'синий'}]},
   {prompt:'Форма?',options:[{label:'круг'},{label:'квадрат'}]}
  ]}}];
 publish(state);
 assert.match(nodes['question-title'].textContent,/1 из 2/);
 const first=(nodes['question-body'].children||[]).filter(n=>String(n.className||'').includes('question-choice'));
 first[0].onclick();
 assert.equal(requests('answer').length,0);
 assert.match(nodes['question-title'].textContent,/2 из 2/);
 const second=(nodes['question-body'].children||[]).filter(n=>String(n.className||'').includes('question-choice'));
 second[1].onclick();
 assert.deepEqual(Array.from(requests('answer')[0].answers['Цвет?']),['красный']);
 assert.deepEqual(Array.from(requests('answer')[0].answers['Форма?']),['квадрат']);
});

test('checkboxes preserve commas, show multiple custom answers added with Enter, and submit once',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview(),state=fresh();
 const label='Usage обновился сам, без клика';
 state.messages=[{id:'q',author:'Жека',text:'Выбор',question:{id:'r',items:[{id:'q1',prompt:'Выбор',multi:true,options:[{label}]}]}}];
 publish(state);
 const choices=()=>collect(nodes['question-body'],'question-choice');
 assert.equal(nodes['question-body'].querySelector('.question-multi'),null);
 assert.equal(choices()[0].attributes.role,'checkbox');
 assert.equal(choices()[0].querySelector('.question-mark').textContent,'☐');
 choices()[0].click();
 assert.equal(choices()[0].attributes['aria-checked'],'true');
 assert.equal(choices()[0].querySelector('.question-mark').textContent,'☑');
 assert.equal(requests('answer').length,0);
 assert.equal(nodes['question-dialog'].open,true);
 choices()[0].click();
 assert.equal(choices()[0].attributes['aria-checked'],'false');
 choices()[0].click();
 for(const text of ['свой, первый','второй','второй']) {
   const field=nodes['question-body'].querySelector('.question-free');field.value=text;
   let prevented=false;
   nodes['question-dialog'].listeners.keydown({target:field,key:'Enter',preventDefault:()=>{prevented=true;}});
   assert.ok(prevented);
   assert.equal(nodes['question-body'].querySelector('.question-free').value,'');
 }
 assert.equal(choices().length,3);
 assert.ok(choices().every(c=>c.attributes['aria-checked']==='true'));
 collect(nodes['question-body'],'question-remove')[1].click();
 assert.equal(choices().length,2);
 const done=nodes['question-actions'].querySelector('.question-done');
 done.click();done.click();
 assert.equal(requests('answer').length,1);
 assert.deepEqual(Array.from(requests('answer')[0].answers.q1),[label,'свой, первый']);
 state.messages[0].question.answered={q1:[label,'свой, первый']};publish(state);
 assert.equal(collect(nodes.feed,'question-card').length,1);
 assert.equal(collect(nodes.feed,'picked').length,2);
 assert.equal(nodes['question-dialog'].open,false);
});
test('answered question stays in the feed as a card and Anton is not quoted twice',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[
  {id:'q',author:'Колян',text:'Цвет?',question:{id:'r',items:[{prompt:'Цвет?',options:[{label:'синий'}]}],answered:{'Цвет?':'синий'}}}
 ];
 publish(state);
 assert.ok(!nodes['question-dialog'].open);
 const card=nodes.feed.querySelector('.question-card');
 assert.match(card.className,/\banswered\b/);
 assert.match(card.querySelector('.picked').textContent,/синий/);
 // The picked option is the answer; a second post from Anton repeating it was noise.
 assert.equal(nodes.feed.children.filter(n=>n.dataset&&n.dataset.messageId).length,1);
});
test('a failed turn shows a retry button on the red line',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 const state=fresh();
 state.messages=[{id:'e',author:'Trio',text:'Нет ответа 600 с',error:true,turn:'t1'}];
 state.turns=[{id:'t1',messageId:'q',recipient:'claude',status:'failed',executor:'claude',mode:'execute'}];
 publish(state);
 const retry=(nodes.feed.querySelector('.message-body').children||[]).find(n=>n.tag==='button'&&n.textContent==='Повторить');
 assert.ok(retry);
 retry.onclick();
 assert.equal(requests('retry')[0].turnId,'t1');
});
test('a markdown table in the feed becomes a real table, not pipe art',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'r',author:'Гриха',text:'см.\n\n| раздел | размер |\n|---|---:|\n| `/` | 6.1 G |\n\nвсё'}];
 publish(state);
 const body=nodes.feed.children.find(n=>n.dataset&&n.dataset.messageId==='r').querySelector('.message-body');
 const table=body.querySelector('table');
 assert.equal(table.className,'md-table');
 const ths=table.querySelector('thead').querySelector('tr').children;
 assert.equal(ths[0].textContent,'раздел');
 assert.equal(ths[1].className,'right');
 const tds=table.querySelector('tbody').querySelector('tr').children;
 assert.equal(tds[0].textContent,'`/`');
 assert.equal(tds[1].textContent,'6.1 G');
 assert.match(body.children[0].textContent,/см/);
 assert.match(body.children[2].textContent,/всё/);
});
test('a table row split by a false paragraph break still paints as one table',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'r',author:'Гриха',text:
  'смотри\n\n| что сделать | ждать |\n|---|---|\n| 1. Install `trio-chat-0.1.48.\n\nvsix` → Reload | шапка |\n| 2. Жеке вопрос | модалка |\n\nхвост'}];
 publish(state);
 const body=nodes.feed.children.find(n=>n.dataset&&n.dataset.messageId==='r').querySelector('.message-body');
 const table=body.querySelector('table');
 assert.ok(table);
 const tr=table.querySelector('tbody').children;
 assert.equal(tr.length,2);
 assert.match(tr[0].children[0].textContent,/trio-chat-0\.1\.48\.vsix/);
 assert.equal(tr[0].children[1].textContent,'шапка');
 assert.equal(tr[1].children[0].textContent,'2. Жеке вопрос');
 assert.match(body.children[body.children.length-1].textContent,/хвост/);
 assert.equal(body.children.filter(c=>c.className==='md-table-wrap').length,1);
});
test('a fenced markdown table stays literal text',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'r',author:'Гриха',text:'```\n| a | b |\n|---|---|\n| 1 | 2 |\n```'}];
 publish(state);
 const body=nodes.feed.children.find(n=>n.dataset&&n.dataset.messageId==='r').querySelector('.message-body');
 assert.equal(body.querySelector('table'),null);
 assert.match(body.children[0].textContent,/\|---\|/);
});
test('a running reply paints a tool trace as dots with a connecting line',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'r',author:'Гриха',text:'черновик',turn:'t1',partial:true}];
 state.turns=[{id:'t1',messageId:'q',recipient:'grok',status:'running',executor:'grok',
  trace:[{id:'a',kind:'thought',title:'Сверю код',status:'done'},{id:'b',kind:'tool',title:'Read adapter.ts',status:'running'}]}];
 publish(state,{provider:'grok',turnId:'t1'});
 const row=nodes.feed.children.find(n=>n.dataset&&n.dataset.messageId==='r');
 const trace=row.querySelector('.message-trace');
 assert.equal(trace.hidden,false);
 assert.equal(trace.children.length,2);
 assert.ok(trace.children[1].className.includes('busy'));
 assert.match(trace.children[1].querySelector('.trace-title').textContent,/Read adapter/);
});
test('a finished reply shows spend under the stamp when the engine reported it',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'r',author:'Колян',text:'ok',turn:'t1'}];
 state.turns=[{id:'t1',messageId:'q',recipient:'claude',status:'completed',executor:'claude',startedAt:1000,endedAt:2000,spent:324000,spentHint:'выход 4439 · запись кэша 207579'}];
 publish(state);
 const stamp=nodes.feed.children.find(n=>n.dataset&&n.dataset.messageId==='r').querySelector('.message-stamp');
 assert.match(stamp.textContent,/324к ток/);
 assert.match(stamp.textContent,/выход 4,4к/);
 assert.match(stamp.title,/запись кэша 207579/);
});
test('a finished reply shows elapsed time under the name',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'r',author:'Колян',text:'ok',turn:'t1'}];
 state.turns=[{id:'t1',messageId:'q',recipient:'claude',status:'completed',executor:'claude',startedAt:1000,endedAt:13000}];
 publish(state);
 const row=nodes.feed.children.find(n=>n.dataset&&n.dataset.messageId==='r');
 assert.equal(row.querySelector('.message-head span').textContent,'12 с');
});
test('a running reply shows elapsed time next to отвечает',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages=[{id:'r',author:'Колян',text:'',turn:'t1',partial:true}];
 state.turns=[{id:'t1',messageId:'q',recipient:'claude',status:'running',executor:'claude',startedAt:Date.now()-2500}];
 publish(state,{provider:'claude',turnId:'t1'});
 const row=nodes.feed.children.find(n=>n.dataset&&n.dataset.messageId==='r');
 assert.match(row.querySelector('.message-head span').textContent,/отвечает · \d+ с/);
 assert.match(nodes['floor-title'].textContent,/Колян отвечает · \d+ с/);
});
test('panel swap and keyboard resize persist without starting an agent',()=>{
 const {nodes,requests}=webview();
 nodes['swap-panels'].onclick();
 assert.equal(requests('layout').at(-1).side,'left');
 nodes['panel-divider'].onkeydown({key:'ArrowRight',preventDefault(){}});
 assert.equal(requests('layout').at(-1).width,420);
 assert.equal(requests('send').length,0);
 assert.equal(requests('handoff').length,0);
});

test('a question card does not duplicate its turn trace or token stamp',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview(),state=fresh();
 state.messages=[
  {id:'reply',author:'Жека',text:'Готово',turn:'t'},
  {id:'q',author:'Жека',text:'Вопрос',turn:'t',question:{id:'request',items:[{prompt:'Вопрос',options:[]}],answered:{'Вопрос':['Ответ']}}}
 ];
 state.turns=[{id:'t',messageId:'source',replyId:'reply',recipient:'codex',status:'completed',spent:1234,spentHint:'выход 10',
   trace:[{id:'tool',kind:'tool',title:'git status',status:'done'}]}];
 publish(state);
 assert.equal(collect(nodes.feed,'trace-item').length,1);
 const question=collect(nodes.feed,'message').find(n=>n.dataset.messageId==='q');
 assert.doesNotMatch(question.querySelector('.message-stamp').textContent,/ток/);
});

test('snippet helpers insert at the caret, filter, reorder and drop junk',()=>{
 assert.deepEqual(insertAtCursor('ab',1,1,'XY'),{value:'aXYb',caret:3});
 assert.deepEqual(insertAtCursor('hello',0,5,'x'),{value:'x',caret:1});
 const list=normalizeSnippets([
  {id:'a',name:'пакет коммит',text:'пакет коммит',flags:{autoCommands:true,responseOrder:['codex']}},
  {id:'a',name:'dup',text:'dup'},
  {id:'bad',name:'',text:'x'},
  {id:'b',name:'README',text:'прочитай README.md'}
 ]);
 assert.equal(list.length,2);
 assert.equal(list[0].flags.autoCommands,true);
 assert.deepEqual(filterSnippets(list,'readme').map(s=>s.id),['b']);
 assert.deepEqual(moveSnippet(list,'b','a').map(s=>s.id),['b','a']);
 const copy=duplicateSnippet(list,'a');
 assert.equal(copy.length,3);
 assert.match(copy[1].name,/копия/);
 assert.equal(removeSnippet(list,'a').length,1);
 const saved=upsertSnippet([],{id:'n1',name:'x',text:'y',flags:{autoEdits:true,autoCommands:false,discuss:true,responseOrder:[]}});
 assert.equal(saved[0].flags.discuss,true);
 assert.equal(flagsActive({autoCommands:true}),true);
 assert.equal(flagsActive({autoEdits:false,responseOrder:[]}),false);
 assert.match(flagsHint({autoCommands:true,responseOrder:['codex']}),/\+команды/);
 assert.match(flagsHint({autoCommands:true,responseOrder:['codex']}),/Жека/);
 assert.deepEqual(captureFlags({autoCommands:true,responseOrder:['codex','codex']}).responseOrder,['codex']);
 assert.equal(snippetLimits.count,40);
 assert.deepEqual(snippetCreateSource('из поля','поиск'),{text:'из поля',name:''});
 assert.deepEqual(snippetCreateSource('','проанализируй'),{text:'проанализируй',name:'проанализируй'});
 assert.deepEqual(snippetCreateSource('  ','  '),{text:'',name:''});
 const u1=snippetUndoPush([],'a','ab',1);
 const u2=snippetUndoPush(u1,'ab','abc',2);
 assert.deepEqual(snippetUndoApply(u2,'abc'),{stack:u1,value:'ab',caret:2,applied:true});
 assert.equal(snippetUndoApply(u2,'abcX').applied,false);
 assert.equal(snippetUndoApply([],'ab').applied,false);
});

test('a snippet inserts into the draft and does not send',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,requests,publish,execCalls}=webview();
 publish(fresh(),undefined,false,[],undefined,undefined,undefined,[
  {id:'s1',name:'пакет коммит',text:'пакет коммит',flags:{autoCommands:true,autoEdits:false,discuss:false,responseOrder:[]}}
 ]);
 assert.equal(nodes['snippets-panel'].hidden,true);
 nodes.draft.value='префикс ';
 nodes.draft.selectionStart=8;nodes.draft.selectionEnd=8;
 nodes['snippets-toggle'].onclick();
 assert.equal(nodes['snippets-panel'].hidden,false);
 assert.equal(nodes['snippets-filter'].hidden,false);
 assert.equal(nodes['snippets-empty-hint'].hidden,true);
 assert.equal(nodes['snippets-list'].querySelectorAll('.snippet-row').length,1);
 nodes['snippets-list'].querySelector('.snippet-name').onclick();
 assert.equal(nodes.draft.value,'префикс пакет коммит');
 assert.deepEqual(execCalls.at(-1),{cmd:'insertText',ui:false,value:'пакет коммит'});
 assert.equal(requests('send').length,0);
 assert.equal(requests('flags').at(-1).autoCommands,true);
 assert.equal(nodes['snippets-panel'].hidden,true);
});

test('empty snippets keep plus on the search row and hide the filter',()=>{
 const {nodes}=webview();
 nodes['snippets-toggle'].onclick();
 assert.equal(nodes['snippets-panel'].hidden,false);
 assert.equal(nodes['snippets-filter'].hidden,true);
 assert.equal(nodes['snippets-empty-hint'].hidden,false);
 assert.equal(nodes['snippets-from-field'].focused,true);
 assert.equal(nodes['snippets-list'].children.length,0);
});

test('repeated snippet inserts go through insertText, not by replacing the draft',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,execCalls}=webview();
 publish(fresh(),undefined,false,[],undefined,undefined,undefined,[
  {id:'s1',name:'Гриха',text:'Гриха пакуй +коммит'},
  {id:'s2',name:'Колян',text:'Колян пакуй +коммит'}
 ]);
 nodes.draft.value='321312';
 nodes.draft.selectionStart=6;nodes.draft.selectionEnd=6;
 nodes['snippets-toggle'].onclick();
 nodes['snippets-list'].querySelector('.snippet-name').onclick();
 assert.equal(nodes.draft.value,'321312Гриха пакуй +коммит');
 nodes.draft.value+='123123';
 nodes.draft.selectionStart=nodes.draft.selectionEnd=nodes.draft.value.length;
 nodes['snippets-toggle'].onclick();
 const rows=nodes['snippets-list'].querySelectorAll('.snippet-row');
 rows[1].querySelector('.snippet-name').onclick();
 assert.equal(nodes.draft.value,'321312Гриха пакуй +коммит123123Колян пакуй +коммит');
 assert.equal(execCalls.length,2);
 assert.equal(execCalls[0].value,'Гриха пакуй +коммит');
 assert.equal(execCalls[1].value,'Колян пакуй +коммит');
});

test('Ctrl+Z undoes one snippet insert at a time',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 publish(fresh(),undefined,false,[],undefined,undefined,undefined,[
  {id:'s1',name:'Гриха',text:'Гриха пакуй +коммит'},
  {id:'s2',name:'Колян',text:'Колян пакуй +коммит'}
 ]);
 nodes.draft.value='321312';
 nodes.draft.selectionStart=6;nodes.draft.selectionEnd=6;
 nodes['snippets-toggle'].onclick();
 nodes['snippets-list'].querySelector('.snippet-name').onclick();
 nodes['snippets-toggle'].onclick();
 nodes['snippets-list'].querySelectorAll('.snippet-row')[1].querySelector('.snippet-name').onclick();
 assert.equal(nodes.draft.value,'321312Гриха пакуй +коммитКолян пакуй +коммит');
 let prevented=0;
 const undo=()=>nodes.draft.onkeydown({key:'z',ctrlKey:true,metaKey:false,shiftKey:false,altKey:false,preventDefault(){prevented++;}});
 undo();
 assert.equal(nodes.draft.value,'321312Гриха пакуй +коммит');
 assert.equal(prevented,1);
 undo();
 assert.equal(nodes.draft.value,'321312');
 assert.equal(prevented,2);
 undo();
 assert.equal(nodes.draft.value,'321312');
 assert.equal(prevented,2);
});

test('Ctrl+Z does not steal keys after the draft was edited',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 publish(fresh(),undefined,false,[],undefined,undefined,undefined,[
  {id:'s1',name:'Гриха',text:'Гриха'}
 ]);
 nodes.draft.value='префикс ';
 nodes.draft.selectionStart=8;nodes.draft.selectionEnd=8;
 nodes['snippets-toggle'].onclick();
 nodes['snippets-list'].querySelector('.snippet-name').onclick();
 nodes.draft.value+='хвост';
 let prevented=false;
 nodes.draft.onkeydown({key:'z',ctrlKey:true,metaKey:false,shiftKey:false,altKey:false,preventDefault(){prevented=true;}});
 assert.equal(prevented,false);
 assert.equal(nodes.draft.value,'префикс Грихахвост');
});

test('Enter sends the draft, Shift+Enter does not',()=>{
 const {nodes}=webview();
 nodes.draft.value='строка';
 let submitted=false;
 nodes.composer.requestSubmit=()=>{submitted=true;};
 nodes.draft.onkeydown({key:'Enter',shiftKey:true,isComposing:false,ctrlKey:false,metaKey:false,altKey:false,preventDefault(){}});
 assert.equal(submitted,false);
 nodes.draft.onkeydown({key:'Enter',shiftKey:false,isComposing:false,ctrlKey:false,metaKey:false,altKey:false,preventDefault(){}});
 assert.equal(submitted,true);
});

test('slash in an empty draft opens snippets, a filled draft keeps the slash',()=>{
 const {nodes}=webview();
 let prevented=false;
 nodes.draft.onkeydown({key:'/',preventDefault(){prevented=true;},ctrlKey:false,metaKey:false,altKey:false});
 assert.equal(prevented,true);
 assert.equal(nodes['snippets-panel'].hidden,false);
 nodes.draft.value='текст';
 prevented=false;
 nodes.draft.onkeydown({key:'/',preventDefault(){prevented=true;},ctrlKey:false,metaKey:false,altKey:false});
 assert.equal(prevented,false);
});

test('save from the field stores text and optional flags',()=>{
 const {nodes,requests}=webview();
 nodes.draft.value='прочитай README.md';
 nodes['snippets-from-field'].onclick();
 assert.equal(nodes['snippet-dialog'].open,true);
 nodes['snippet-name'].value='README';
 nodes['snippet-keep-flags'].checked=false;
 nodes['snippet-save'].onclick();
 const saved=requests('snippets').at(-1).items[0];
 assert.equal(saved.name,'README');
 assert.equal(saved.text,'прочитай README.md');
 assert.equal(saved.flags,undefined);
 assert.equal(nodes['snippet-dialog'].open,false);
});

test('plus uses the search row when the draft is empty',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 publish(fresh(),undefined,false,[],undefined,undefined,undefined,[
  {id:'s1',name:'пакет коммит',text:'пакет коммит'}
 ]);
 nodes['snippets-toggle'].onclick();
 nodes['snippets-filter'].value='проанализируй';
 nodes['snippets-filter'].oninput();
 assert.equal(nodes['snippets-list'].querySelector('.snippet-empty').textContent,'Нет совпадений.');
 nodes['snippets-from-field'].onclick();
 assert.equal(nodes['snippet-dialog'].open,true);
 assert.equal(nodes['snippet-text'].value,'проанализируй');
 assert.equal(nodes['snippet-name'].value,'проанализируй');
 assert.equal(nodes['notice-text'].textContent,'');
 nodes['snippet-save'].onclick();
 const saved=requests('snippets').at(-1).items;
 assert.equal(saved.length,2);
 assert.equal(saved[1].name,'проанализируй');
 assert.equal(saved[1].text,'проанализируй');
 assert.equal(nodes['snippets-filter'].value,'');
 assert.equal(nodes['snippets-list'].querySelectorAll('.snippet-row').length,2);
});

test('plus prefers the draft over the search row',()=>{
 const {nodes}=webview();
 nodes.draft.value='из поля';
 nodes['snippets-filter'].value='поиск';
 nodes['snippets-from-field'].onclick();
 assert.equal(nodes['snippet-dialog'].open,true);
 assert.equal(nodes['snippet-text'].value,'из поля');
 assert.equal(nodes['snippet-name'].value,'');
});

test('plus with empty draft and search shows the notice',()=>{
 const {nodes}=webview();
 nodes['snippets-from-field'].onclick();
 assert.equal(nodes['snippet-dialog'].open,undefined);
 assert.equal(nodes['notice-text'].textContent,'Сначала набери текст.');
 assert.equal(nodes.notice.hidden,false);
});

test('notice closes on ×, fades by itself, holds while read, and errors stay longer',()=>{
 // shortError is what the extension now sends instead of the raw EPERM path.
 const {nodes,requests,respond,timers}=webview();
 const last=()=>timers.filter(t=>t.fn.toString().includes("notice('')")).at(-1);
 nodes['snippets-from-field'].onclick();
 assert.equal(nodes.notice.hidden,false);assert.equal(nodes.notice.classList.contains('error'),false);
 assert.equal(last().ms,5000);
 last().fn();
 assert.equal(nodes.notice.hidden,true);
 nodes['compact-all'].onclick();
 const {shortError}=require('../dist/storage/store');
 const compactError=shortError("EPERM: operation not permitted, rename 'c:\\\\very\\\\long\\\\path\\\\state.json.tmp' -> 'c:\\\\very\\\\long\\\\path\\\\state.json'");
 respond(requests('compact').at(-1),undefined,compactError);
 assert.equal(nodes.notice.hidden,false);assert.equal(nodes.notice.classList.contains('error'),true);
 assert.equal(nodes['notice-text'].textContent,compactError);
 assert.doesNotMatch(compactError,/very\\\\long\\\\path/);
 assert.match(compactError,/state\.json/);
 assert.equal(last().ms,15000);
 nodes.notice.onmouseenter();nodes.notice.onmouseleave();
 assert.equal(last().ms,15000,'пауза под курсором перезапускает срок ошибки');
 nodes['notice-text'].onclick();
 assert.equal(nodes.notice.classList.contains('open'),true);
 const count=timers.length;
 nodes.notice.onmouseenter();nodes.notice.onmouseleave();
 assert.equal(timers.length,count,'раскрытое не пропадает само');
 nodes['notice-close'].onclick();
 assert.equal(nodes.notice.hidden,true);assert.equal(nodes['notice-text'].textContent,'');
 assert.equal(nodes.notice.classList.contains('open'),false);
});

test('a snippet with remembered flags restores discuss and order',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 publish(fresh(),undefined,false,[],undefined,undefined,undefined,[
  {id:'s2',name:'двоим',text:'оцените',flags:{discuss:true,autoEdits:false,autoCommands:false,responseOrder:['codex','claude']}}
 ]);
 nodes['snippets-toggle'].onclick();
 nodes['snippets-list'].querySelector('.snippet-name').onclick();
 assert.equal(nodes.draft.value,'оцените');
 assert.equal(nodes.discuss.classList.contains('selected'),true);
 assert.deepEqual(nodes['response-order'].children.map(b=>b.textContent),['2 Колян','1 Жека']);
});

test('snippet filter hides non-matching rows and pencil opens the editor',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish,requests}=webview();
 publish(fresh(),undefined,false,[],undefined,undefined,undefined,[
  {id:'s1',name:'пакет коммит',text:'пакет коммит'},
  {id:'s2',name:'README',text:'прочитай README.md'}
 ]);
 nodes['snippets-toggle'].onclick();
 nodes['snippets-filter'].value='пакет';
 nodes['snippets-filter'].oninput();
 assert.equal(nodes['snippets-list'].querySelectorAll('.snippet-row').length,1);
 assert.equal(nodes['snippets-list'].querySelector('.snippet-name').textContent,'пакет коммит');
 nodes['snippets-list'].querySelector('.snippet-edit').onclick();
 assert.equal(nodes['snippet-dialog'].open,true);
 assert.equal(nodes['snippet-name'].value,'пакет коммит');
 nodes['snippet-delete'].onclick();
 assert.equal(requests('snippets').at(-1).items.length,1);
 assert.equal(requests('snippets').at(-1).items[0].id,'s2');
});

test('feed folds long messages at the configured line count and stops folding at zero',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const state=fresh();
 state.messages.push({id:'m1',author:'Колян',text:Array.from({length:90},(_,i)=>'строка '+i).join('\n')});
 publish(state);
 assert.equal(collect(nodes.feed,'long-message').length,0);
 publish(state,undefined,false,[],undefined,undefined,undefined,undefined,{collapseLines:70});
 assert.equal(collect(nodes.feed,'long-message').length,1);
 publish(state,undefined,false,[],undefined,undefined,undefined,undefined,{collapseLines:0});
 assert.equal(collect(nodes.feed,'long-message').length,0);
 const huge={id:'m2',author:'Колян',text:'x'.repeat(6001)};
 state.messages.push(huge);
 publish(state,undefined,false,[],undefined,undefined,undefined,undefined,{collapseLines:0});
 assert.equal(collect(nodes.feed,'long-message').length,1);
});

test('feed meter counts every message and stays full past the setting',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,publish}=webview();
 const paint=(n,max)=>{
  const state=fresh();
  state.messages=Array.from({length:n},(_,i)=>({id:'m'+i,author:'Trio',text:'n',control:true}));
  publish(state,undefined,false,[],undefined,undefined,undefined,undefined,{feedMax:max});
 };
 paint(0,1000);
 assert.equal(nodes['feed-meter-text'].textContent,'Сообщений: 0');
 assert.equal(nodes['feed-meter-fill'].style.width,'0%');
 assert.equal(nodes['feed-meter'].classList.contains('high'),false);
 assert.equal(nodes['feed-meter'].classList.contains('hot'),false);
 paint(500,1000);
 assert.equal(nodes['feed-meter-text'].textContent,'Сообщений: '+(500).toLocaleString('ru-RU'));
 assert.equal(nodes['feed-meter-fill'].style.width,'50%');
 assert.equal(nodes['feed-meter'].classList.contains('high'),true);
 assert.equal(nodes['feed-meter'].classList.contains('hot'),false);
 paint(800,1000);
 assert.equal(nodes['feed-meter'].classList.contains('hot'),true);
 assert.equal(nodes['feed-meter'].classList.contains('high'),false);
 assert.equal(nodes['feed-meter-fill'].style.width,'80%');
 paint(1200,1000);
 assert.equal(nodes['feed-meter-text'].textContent,'Сообщений: '+(1200).toLocaleString('ru-RU'));
 assert.equal(nodes['feed-meter-fill'].style.width,'100%');
 assert.match(nodes['feed-meter'].title,/1050/);
 assert.match(nodes['feed-meter'].title,/после 1200/);
 assert.match(nodes['feed-meter'].title,/не блокируется/);
 assert.match(nodes['feed-meter'].title,/настройках Trio/);
});

test('privileges open a checklist and a second click turns the button off',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,requests,publish}=webview();
 const state=fresh();
 publish(state);
 nodes['auto-privileges'].onclick();
 assert.equal(nodes['privilege-dialog'].open,true);
 assert.match(nodes['privilege-reading'].textContent,/У Коляна и Жеки включено Чтение — они не смогут вносить правки/);
 nodes['privilege-ok'].onclick();
 assert.equal(nodes['privilege-dialog'].open,false);
 assert.equal(requests('flags').length,0);
 nodes['auto-privileges'].onclick();
 nodes['privilege-all'].onclick();
 for (const id of ['delete','network','git','shell','unparsed','other']) assert.equal(nodes['privilege-'+id].checked,true);
 nodes['privilege-git'].checked=false;
 nodes['privilege-ok'].onclick();
 assert.equal(JSON.stringify(requests('flags').at(-1).privileges),JSON.stringify(['delete','network','shell','unparsed','other']));
 assert.equal(requests('flags').at(-1).privilegeOn,true);
 state.privilegeOn=true;
 state.privileges=['git'];
 state.agents.forEach(a=>{a.mode='execute';});
 state.messages=[{id:'m',author:'Антон',text:'hi'}];
 state.turns=[{id:'t',messageId:'m',recipient:'claude',status:'proposed',mode:'discuss'}];
 state.queue=['t'];
 publish(state);
 assert.equal(nodes['auto-privileges'].classList.contains('selected'),true);
 nodes['auto-privileges'].onclick();
 assert.equal(nodes['privilege-dialog'].open,false);
 assert.equal(requests('flags').at(-1).privilegeOn,false);
 state.privilegeOn=false;
 publish(state);
 nodes['auto-privileges'].onclick();
 assert.equal(nodes['privilege-dialog'].open,true);
 assert.equal(nodes['privilege-git'].checked,true);
 assert.doesNotMatch(nodes['privilege-reading'].textContent,/включено Чтение/);
 assert.match(nodes['privilege-reading'].textContent,/В очереди у Коляна режим Чтение/);
 const posted=requests('flags').length;
 nodes['privilege-cancel'].onclick();
 assert.equal(nodes['privilege-dialog'].open,false);
 assert.equal(requests('flags').length,posted);
});

test('new conversation asks who writes the summary and can store the current count',()=>{
 const {fresh}=require('../dist/shared/model');
 const {nodes,requests,publish}=webview();
 const state=fresh();
 state.agents.forEach(a=>{a.enabled=true;});
 state.messages=[{id:'a',author:'Антон',text:'hi'},{id:'b',author:'Trio',text:'note',control:true}];
 publish(state,{provider:'claude',turnId:'running'});
 assert.equal(nodes['new-conversation'].disabled,false);
 assert.equal(nodes['reset-context'].disabled,true);
 nodes['new-conversation'].onclick();
 assert.equal(nodes['fresh-dialog'].open,true);
 assert.equal(nodes['fresh-agents'].children.length,3);
 assert.equal(nodes['fresh-agents'].children[0].classList.contains('selected'),true);
 nodes['fresh-agents'].children[2].onclick();
 assert.equal(nodes['fresh-agents'].children[2].classList.contains('selected'),true);
 nodes['fresh-go'].onclick();
 assert.equal(requests('fresh-summary').at(-1).provider,'grok');
 assert.equal(requests('reset').length,0);
 assert.equal(nodes['fresh-dialog'].open,false);
 nodes['new-conversation'].onclick();
 assert.equal(nodes['fresh-count-value'].textContent,(2).toLocaleString('ru-RU'));
 assert.equal(nodes['fresh-remember'].disabled,false);
 assert.equal(nodes['fresh-agents'].style.gridTemplateColumns,'repeat(3, minmax(0, 1fr))');
 nodes['fresh-remember'].onclick();
 assert.equal(requests('feed-max').at(-1).count,2);
 assert.equal(nodes['fresh-dialog'].open,false);
 state.turns=[{id:'s',messageId:'a',recipient:'grok',status:'proposed',summary:true}];
 state.queue=['s'];
 publish(state);
 assert.equal(nodes.send.disabled,true);
 assert.equal(nodes['new-conversation'].disabled,true);
 const actions=nodes.queued.querySelector('.queue-actions');
 assert.deepEqual(actions.children.map(n=>n.textContent),['сводка следом','Снять']);
 // Stored as Anton's for the numbering, but signed by Trio in the feed.
 const task=nodes.feed.children.find(n=>n.dataset?.messageId==='a');
 assert.equal(task.querySelector('.message-head strong').textContent,'Trio · кнопка «Новый»');
 assert.match(task.className,/\bsystem\b/);
});


test('compaction disables new conversation including a dialog that is already open',()=>{
 const {nodes,publish,requests}=webview();
 const state=require('../dist/shared/model').fresh();
 publish(state);
 nodes['new-conversation'].onclick();
 assert.equal(nodes['fresh-dialog'].open,true);
 assert.equal(nodes['fresh-count-value'].textContent,'0');
 assert.equal(nodes['fresh-remember'].disabled,true);
 publish(state,undefined,false,[],'claude');
 assert.equal(nodes['new-conversation'].disabled,true);
 assert.equal(nodes['fresh-go'].disabled,true);
 nodes['fresh-go'].onclick();
 assert.equal(requests('fresh-summary').length,0);
 nodes['fresh-cancel'].onclick();
 nodes['new-conversation'].onclick();
 assert.equal(nodes['fresh-dialog'].open,false);
 publish(state);
 assert.equal(nodes['new-conversation'].disabled,false);
 nodes['new-conversation'].onclick();
 nodes['fresh-go'].onclick();
 assert.equal(requests('fresh-summary').length,1);
});
