'use strict';
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { spawnOwned } = require('./process-tools.cjs');
const { downloadToFile, confirmUpdate } = require('../tools/updater.cjs');
const url = 'https://github.com/example-owner/side-chat/releases/download/v1.0.3/fixture.zip';
const base = { repository: 'example-owner/side-chat', maxBytes: 1024 * 1024 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function temp() { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'side-lifecycle-')); return { file: path.join(home, 'fixture.zip'), cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }; }
test('streamed download writes exact bytes and hash with private permissions', async () => {
  const f = temp(), data = Buffer.alloc(512 * 1024, 42);
  try { const r = await downloadToFile(url, f.file, { ...base, fetchImpl: async () => new Response(data) }); assert.equal(r.bytes, data.length); assert.equal(r.sha256, crypto.createHash('sha256').update(data).digest('hex')); assert.deepEqual(fs.readFileSync(f.file), data); assert.equal(fs.statSync(f.file).mode & 0o777, 0o600); } finally { f.cleanup(); }
});
test('oversized stream cancels source and removes partial file', async () => {
  const f = temp(); let cancelled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(16384)); }, cancel() { cancelled = true; } });
  try { await assert.rejects(downloadToFile(url, f.file, { ...base, maxBytes: 32768, fetchImpl: async () => new Response(stream) }), e => e.updateCode === 'SIZE'); assert.equal(fs.existsSync(f.file), false); assert.equal(cancelled, true); } finally { f.cleanup(); }
});
test('aborted download releases source and partial file', async () => {
  const f = temp(), control = new AbortController(); let cancelled = false;
  const stream = new ReadableStream({ async pull(c) { await sleep(10); if (!control.signal.aborted) c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
  const timer = setTimeout(() => control.abort(), 35);
  try { await assert.rejects(downloadToFile(url, f.file, { ...base, signal: control.signal, fetchImpl: async () => new Response(stream) })); assert.equal(fs.existsSync(f.file), false); assert.equal(cancelled, true); } finally { clearTimeout(timer); f.cleanup(); }
});
test('download cannot overwrite a pre-existing destination', async () => {
  const f = temp(); fs.writeFileSync(f.file, 'preserve');
  try { await assert.rejects(downloadToFile(url, f.file, { ...base, fetchImpl: async () => new Response('synthetic') }), e => e.updateCode === 'DOWNLOAD_IO'); assert.equal(fs.readFileSync(f.file, 'utf8'), 'preserve'); } finally { f.cleanup(); }
});
for (const [answer, expected] of [['更新\n', true], ['\n', false], ['yes\n', false]]) test(`confirmation accepts only explicit phrase: ${expected ? 'yes' : answer.trim() || 'empty'}`, async () => {
  const input = new PassThrough(), output = new PassThrough(); const p = confirmUpdate({ input, output, timeoutMs: 500 }); input.write(answer); assert.equal(await p, expected); assert.equal(input.listenerCount('data'), 0); input.destroy(); output.destroy();
});
test('confirmation timeout and EOF cancel rather than installing', async () => {
  for (const eof of [false, true]) { const input = new PassThrough(), output = new PassThrough(); const keepAlive = setInterval(() => {}, 1000); try { const p = confirmUpdate({ input, output, timeoutMs: 25 }); if (eof) input.end(); assert.equal(await p, false); assert.equal(input.listenerCount('data'), 0); } finally { clearInterval(keepAlive); input.destroy(); output.destroy(); } }
});
test('owned process cleanup is idempotent and removes parent signal listeners', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const child = spawnOwned(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await child.stop(300); await child.stop(300); assert.equal(child.isClosed, true); assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});
test('owned process ignoring graceful shutdown is force-stopped', async () => {
  const child = spawnOwned(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(resolve => child.child.stdout.once('data', resolve)); await child.stop(60); assert.equal((await child.closed).signal, 'SIGKILL');
});
test('spawn failure closes and removes signal listeners', async () => {
  const before = process.listenerCount('SIGTERM'); const child = spawnOwned('/nonexistent-side-fixture', [], { stdio: 'ignore' });
  assert.equal((await child.closed).spawnError, 'ENOENT'); await child.stop(); assert.equal(process.listenerCount('SIGTERM'), before);
});
test('owned descendants stop together with their disposable parent', async () => {
  const code = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
  const child = spawnOwned(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = await new Promise(resolve => child.child.stdout.once('data', b => resolve(Number(String(b).trim()))));
  await child.stop(300); await sleep(50); assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('application probes have bounds and ambiguous runtime state refuses changes', () => {
  const vm = require('node:vm'), moduleFile = path.join(__dirname, '../tools/installer.cjs'), calls = [];
  let reply = { status: 0, stdout: 'false' };
  const context = { module: { exports: {} }, exports: {}, __dirname: path.dirname(moduleFile), __filename: moduleFile, process,
    require(name) { if (name === 'node:child_process') return { spawnSync(_file, _args, options) { calls.push(options); return reply; } }; return require(name); } };
  vm.runInNewContext(fs.readFileSync(moduleFile, 'utf8'), context);
  const engine = context.module.exports;
  assert.equal(engine.running(), false); assert.ok(calls[0].timeout <= 10000); assert.ok(calls[0].maxBuffer <= 65536);
  reply = { status: 0, stdout: '' }; assert.throws(() => engine.running());
  reply = { status: null, error: { code: 'ETIMEDOUT' } }; assert.throws(() => engine.running());
});
