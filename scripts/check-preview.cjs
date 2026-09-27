// Browser smoke test for the standalone prototype. Uses installed Edge and Node's WebSocket.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

async function main() {
  const edge = process.env.TRIO_PREVIEW_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  if (!fs.existsSync(edge)) throw new Error('Set TRIO_PREVIEW_BROWSER to your Chromium browser executable.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trio-preview-check-'));
  const profile = path.resolve(root, 'browser-profile');
  const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let browserError;
  child.on('error', e => { browserError = e; });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const until = Date.now() + 20000;
    while (!fs.existsSync(portFile)) {
      if (browserError) throw browserError;
      if (Date.now() > until) throw new Error('Browser did not start its local debugging endpoint.');
      await delay(100);
    }
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    const endpoint = 'http://127.0.0.1:' + port;
    const pages = await (await fetch(endpoint + '/json/list')).json();
    const page = pages.find(p => p.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let sequence = 0;
    const waiting = new Map(), errors = [], requests = [];
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = waiting.get(message.id);
        if (!pending) return;
        waiting.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
      if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
    };
    function call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
        waiting.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function poll(expression, timeout = 10000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try { if (await evaluate(expression)) return; } catch { /* Navigation can replace the execution context. */ }
        await delay(100);
      }
      throw new Error('Browser condition failed: ' + expression);
    }
    const getState = "JSON.parse(localStorage.getItem('trio.interface-preview.v1'))";
    async function send(text, recipient = 'all') {
      await evaluate(`(() => { const draft = document.getElementById('draft'); draft.value = ${JSON.stringify(text)}; draft.dispatchEvent(new Event('input')); const to = document.getElementById('recipient'); to.value = ${JSON.stringify(recipient)}; to.dispatchEvent(new Event('change')); document.getElementById('composer').requestSubmit(); })()`);
    }
    await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: pathToFileURL(path.resolve(__dirname, '../webview/preview.html')).href });
    await poll("document.querySelectorAll('.agent').length === 3");
    const desktop = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, 'desktop.png'), Buffer.from(desktop.data, 'base64'));
    assert.equal(await evaluate(getState + '.agents.filter(a => a.enabled).length'), 2);

    await evaluate("document.querySelector('[data-agent=grok] input').click()");
    assert.equal(await evaluate(getState + '.agents.filter(a => a.enabled).length'), 3);
    await evaluate("document.querySelector('[data-agent=claude] input').click(); document.querySelector('[data-agent=codex] input').click(); document.querySelector('[data-agent=grok] input').click()");
    assert.equal(await evaluate(getState + '.agents.filter(a => a.enabled).length'), 1);
    await evaluate("document.querySelector('[data-agent=claude] input').click(); document.querySelector('[data-agent=codex] input').click()");

    await evaluate("document.querySelector('[data-agent=codex] .agent-bottom button').click(); document.getElementById('model').value = 'Preview model'; document.getElementById('settings-form').requestSubmit()");
    assert.equal(await evaluate(getState + '.agents[1].model'), 'Preview model');
    assert.equal(await evaluate(getState + '.active'), null);

    await send('<img src=x onerror="window.previewXss=true">');
    assert.equal(await evaluate(getState + '.active'), null);
    assert.equal(await evaluate('!!window.previewXss'), false);
    assert.equal(await evaluate("document.querySelectorAll('#feed img').length"), 0);
    await evaluate("document.querySelector('#handoffs button').click()");
    await poll(getState + '.active !== null');
    await poll(getState + '.messages.at(-1).text.length > 8');
    await send('Queued example', 'codex');
    await evaluate("document.querySelector('[data-agent=claude] .stop-one').focus()");
    await delay(250);
    assert.equal(await evaluate("document.activeElement.classList.contains('stop-one')"), true);
    await evaluate("document.querySelector('[data-agent=claude] .stop-one').click()");
    const partial = await evaluate(getState + '.messages.findLast(m => m.partial).text');
    await delay(450);
    assert.equal(await evaluate(getState + '.active'), null);
    assert.equal(await evaluate(getState + '.messages.findLast(m => m.partial).text'), partial);
    assert.equal(await evaluate(getState + '.messages.filter(m => m.queued).length'), 1);

    await evaluate("document.querySelector('#queued button').click(); document.querySelectorAll('#handoffs button')[1].click()");
    await poll(getState + '.active === null', 12000);
    assert.equal(await evaluate(getState + '.messages.at(-1).author'), 'codex');
    assert.equal(await evaluate(getState + '.pending'), null);
    await send('\u043f\u0440\u043e\u0447\u0438\u0442\u0430\u043b', 'grok');
    assert.equal(await evaluate(getState + '.active'), null);

    await evaluate("document.getElementById('draft').value='Saved draft'; document.getElementById('draft').dispatchEvent(new Event('input'))");
    await call('Page.reload');
    await poll("document.getElementById('draft')?.value === 'Saved draft'");
    await evaluate("document.getElementById('search-toggle').click(); document.getElementById('search').value='Queued example'; document.getElementById('search').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.querySelectorAll('#feed .message:not([hidden])').length"), 1);
    await evaluate("document.getElementById('search-toggle').click()");

    await evaluate("document.getElementById('popout').click()");
    let popup;
    for (let i = 0; i < 30; i++) {
      popup = (await (await fetch(endpoint + '/json/list')).json()).find(p => p.id !== page.id && p.type === 'page' && p.url.includes('preview.html'));
      if (popup) break;
      await delay(100);
    }
    assert.ok(popup, 'Separate window opens for the preview');

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await delay(150);
    assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'No horizontal overflow at 390px');
    const narrow = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(root, 'narrow.png'), Buffer.from(narrow.data, 'base64'));
    assert.deepEqual(errors, [], 'No runtime errors');
    assert.deepEqual(requests.filter(url => /^https?:/.test(url)), [], 'Preview sends no HTTP requests');
    console.log('Browser checks passed: participants, handoff, queue, stop, settings, escaped text, saved draft, search, separate window, narrow layout, no HTTP requests.');
    console.log('Screenshots: ' + root);
  } finally {
    ws?.close();
    if (child.pid) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* Browser already exited. */ }
    }
    // Delete only the new browser profile inside this test's resolved temporary directory.
    const expectedRoot = path.resolve(root) + path.sep;
    if (!profile.startsWith(expectedRoot)) throw new Error('Unsafe browser-profile cleanup path');
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* OS may retain a profile lock; screenshots remain in temp. */ }
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
