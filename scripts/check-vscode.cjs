// Isolated VS Code profile; no installed extensions, login, or model calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process');
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'trio-vscode-check-'));
 const workspace=path.join(root,'workspace'),userData=path.join(root,'profile'),extensions=path.join(root,'extensions');
 for(const dir of [workspace,userData,extensions])fs.mkdirSync(dir,{recursive:true});
 const resultFile=path.join(root,'result.json'),phaseFile=path.join(root,'phase.json');
 const source=[
  "const vscode=require('vscode'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');",
  'const root='+JSON.stringify(root)+';',
  "function log(){const files=[];function scan(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())scan(f);else if(e.name.endsWith('-Trio.log'))files.push(f);}}scan(path.join(root,'profile','logs'));return files.map(f=>fs.readFileSync(f,'utf8')).join('\\n');}",
  "async function until(fn){const end=Date.now()+25000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,200));}throw new Error('Host condition timeout. '+log());}",
  "exports.run=async()=>{try{",
  "const ext=vscode.extensions.getExtension('trio-local.trio-chat');assert.ok(ext);await ext.activate();",
  "const phaseFile=path.join(root,'phase.json');const phase=fs.existsSync(phaseFile)?JSON.parse(fs.readFileSync(phaseFile,'utf8')):undefined;",
  "if(!phase){",
  "await vscode.commands.executeCommand('trio.open');await until(()=>log().includes('Panel ready'));",
  "await vscode.commands.executeCommand('trio.popout');",
  "await new Promise(r=>setTimeout(r,1000));",
  "fs.writeFileSync(phaseFile,JSON.stringify({ready:log().split('Panel ready').length-1}));",
  "try{await vscode.commands.executeCommand('workbench.action.reloadWindow');}catch(e){if(!String(e).includes('Canceled'))throw e;}await new Promise(()=>{});",
  "}else{",
  "await until(()=>log().includes('Restoring panel')&&log().includes('Panel HTML set · detached')&&log().split('Panel ready').length-1>phase.ready);",
  "const tabs=vscode.window.tabGroups.all.flatMap(g=>g.tabs).filter(t=>/^Trio(?: |$)/.test(t.label));assert.equal(tabs.length,1);",
  "fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({ok:true,version:ext.packageJSON.version,log:log()}));",
  "}",
  "}catch(e){fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({ok:false,error:String(e),log:log()}));throw e;}};"
 ].join('\n');
 const harness=path.join(root,'harness');fs.mkdirSync(harness);
 fs.writeFileSync(path.join(harness,'package.json'),JSON.stringify({name:'trio-host-check',publisher:'trio-test',version:'0.0.1',engines:{vscode:'^1.95.0'},main:'main.cjs',activationEvents:['onStartupFinished']}));
 fs.writeFileSync(path.join(harness,'main.cjs'),source.replace('exports.run=','exports.activate='));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(process.env.TRIO_TEST_VSCODE||'C:/Program Files/Microsoft VS Code/Code.exe',[
  '--user-data-dir',userData,'--extensions-dir',extensions,'--disable-extensions','--disable-workspace-trust',
  '--skip-welcome','--skip-release-notes','--new-window','--extensionDevelopmentPath='+path.resolve(__dirname,'..'),
  '--extensionDevelopmentPath='+harness,workspace
 ],{windowsHide:true,stdio:['ignore','pipe','pipe'],env});
 let error,output='';child.on('error',e=>{error=e;});child.stdout.on('data',d=>{output+=d;});child.stderr.on('data',d=>{output+=d;});
 console.log('Isolated VS Code check: '+root);
 try{
  const until=Date.now()+75000;
  while(!fs.existsSync(resultFile)){
   if(error)throw error;
   if(Date.now()>until)throw new Error('Isolated reload check timed out. '+output.slice(-3500));
   await new Promise(r=>setTimeout(r,250));
  }
  const result=JSON.parse(fs.readFileSync(resultFile,'utf8'));
  if(!result.ok)throw new Error(result.error+'\n'+result.log);
  console.log('VS Code '+result.version+': detached panel reloaded, serializer ran, webview handshake restored; no model calls.');
  console.log('Evidence: '+resultFile);
 }finally{
  if(child.pid){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
  child.stdout.destroy();child.stderr.destroy();child.unref();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
