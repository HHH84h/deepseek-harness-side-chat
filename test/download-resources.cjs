'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
async function sample(moduleFile, streaming) {
  const u = require(moduleFile), home = fs.mkdtempSync(path.join(os.tmpdir(), 'side-download-probe-'));
  const total = 16 * 1024 * 1024, chunkSize = 64 * 1024;
  global.gc?.(); const start = process.memoryUsage(); let peak = { ...start }, sent = 0;
  function record() { const m = process.memoryUsage(); for (const key of ['rss', 'arrayBuffers', 'external']) peak[key] = Math.max(peak[key], m[key]); }
  const body = new ReadableStream({ async pull(c) { await new Promise(resolve => setImmediate(resolve)); if (sent === total) { c.close(); return; } c.enqueue(Buffer.alloc(chunkSize, 42)); sent += chunkSize; record(); } }, { highWaterMark: 0 });
  const options = { repository: 'example-owner/side-chat', maxBytes: total, fetchImpl: async () => new Response(body) };
  try {
    const at = performance.now();
    const result = streaming ? await u.downloadToFile('https://github.com/example-owner/side-chat/releases/download/v1.0.3/fixture.zip', path.join(home, 'fixture.zip'), options) : await u.getBuffer('https://github.com/example-owner/side-chat/releases/download/v1.0.3/fixture.zip', options);
    record(); const bytes = streaming ? result.bytes : result.length;
    return { bytes, elapsedMs: Math.round(performance.now() - at), peakGrowthBytes: Object.fromEntries(['rss', 'arrayBuffers', 'external'].map(key => [key, peak[key] - start[key]])), method: streaming ? 'file-stream-sha256' : 'chunks-plus-concat' };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
module.exports = { sample };
if (require.main === module) sample(path.resolve(process.argv[2]), process.argv[3] === 'stream').then(r => console.log(JSON.stringify(r))).catch(() => { console.error('Synthetic download probe failed.'); process.exitCode = 1; });
