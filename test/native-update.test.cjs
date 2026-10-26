'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../plugin/lib/update.js');
const source = { schema: 1, enabled: true, repository: 'example/side-chat-demo' };
const runtime = async () => '0.2.1-rc.3';
function fixture({ next = '1.2.0', supported = ['0.2.1-rc.3'], mutate } = {}) {
  const base = `https://github.com/${source.repository}/releases/download/v${next}/`;
  const artifact = `dsh-client-ui-side-${next}.tgz`;
  const release = { tag_name: `v${next}`, draft: false, prerelease: false, assets: ['side-chat-plugin-update.json', artifact].map(name => ({ name, browser_download_url: base + name })) };
  const feed = { schema: 1, product: 'deepseek-harness-side-chat', packageName: 'dsh-client-ui-side', format: 'harness-bundle', platform: 'darwin', version: next, supportedHarness: supported, artifact: { name: artifact, sha256: 'a'.repeat(64), bytes: 100 } };
  mutate?.(feed, release);
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return Response.json(url.startsWith('https://api.github.com/') ? [release] : feed); };
  return { fetchImpl, requests };
}
test('native update disabled performs zero network requests', async () => {
  const { createUpdateChecker } = await load(); let calls = 0;
  const c = createUpdateChecker({ source: { schema: 1, enabled: false, repository: null }, fetchImpl: () => { calls++; throw Error(); } });
  assert.deepEqual(await c.check(), { status: 'disabled', version: '1.1.2' }); assert.equal(calls, 0); await c.dispose();
});
test('native compatible update returns only public package metadata', async () => {
  const { createUpdateChecker } = await load(), f = fixture(); const c = createUpdateChecker({ source, runtime, ...f });
  const r = await c.check(); assert.equal(r.status, 'available'); assert.equal(r.latest, '1.2.0'); assert.match(r.downloadUrl, /\.tgz$/);
  assert.deepEqual(Object.keys(r).sort(), ['status','version','harness','latest','downloadUrl','sha256','bytes'].sort());
  assert.equal(f.requests.length, 2); for (const { options } of f.requests) { assert.equal(options.credentials, 'omit'); assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, undefined); assert.equal(options.body, undefined); } await c.dispose();
});
for (const [name, config, status] of [['latest', { next: '1.1.2' }, 'up-to-date'], ['unsupported', { supported: ['9.0.0'] }, 'no-compatible']]) test(`native update ${name}`, async () => {
  const { createUpdateChecker } = await load(); const c = createUpdateChecker({ source, runtime, ...fixture(config) }); assert.equal((await c.check()).status, status); await c.dispose();
});
for (const [name, mutate] of [
  ['wrong format', f => { f.format = 'zip-installer'; }],
  ['bad checksum', f => { f.artifact.sha256 = 'invalid'; }],
  ['foreign asset', (f, r) => { r.assets[1].browser_download_url = 'https://invalid.example/plugin.tgz'; }],
  ['too large artifact', f => { f.artifact.bytes = 17 * 1024 * 1024; }],
]) test(`native update rejects ${name}`, async () => {
  const { createUpdateChecker } = await load(); const c = createUpdateChecker({ source, runtime, ...fixture({ mutate }) }); assert.equal((await c.check()).code, 'INVALID_RESPONSE'); await c.dispose();
});
test('native update shares concurrent checks', async () => {
  const { createUpdateChecker } = await load(), f = fixture(); let release;
  const barrier = new Promise(r => { release = r; });
  const c = createUpdateChecker({ source, runtime, fetchImpl: async (...args) => { await barrier; return f.fetchImpl(...args); } });
  const a = c.check(), b = c.check(); assert.equal(a, b); release(); assert.equal((await a).status, 'available'); assert.equal(f.requests.length, 2); await c.dispose();
});
test('native update timeout and disposal abort fetch and settle', async () => {
  const { createUpdateChecker } = await load();
  for (const dispose of [false, true]) {
    let started; const ready = new Promise(r => { started = r; });
    const c = createUpdateChecker({ source, runtime, timeoutMs: dispose ? 5000 : 20, fetchImpl: async (_url, { signal }) => { started(); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); }); } });
    const keepAlive = setTimeout(() => {}, 1000); const p = c.check(); await ready; if (dispose) await c.dispose();
    const result = await p; clearTimeout(keepAlive); assert.equal(result.status, dispose ? 'cancelled' : 'error'); assert.equal(result.code, dispose ? 'CANCELLED' : 'TIMEOUT'); await c.dispose();
  }
});
test('native update reports network and rate limit separately', async () => {
  const { createUpdateChecker } = await load();
  for (const [fetchImpl, code] of [[async () => { throw Error('offline'); }, 'NETWORK'], [async () => new Response('', { status: 429 }), 'RATE_LIMIT']]) {
    const c = createUpdateChecker({ source, runtime, fetchImpl }); assert.equal((await c.check()).code, code); await c.dispose();
  }
});
test('native update bounds body and redirect targets', async () => {
  const { createUpdateChecker } = await load();
  for (const fetchImpl of [async () => new Response('x'.repeat(1024 * 1024 + 1)), async () => new Response('', { status: 302, headers: { location: 'http://invalid.example/' } }), async () => new Response('{')]) {
    const c = createUpdateChecker({ source, runtime, fetchImpl }); assert.equal((await c.check()).code, 'INVALID_RESPONSE'); await c.dispose();
  }
});

test('malformed optional update source does not crash plugin startup', async () => {
  const { createUpdateChecker } = await load();
  for (const source of [null, {}, { schema: 1, enabled: true, repository: 'https://invalid.example/' }]) {
    let calls = 0; const checker = createUpdateChecker({ source, fetchImpl: () => { calls++; throw Error(); } });
    assert.equal((await checker.check()).code, 'SOURCE'); assert.equal(calls, 0); await checker.dispose();
  }
});
