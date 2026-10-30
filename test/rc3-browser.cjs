'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { withBrowser } = require('./browser-session.cjs');

async function main() {
  if (!process.env.SIDE_NATIVE_PACKAGE && !process.env.SIDE_COMMAND_ROOT) throw new Error('Set SIDE_NATIVE_PACKAGE or SIDE_COMMAND_ROOT.');
  return withBrowser(async ({ f, cdp }) => {
    const checks = [];
    const mainId = await cdp.js(`window.__SIDE_ACCEPTANCE__.create(${JSON.stringify(f.cwd)})`);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(mainId)}, 'RC3-MAIN-CONTEXT')`);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.side(${JSON.stringify(mainId)})`);
    await cdp.until("Boolean(document.querySelector('[data-side-chat-pane] [data-composer-input][contenteditable=true]'))", 'editable blank side');
    const sideId = await cdp.js(`window.__SIDE_ACCEPTANCE__.binding(${JSON.stringify(mainId)})`);
    const geometry = () => cdp.js(`(() => {
      const p = document.querySelector('[data-side-chat-pane]');
      const c = p.querySelector('[data-composer-card]');
      const a = p.getBoundingClientRect(), b = c.getBoundingClientRect();
      return { bottomGap: a.bottom - b.bottom, paneHeight: a.height,
        composerTop: b.top - a.top, overflow: p.scrollWidth > p.clientWidth + 1 };
    })()`);
    let layout = await geometry();
    assert.ok(layout.composerTop > layout.paneHeight / 2);
    assert.ok(layout.bottomGap >= -1 && layout.bottomGap < 70);
    checks.push({ name: 'blank-side-composer-at-bottom', passed: true });

    async function submit(text) {
      await cdp.js("document.querySelector('[data-side-chat-pane] [data-composer-input]').focus()");
      await cdp.call('Input.insertText', { text });
      await cdp.until(`document.querySelector('[data-side-chat-pane] [data-composer-input]')?.innerText.includes(${JSON.stringify(text)})`, 'draft reflects real input');
      const button = await cdp.js(`(() => {
        const b = Array.from(document.querySelectorAll('[data-side-chat-pane] [data-composer-card] button'))
          .find(el => /发送|Send message/i.test(el.getAttribute('aria-label') ?? '') && !el.disabled);
        if (!b) return null;
        const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      assert.ok(button, 'real composer send button must be enabled');
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...button });
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...button });
      await cdp.until(`document.querySelector('[data-side-chat-pane]')?.innerText.includes(${JSON.stringify(text)}) && document.querySelector('[data-side-chat-pane] [data-composer-input]')?.innerText.trim() === ''`, 'submitted draft clears');
      await cdp.until(`Array.from(document.querySelectorAll('[data-side-chat-pane] [data-chat-turn]')).some(el => el.innerText.includes('FAKE-REPLY'))`, 'reply rendered');
    }
    await submit('RC3-EDITOR-FIRST');
    await cdp.until("document.querySelector('[data-side-chat-pane]')?.innerText.includes('178')", 'first usage');
    await submit('RC3-EDITOR-SECOND');
    await cdp.until("document.querySelector('[data-side-chat-pane]')?.innerText.includes('356')", 'second usage');
    const requests = () => fs.readFileSync(f.env.DSH_FAKE_LLM_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    const second = requests().findLast(r => JSON.stringify(r.messages).includes('RC3-EDITOR-SECOND'));
    assert.ok(second);
    assert.equal(second.messages.filter(m => m.source?.kind === 'session-reference').length, 1);
    for (const marker of ['RC3-EDITOR-FIRST', 'RC3-EDITOR-SECOND']) {
      assert.equal(second.messages.filter(m => JSON.stringify(m).includes(marker)).length, 1);
    }
    assert.ok(JSON.stringify(second.messages).includes('RC3-MAIN-CONTEXT'));
    checks.push({ name: 'real-editor-two-sends-visible-once-and-one-snapshot', passed: true });
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(mainId)}, 'RC3-MAIN-AFTER')`);
    const after = requests().findLast(r => JSON.stringify(r.messages).includes('RC3-MAIN-AFTER'));
    assert.ok(after);
    assert.equal(JSON.stringify(after.messages).includes('RC3-EDITOR-FIRST'), false);
    checks.push({ name: 'main-request-excludes-side-input', passed: true });

    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
    await new Promise(resolve => setTimeout(resolve, 250));
    layout = await geometry();
    assert.equal(layout.overflow, false);
    assert.ok(layout.bottomGap >= -1 && layout.bottomGap < 70);
    checks.push({ name: 'narrow-side-layout-and-statistics', passed: true });
    assert.equal(cdp.errors.length, 0);
    checks.push({ name: 'real-editor-no-console-errors', passed: true });
    await cdp.js(`window.__SIDE_ACCEPTANCE__.close(${JSON.stringify(mainId)})`);
    await cdp.until(`!window.__SIDE_ACCEPTANCE__.binding(${JSON.stringify(mainId)})`, 'side cleanup');
    console.log(JSON.stringify({ passed: true, runtime: '0.2.1-rc.5', provider: 'fake', checks }, null, 2));
  });
}
if (require.main === module) main().catch(error => { console.error(String(error.message).replace(/\/(?:Users|private|var)\/[^\s\n)]+/g, '<local-path>')); process.exitCode = 1; });
module.exports = { main };
