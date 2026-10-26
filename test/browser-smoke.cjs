'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { withBrowser, sleep } = require('./browser-session.cjs');
async function main() {
  return withBrowser(async ({ f, cdp }) => {
    const checks = [];
    const mainId = await cdp.js(`window.__SIDE_ACCEPTANCE__.create(${JSON.stringify(f.cwd)})`);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(mainId)}, 'DEMO-MAIN-MARKER: 蓝鲸42')`);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.side(${JSON.stringify(mainId)})`);
    await cdp.until("Boolean(document.querySelector('[data-side-chat-pane]'))", 'pane mount');
    const sideId = await cdp.js(`window.__SIDE_ACCEPTANCE__.binding(${JSON.stringify(mainId)})`);
    assert.ok(sideId);
    checks.push({ name: 'real-command-opens-bound-side', passed: true });
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(sideId)}, 'DEMO-FIRST: 请解释主对话中的演示代号。')`);
    await cdp.until("document.querySelector('[data-side-chat-pane]')?.innerText.includes('DEMO-FIRST') && document.querySelector('[data-side-chat-pane]')?.innerText.includes('FAKE-REPLY')", 'first turn visible');
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(sideId)}, 'DEMO-SECOND: 继续说明。')`);
    await cdp.until("document.querySelector('[data-side-chat-pane]')?.innerText.includes('DEMO-SECOND')", 'followup visible');
    const requests = fs.readFileSync(f.env.DSH_FAKE_LLM_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    const actual = requests.findLast(r => JSON.stringify(r.messages).includes('DEMO-SECOND'));
    assert.equal(actual.messages.filter(m => m.source?.kind === 'session-reference').length, 1);
    assert.ok(JSON.stringify(actual.messages).includes('DEMO-MAIN-MARKER'));
    checks.push({ name: 'first-followup-one-main-snapshot', passed: true });
    await cdp.until("document.body.innerText.includes('356')", 'usage update');
    checks.push({ name: 'fake-usage-updates', passed: true });
    const visibleSideRows = await cdp.js(`Array.from(document.querySelectorAll('[data-row-key]')).filter(e=>e.dataset.rowKey.includes(${JSON.stringify(sideId)}) && getComputedStyle(e).display!=='none').length`);
    assert.equal(visibleSideRows, 0);
    checks.push({ name: 'side-row-hidden', passed: true });
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(mainId)}, 'DEMO-LATE-CONTEXT')`);
    const refresh = await cdp.js(`window.__SIDE_ACCEPTANCE__.sideFlag(${JSON.stringify(mainId)}, '--refresh', ${JSON.stringify(sideId)})`);
    assert.equal(refresh.ok, true);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(sideId)}, 'DEMO-REFRESHED-QUESTION')`);
    const refreshed = fs.readFileSync(f.env.DSH_FAKE_LLM_LOG, 'utf8').trim().split('\n').map(JSON.parse)
      .findLast(r => JSON.stringify(r.messages).includes('DEMO-REFRESHED-QUESTION'));
    assert.equal(refreshed.messages.filter(m => m.source?.kind === 'session-reference').length, 1);
    assert.ok(JSON.stringify(refreshed.messages).includes('DEMO-LATE-CONTEXT'));
    checks.push({ name: 'script-install-refresh-replaces-snapshot', passed: true });
    if (process.env.SIDE_TEST_SHOT) {
      const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.SIDE_TEST_SHOT, Buffer.from(shot.data, 'base64'));
    }
    await cdp.js(`window.__SIDE_ACCEPTANCE__.close(${JSON.stringify(mainId)})`);
    await cdp.until("!document.querySelector('[data-side-chat-pane]')", 'close unmount');
    for (let i = 0; i < 60; i++) {
      const roots = fs.existsSync(path.join(f.home, 'sessions')) ? fs.readdirSync(path.join(f.home, 'sessions')) : [];
      if (!roots.some(bucket => fs.existsSync(path.join(f.home, 'sessions', bucket, sideId)))) break;
      await sleep(100);
    }
    const buckets = fs.readdirSync(path.join(f.home, 'sessions'));
    assert.equal(buckets.some(b => fs.existsSync(path.join(f.home, 'sessions', b, sideId))), false);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.side(${JSON.stringify(mainId)})`);
    await cdp.until("Boolean(document.querySelector('[data-side-chat-pane] [data-side-empty]'))", 'new blank side');
    const nextId = await cdp.js(`window.__SIDE_ACCEPTANCE__.binding(${JSON.stringify(mainId)})`);
    assert.notEqual(nextId, sideId);
    assert.equal(await cdp.js("document.querySelector('[data-side-chat-pane]').innerText.includes('DEMO-FIRST')"), false);
    checks.push({ name: 'ui-close-deletes-new-id-empty', passed: true });
    assert.equal(cdp.errors.length, 0);
    checks.push({ name: 'no-console-errors', passed: true });
    console.log(JSON.stringify({ passed: true, checks, provider: 'offline-fixture', browser: 'local-edge', navigation: 'real-client-services' }, null, 2));
  });
}
if (require.main === module) main().catch(error => { console.error(String(error.message).replace(/\/(?:Users|private|var)\/[^\s\n)]+/g, '<local-path>')); process.exitCode = 1; });
module.exports = { main };
