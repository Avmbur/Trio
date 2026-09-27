const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {PanelConnection,renderPanelHtml}=require('../dist/ui/panelConnection');

test('restored panel retries a lost handshake, then stops; successful replies cancel retries',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let pings=0,reloads=0,failed=0;
 const connection=new PanelConnection(()=>pings++,()=>reloads++,()=>failed++,10);
 connection.check();assert.equal(pings,1);
 t.mock.timers.tick(10);assert.equal(reloads,1);assert.equal(pings,2);
 connection.received();t.mock.timers.tick(100);assert.equal(reloads,1);
 connection.check();t.mock.timers.tick(10);t.mock.timers.tick(10);t.mock.timers.tick(10);
 assert.equal(reloads,3);assert.equal(failed,1);
 connection.dispose();t.mock.timers.tick(100);assert.equal(reloads,3);
});

test('closing or hiding panel cancels a pending recovery',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let reloaded=false;
 const connection=new PanelConnection(()=>{},()=>{reloaded=true;},()=>{},10);
 connection.check();connection.pause();t.mock.timers.tick(20);assert.equal(reloaded,false);
 connection.check();connection.dispose();t.mock.timers.tick(20);assert.equal(reloaded,false);
});

test('packaged HTML embeds scripts and styles with fresh nonces and valid JavaScript',()=>{
 const read=n=>fs.readFileSync('webview/'+n,'utf8');
 const html=renderPanelHtml(read('main.html'),read('main.css'),read('composer.js'),read('main.js'),'freshNonce','vscode-resource:','0.1.5');
 assert.doesNotMatch(html,/\{\{(?:css|script|composer|version|nonce)\}\}/);
 assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+stylesheet/);
 assert.match(html,/style-src vscode-resource: 'nonce-freshNonce'/);
 for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
 assert.match(html,/v0.1.5/);
});
