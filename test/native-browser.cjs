'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { withBrowser } = require('./browser-session.cjs');
async function main() {
  if (!process.env.SIDE_NATIVE_PACKAGE) throw new Error('Set SIDE_NATIVE_PACKAGE to the actual archive.');
  return withBrowser(async ({ f, cdp }) => {
    const checks = [];
    const call = async (expression) => {
      const r = await cdp.js(expression);
      if (!r?.ok) throw new Error(`Native manager RPC failed: ${r?.error?.code ?? 'unknown'}`);
      return r.value;
    };
    const mainId = await cdp.js(`window.__SIDE_ACCEPTANCE__.create(${JSON.stringify(f.cwd)})`);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(mainId)}, 'NATIVE-MAIN-MARKER: 演示海豚42')`);
    if (process.env.SIDE_NATIVE_INSTALL === 'service') {
      const inspected = await call(`window.__SIDE_ACCEPTANCE__.bundleInspect(${JSON.stringify(path.resolve(f.nativeArchive))})`);
      assert.equal(inspected.problem, undefined);
      const installed = await call(`window.__SIDE_ACCEPTANCE__.bundleInstall(${JSON.stringify(path.resolve(f.nativeArchive))})`);
      if (!['applied', 'restart-required'].includes(installed.application)) throw new Error(`Native install activation: ${installed.application}`);
      checks.push({ name: 'actual-tgz-installed-by-official-manager-rpc', passed: true });
    }
    const list = await call('window.__SIDE_ACCEPTANCE__.bundleList()');
    const bundle = list.find(b => (b.name ?? b.packageName) === 'dsh-client-ui-side');
    assert.ok(bundle); checks.push({ name: 'native-manager-lists-bundle', passed: true });
    await cdp.js(`window.__SIDE_ACCEPTANCE__.side(${JSON.stringify(mainId)})`);
    await cdp.until("Boolean(document.querySelector('[data-side-chat-pane]'))", 'native pane');
    const sideId = await cdp.js(`window.__SIDE_ACCEPTANCE__.binding(${JSON.stringify(mainId)})`);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(sideId)}, 'NATIVE-FIRST: 请解释演示标记')`);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(sideId)}, 'NATIVE-SECOND: 继续解释')`);
    await cdp.until("document.querySelector('[data-side-chat-pane]')?.innerText.includes('NATIVE-FIRST') && document.querySelector('[data-side-chat-pane]')?.innerText.includes('NATIVE-SECOND') && document.body.innerText.includes('356')", 'native turns usage');
    const request = fs.readFileSync(f.env.DSH_FAKE_LLM_LOG, 'utf8').trim().split('\n').map(JSON.parse).findLast(r => JSON.stringify(r.messages).includes('NATIVE-SECOND'));
    assert.equal(request.messages.filter(m => m.source?.kind === 'session-reference').length, 1);
    assert.ok(JSON.stringify(request.messages).includes('NATIVE-MAIN-MARKER'));
    const tools = request.tools; assert.ok(tools.includes('read')); assert.ok(!tools.some(n => /^(write|edit|bash|shell|terminal)$/.test(n)));
    checks.push({ name: 'native-first-followup-snapshot-readonly-usage', passed: true });
    await cdp.js("Array.from(document.querySelectorAll('[data-side-context] button')).find(b=>b.textContent==='检查更新').click()");
    await cdp.until("document.querySelector('[data-side-update]')?.dataset.sideUpdate==='disabled'", 'native update UI');
    assert.equal(await cdp.js("document.querySelector('[data-side-update]').innerText.includes('1.1.3')"), true);
    checks.push({ name: 'manual-update-disabled-real-ui', passed: true });
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(mainId)}, 'NATIVE-LATE-MARKER: 新内容')`);
    await call(`window.__SIDE_ACCEPTANCE__.sideFlag(${JSON.stringify(mainId)}, '--refresh', ${JSON.stringify(sideId)})`);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(sideId)}, 'NATIVE-AFTER-REFRESH')`);
    const refreshed = fs.readFileSync(f.env.DSH_FAKE_LLM_LOG, 'utf8').trim().split('\n').map(JSON.parse).findLast(r => JSON.stringify(r.messages).includes('NATIVE-AFTER-REFRESH'));
    assert.ok(JSON.stringify(refreshed.messages).includes('NATIVE-LATE-MARKER'));
    assert.equal(refreshed.messages.filter(m => m.source?.kind === 'session-reference').length, 1);
    checks.push({ name: 'native-context-refresh-replaces-snapshot', passed: true });
    const rows = await cdp.js(`Array.from(document.querySelectorAll('[data-row-key]')).filter(e=>e.dataset.rowKey.includes(${JSON.stringify(sideId)}) && getComputedStyle(e).display!=='none').length`);
    assert.equal(rows, 0); checks.push({ name: 'native-navigation-hides-side', passed: true });
    if (process.env.SIDE_TEST_SHOT) { const shot = await cdp.call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(process.env.SIDE_TEST_SHOT, Buffer.from(shot.data, 'base64')); }
    // A real disable/enable operation may require restart when HMR is unavailable.
    const off = await call('window.__SIDE_ACCEPTANCE__.bundleEnable(false)');
    assert.ok(['applied','restart-required'].includes(off.application));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.profile,'package.json'))).dsh.profile.bundles.includes('dsh-client-ui-side'), false);
    const on = await call('window.__SIDE_ACCEPTANCE__.bundleEnable(true)');
    assert.ok(['applied','restart-required'].includes(on.application));
    checks.push({ name: 'official-manager-disable-enable', passed: true, application: [off.application,on.application] });
    await new Promise(resolve=>setTimeout(resolve,1500));
    const reopened = await cdp.js(`window.__SIDE_ACCEPTANCE__.side(${JSON.stringify(mainId)})`);
    await cdp.until("Boolean(document.querySelector('[data-side-chat-pane]'))", 're-enabled native pane');
    assert.equal(await cdp.js(`window.__SIDE_ACCEPTANCE__.binding(${JSON.stringify(mainId)})`), sideId);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.close(${JSON.stringify(mainId)})`);
    await cdp.until("!document.querySelector('[data-side-chat-pane]')", 'native close');
    await cdp.until(`!window.__SIDE_ACCEPTANCE__.binding(${JSON.stringify(mainId)})`, 'native binding clear');
    const exists = id => fs.readdirSync(path.join(f.home,'sessions')).some(b => fs.existsSync(path.join(f.home,'sessions',b,id)));
    for(let attempt=0;attempt<60&&exists(sideId);attempt++)await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(exists(sideId), false, 'closed side log must disappear after delete finishes');
    await cdp.js(`window.__SIDE_ACCEPTANCE__.side(${JSON.stringify(mainId)})`);
    await cdp.until("Boolean(document.querySelector('[data-side-chat-pane]'))", 'native new pane');
    const nextId = await cdp.js(`window.__SIDE_ACCEPTANCE__.binding(${JSON.stringify(mainId)})`); assert.notEqual(nextId,sideId);
    await cdp.until("document.querySelector('[data-side-chat-pane]') && !document.querySelector('[data-side-chat-pane]').innerText.includes('NATIVE-FIRST')", 'new pane has no old content');
    checks.push({ name: 'native-close-deletes-reopen-new-empty', passed: true });
    const removed = await call('window.__SIDE_ACCEPTANCE__.bundleRemove()');
    assert.ok(['applied','restart-required'].includes(removed.application));
    if (removed.application === 'applied') {
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.profile,'package.json'))).dependencies?.['dsh-client-ui-side'],undefined);
      assert.equal(exists(nextId),true);
    }
    checks.push({ name: 'official-manager-remove-preserves-unended-side', passed: true, application: removed.application });
    assert.equal(cdp.errors.length,0); checks.push({ name:'no-console-errors',passed:true });
    console.log(JSON.stringify({passed:true,provider:'fake',browser:'local-edge',checks},null,2));
  });
}
module.exports = { main };
if (require.main === module) main().catch(e=>{console.error(String(e.message).replace(/\/(?:Users|private|var)\/[^\s\n)]+/g,'<local-path>'));process.exitCode=1;});
