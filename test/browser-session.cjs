'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare } = require('./runtime-smoke.cjs');
const { spawnOwned } = require('./process-tools.cjs');
const YAML = require('../vendor/yaml');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.seq = 0; this.pending = new Map(); this.errors = [];
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.ws.close(); reject(new Error('CDP connection timeout')); }, 5000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP connection failed')); };
    });
    this.ws.onclose = () => this.dispose();
    this.ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.length < 100 && this.errors.push('runtime-exception: ' + String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).split('\n').slice(0,4).join(' '));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.length < 100 && this.errors.push('console-error: ' + m.params.args.map(a=>a.value??a.description??'').join(' ').slice(0,500));
      if (m.method === 'Page.javascriptDialogOpening') void this.call('Page.handleJavaScriptDialog', { accept: true });
    };
  }
  dispose() {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP closed')); }
    this.pending.clear(); this.ws.close();
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async js(expression) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('Browser evaluation failed: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0]);
    return r.result?.value;
  }
  async until(expression, label, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await this.js(expression)) return; await sleep(150); }
    throw new Error(`UI wait failed: ${label}`);
  }
}

async function withBrowser(task, options = {}) {
  if (!globalThis.WebSocket) throw new Error('Browser tests require Node with WebSocket support.');
  const edge = process.env.SIDE_TEST_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  if (!fs.existsSync(edge)) throw new Error('Set SIDE_TEST_BROWSER to a local compatible Chromium browser.');
  let f, server, browser, browserHome, cdp;
  try {
    f = prepare(options.bundleRoot);
    browserHome = fs.mkdtempSync(path.join(os.tmpdir(), 'side-browser-'));
    fs.symlinkSync(path.join(__dirname, 'browser-driver'), path.join(f.profile, 'node_modules/side-chat-browser-driver'));
    fs.appendFileSync(path.join(f.profile, 'cordis.patch.yml'), YAML.stringify([{ insert: [{ id: 'browser-driver', name: 'side-chat-browser-driver' }] }]));
    let startup = '', url, startupComplete = false, errorTail = ''; 
    server = spawnOwned(f.cli, ['web', '--no-open', '--port', '0'], { cwd: f.cwd, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.child.stdout.on('data', bytes => {
      if (startupComplete) return;
      startup = (startup + bytes).slice(-16384);
      url = startup.match(/dsh web: (https?:\/\/\S+)/)?.[1];
      if (url) { startup = ''; startupComplete = true; }
    });
    server.child.stderr.on('data', b => { errorTail = (errorTail + b.toString()).slice(-12000); });
    for (let i = 0; i < 160 && !url; i++) { await sleep(100); if (server.isClosed) throw new Error('Isolated web server exited.'); }
    if (!url) throw new Error('Isolated web startup timed out.');
    browser = spawnOwned(edge, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${browserHome}`, 'about:blank'], { stdio: 'ignore' });
    const active = path.join(browserHome, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(active); i++) await sleep(100);
    if (!fs.existsSync(active)) throw new Error('Test browser did not start.');
    const port = fs.readFileSync(active, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    cdp = new CDP(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.call('Runtime.enable'); await cdp.call('Page.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await cdp.call('Page.navigate', { url }); url = undefined;
    await cdp.until('Boolean(window.__SIDE_ACCEPTANCE__)', 'test services');
    return await task({ f, cdp, server, browser, getServerErrors: () => errorTail });
  } finally {
    cdp?.dispose();
    const stopped = await Promise.allSettled([browser?.stop(), server?.stop()]);
    f?.cleanup(); if (browserHome) fs.rmSync(browserHome, { recursive: true, force: true });
    if (stopped.some(r => r.status === 'rejected')) throw new Error('Owned test process cleanup failed.');
  }
}
module.exports = { withBrowser, CDP, sleep };
