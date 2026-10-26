'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { withBrowser, sleep } = require('./browser-session.cjs');
async function measure(options = {}) {
  return withBrowser(async ({ f, cdp, server }) => {
    await cdp.call('Performance.enable'); await cdp.call('HeapProfiler.enable');
    const mainId = await cdp.js(`window.__SIDE_ACCEPTANCE__.create(${JSON.stringify(f.cwd)})`);
    await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(mainId)}, 'RESOURCE-PROBE: synthetic fixture')`);
    async function cycle(first = false) {
      await cdp.js(`window.__SIDE_ACCEPTANCE__.side(${JSON.stringify(mainId)})`);
      await cdp.until("Boolean(document.querySelector('[data-side-chat-pane]'))", 'probe pane');
      const id = await cdp.js(`window.__SIDE_ACCEPTANCE__.binding(${JSON.stringify(mainId)})`);
      if (first) await cdp.js(`window.__SIDE_ACCEPTANCE__.send(${JSON.stringify(id)}, 'RESOURCE-WARMUP')`);
      await cdp.js(`window.__SIDE_ACCEPTANCE__.close(${JSON.stringify(mainId)})`);
      await cdp.until("!document.querySelector('[data-side-chat-pane]')", 'probe close');
      const root = path.join(f.home, 'sessions'); let gone = false;
      for (let i = 0; i < 100; i++) {
        const buckets = fs.existsSync(root) ? fs.readdirSync(root) : [];
        if (!buckets.some(b => fs.existsSync(path.join(root, b, id)))) { gone = true; break; }
        await sleep(50);
      }
      if (!gone) throw new Error('probe side storage was not removed');
      await sleep(100);
    }
    async function sample(cycles) {
      await cdp.call('HeapProfiler.collectGarbage'); await cdp.call('HeapProfiler.collectGarbage'); await sleep(50);
      const metrics = Object.fromEntries((await cdp.call('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
      const dom = await cdp.call('Memory.getDOMCounters');
      const attachedElements = await cdp.js("document.querySelectorAll('*').length");
      const attachedNodes = await cdp.js("(()=>{const w=document.createTreeWalker(document,NodeFilter.SHOW_ALL);let n=1;while(w.nextNode())n++;return n})()");
      const rssKiB = Number(cp.execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(server.child.pid)], { encoding: 'utf8' }).trim());
      return { cycles, jsHeapBytes: Math.round(metrics.JSHeapUsedSize), domNodes: dom.nodes, listeners: dom.jsEventListeners, attachedElements, attachedNodes, hostRssKiB: rssKiB };
    }
    await cycle(true); await cycle(false);
    const samples = [await sample(0)], times = [];
    for (let i = 1; i <= (options.cycles ?? 20); i++) {
      const start = performance.now(); await cycle(); times.push(performance.now() - start);
      if (i % 5 === 0) samples.push(await sample(i));
    }
    if (cdp.errors.length) throw new Error('probe console error');
    const sorted = [...times].sort((a, b) => a - b), a = samples[0], b = samples.at(-1);
    return { passed: true, samples, latencyMs: { median: Math.round(sorted[Math.floor(sorted.length / 2)]), max: Math.round(Math.max(...times)) }, delta: { heapBytes: b.jsHeapBytes - a.jsHeapBytes, domNodes: b.domNodes - a.domNodes, listeners: b.listeners - a.listeners, attachedElements: b.attachedElements - a.attachedElements, attachedNodes: b.attachedNodes - a.attachedNodes }, note: 'Main command history also grows; total DOM growth is not automatically a leak.' };
  }, options);
}
module.exports = { measure };
if (require.main === module) {
  const at = process.argv.indexOf('--bundle-root');
  measure({ bundleRoot: at < 0 ? undefined : path.resolve(process.argv[at + 1]) }).then(r => console.log(JSON.stringify(r, null, 2))).catch(() => { console.error('Isolated resource probe failed; raw logs not printed.'); process.exitCode = 1; });
}
