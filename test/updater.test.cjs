'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const crypto = require('node:crypto');
const u = require('../tools/updater.cjs');
const engine = require('../tools/installer.cjs');
const ROOT = path.resolve(__dirname, '..');
const REPOSITORY = 'example-owner/side-chat';
const HARNESS = '0.2.1-rc.5';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let fixtureHome, future, otherHarness;
function source(root, enabled = true) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'update-source.json'), JSON.stringify({ schema: 1, enabled, repository: enabled ? REPOSITORY : null, channel: 'stable', autoCheck: true }));
}
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'side-update-中文 测试-')), root = path.join(home, 'bundle'); source(root);
  const profileDir = path.join(home, 'profiles/desktop'); fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert:\n    - id: sibling\n      name: preserve-me\n');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'fixture-profile', private: true }));
  return { root, home, profileDir, profile: 'desktop', app: '/Applications/Fixture.app', cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
function makeRelease(version, harness = HARNESS, bytes = future.bytes) {
  const manifest = { schema: 1, product: u.PRODUCT, version, platform: 'darwin', installerApi: 1, supportedHarness: [harness], artifact: { name: `${u.PRODUCT}-macos-v${version}.zip`, sha256: sha(bytes), bytes: bytes.length } };
  const base = `https://github.com/${REPOSITORY}/releases/download/v${version}/`;
  const release = { tag_name: `v${version}`, draft: false, prerelease: false, body: 'Synthetic release notes', assets: [
    { name: u.FEED, browser_download_url: base + u.FEED },
    { name: manifest.artifact.name, browser_download_url: base + manifest.artifact.name, size: bytes.length, digest: `sha256:${sha(bytes)}` },
  ] };
  return { manifest, release, bytes };
}
function network(entries, options = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (options.error) throw new Error('network unavailable');
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(entries.map(e => e.release)), { status: options.status ?? 200 });
    const item = entries.find(e => e.release.assets.some(a => a.browser_download_url === url));
    if (!item) throw new Error('unexpected fixture URL');
    return new Response(url.endsWith('/' + u.FEED) ? JSON.stringify(item.manifest) : item.bytes);
  } };
}
function appInfo(_app, options) { assert.equal(options.strict, false); return { version: HARNESS }; }
async function candidate(f, entry = makeRelease('1.2.0'), info = appInfo) {
  const net = network([entry]); return { value: await u.check(f, { ...net, appInfo: info }), net };
}
function futureZip(parent, harness) {
  const stage = path.join(parent, `${u.PRODUCT}-macos-v1.2.0`); fs.mkdirSync(stage, { recursive: true });
  for (const name of require('../scripts/build.cjs').RELEASE) fs.cpSync(path.join(ROOT, name), path.join(stage, name), { recursive: true });
  const pkgFile = path.join(stage, 'plugin/package.json'), pkg = JSON.parse(fs.readFileSync(pkgFile)); pkg.version = '1.2.0'; fs.writeFileSync(pkgFile, JSON.stringify(pkg));
  const toolFile = path.join(stage, 'tools/installer.cjs'); fs.writeFileSync(toolFile, fs.readFileSync(toolFile, 'utf8').replace("const VERSION = '1.1.3'", "const VERSION = '1.2.0'").replace(`const SUPPORTED = '${HARNESS}'`, `const SUPPORTED = '${harness}'`));
  fs.writeFileSync(path.join(stage, 'release-manifest.json'), JSON.stringify({ version: '1.2.0', supportedHarness: harness, files: Object.fromEntries(engine.FILES.map(f => [`plugin/${f}`, sha(fs.readFileSync(path.join(stage, 'plugin', f)))])) }));
  const zip = path.join(parent, 'fixture.zip');
  assert.equal(cp.spawnSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', stage, zip]).status, 0);
  return { bytes: fs.readFileSync(zip), harness };
}
before(() => {
  fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'side-future-release-'));
  future = futureZip(path.join(fixtureHome, 'same'), HARNESS);
  otherHarness = futureZip(path.join(fixtureHome, 'next'), '0.3.0');
});
after(() => fs.rmSync(fixtureHome, { recursive: true, force: true }));
test('version comparison is numeric and stable-only', () => {
  assert.equal(u.compare('1.10.0', '1.9.9'), 1); assert.equal(u.compare('1.0.1', '1.0.1'), 0);
  for (const v of ['1.0', '01.0.0', '1.0.0-beta', 'v1.0.0', '99999999999999999999.0.0']) assert.throws(() => u.compare(v, '1.0.0'));
});
test('there is no noninteractive yes flag and default home is .dsh', () => {
  assert.throws(() => u.parseOptions(['--yes']));
  assert.equal(u.parseOptions([]).home, path.join(os.homedir(), '.dsh'));
});
function entryFixture({ available = false, checkFailure = false, installFailure = false, optedOut = false } = {}) {
  const calls = { checks: 0, confirmations: 0, local: 0, sources: 0 }, mod = { exports: {} };
  const updater = { parseOptions: args => ({ dryRun: args.includes('--dry-run') }), readSource() { calls.sources++; return {}; }, autoAllowed: () => !optedOut, async check() { calls.checks++; if (checkFailure) throw new Error('offline'); return { status: available ? 'available' : 'up-to-date' }; }, show() {}, message: () => 'check unavailable', async interactive() { calls.confirmations++; if (installFailure) throw new Error('update-failed'); return false; } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'tools/entry.cjs'), 'utf8'), { module: mod, require: name => name === './updater.cjs' ? updater : { cli() { calls.local++; } }, process, console: { log() {} } });
  return { calls, main: mod.exports.main };
}
test('automatic check offers confirmation, decline does not install local bundle', async () => {
  const f = entryFixture({ available: true }); await f.main(['install']); assert.equal(f.calls.checks, 1); assert.equal(f.calls.confirmations, 1); assert.equal(f.calls.local, 0);
});
test('confirmed-update failure never falls through to an older local install', async () => {
  const f = entryFixture({ available: true, installFailure: true }); await assert.rejects(f.main(['install'])); assert.equal(f.calls.local, 0);
});
test('offline checking does not prevent ordinary local install', async () => {
  const f = entryFixture({ checkFailure: true }); await f.main(['install']); assert.equal(f.calls.local, 1);
});
test('rollback, uninstall, dry-run and opt-out never check online', async () => {
  for (const args of [['rollback'], ['uninstall'], ['install', '--dry-run']]) { const f = entryFixture(); await f.main(args); assert.equal(f.calls.checks, 0); assert.equal(f.calls.sources, 0); assert.equal(f.calls.local, 1); }
  const f = entryFixture({ optedOut: true }); await f.main(['install']); assert.equal(f.calls.checks, 0); assert.equal(f.calls.local, 1);
});
test('unconfigured source makes zero requests and zero profile writes', async () => {
  const f = fixture(); try { source(f.root, false); let calls = 0; const before = fs.readdirSync(f.profileDir); assert.deepEqual(await u.check(f, { fetchImpl() { calls++; throw new Error(); } }), { status: 'disabled' }); assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(f.profileDir), before); } finally { f.cleanup(); }
});
test('dry-run makes zero requests', async () => {
  const f = fixture(); try { let calls = 0; assert.equal((await u.check({ ...f, dryRun: true }, { fetchImpl() { calls++; } })).status, 'dry-run'); assert.equal(calls, 0); } finally { f.cleanup(); }
});
test('source rejects arbitrary URLs and embedded credentials', () => {
  const f = fixture(); try { for (const repository of ['https://example.invalid/repo', '../outside', 'owner/repo?x=1', 'user:secret@host/repo']) { fs.writeFileSync(path.join(f.root, 'update-source.json'), JSON.stringify({ schema: 1, enabled: true, repository, autoCheck: true, channel: 'stable' })); assert.throws(() => u.readSource(f.root)); } } finally { f.cleanup(); }
});
test('select latest compatible release instead of incompatible latest', async () => {
  const f = fixture(); try { const net = network([makeRelease('2.0.0', '0.3.0'), makeRelease('1.2.0')]); const r = await u.check(f, { ...net, appInfo }); assert.equal(r.manifest.version, '1.2.0'); } finally { f.cleanup(); }
});
test('can discover a compatible update after Harness itself changes version', async () => {
  const f = fixture(); try { const r = await candidate(f, makeRelease('1.2.0', '0.3.0', otherHarness.bytes), () => ({ version: '0.3.0' })); assert.equal(r.value.status, 'available'); assert.equal(r.value.harness, '0.3.0'); } finally { f.cleanup(); }
});
test('no compatible release is a clear non-installing result', async () => {
  const f = fixture(); try { const net = network([makeRelease('1.2.0')]); const r = await u.check(f, { ...net, appInfo: () => ({ version: '0.3.0' }) }); assert.equal(r.status, 'no-compatible'); assert.equal(fs.existsSync(path.join(f.profileDir, '.side-chat-installer')), false); } finally { f.cleanup(); }
});
test('drafts and prereleases ignored, installed version prevents downgrade', async () => {
  const f = fixture(); try {
    const installed = path.join(f.profileDir, 'plugins', engine.ID); fs.mkdirSync(installed, { recursive: true }); fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: engine.ID, version: '5.0.0' }));
    const draft = makeRelease('9.0.0'); draft.release.draft = true; const beta = makeRelease('8.0.0'); beta.release.prerelease = true;
    const net = network([draft, beta, makeRelease('1.2.0')]); assert.equal((await u.check(f, { ...net, appInfo })).status, 'up-to-date'); assert.equal(net.calls.length, 1);
  } finally { f.cleanup(); }
});
test('requests contain no account token, local version, paths or request body', async () => {
  const f = fixture(), old = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = ['private', 'fixture', 'value'].join('-');
  try { const { net } = await candidate(f); const serialized = JSON.stringify(net.calls); assert.equal(serialized.includes(process.env.GITHUB_TOKEN), false); assert.equal(serialized.includes(f.home), false); for (const { url, init } of net.calls) { assert.equal(new URL(url).hostname === 'api.github.com' || new URL(url).hostname === 'github.com', true); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.headers.Authorization, undefined); assert.equal(init.credentials, 'omit'); } } finally { if (old === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = old; f.cleanup(); }
});
test('explicit opt-out and corrupt preferences suppress auto checks', () => {
  const f = fixture(); try { const s = u.readSource(f.root); assert.equal(u.autoAllowed(f, s), true); u.setPreference({ ...f, autoCheck: false }); assert.equal(u.autoAllowed(f, s), false); u.setPreference({ ...f, autoCheck: true }); assert.equal(u.autoAllowed(f, s), true); fs.writeFileSync(path.join(f.profileDir, '.side-chat-installer/update-preferences.json'), '{bad'); assert.equal(u.autoAllowed(f, s), false); } finally { f.cleanup(); }
});
test('network failure and rate limit are redacted', async () => {
  const f = fixture(); try {
    for (const flags of [{ error: true }, { status: 403 }]) { const net = network([], flags); await assert.rejects(u.check(f, { ...net, appInfo }), error => { assert.equal(u.message(error).includes('fixture'), false); return ['NETWORK', 'RATE_LIMIT'].includes(error.updateCode); }); }
  } finally { f.cleanup(); }
});
test('malformed feed, mismatched tag/digest and foreign asset rejected', async () => {
  const f = fixture(); try {
    for (const mutate of [e => { e.manifest.product = 'other'; }, e => { e.manifest.version = '3.0.0'; }, e => { e.release.assets[1].digest = 'sha256:' + '0'.repeat(64); }, e => { e.release.assets[0].browser_download_url = 'https://example.invalid/file'; }]) {
      const e = makeRelease('1.2.0'); mutate(e); await assert.rejects(u.check(f, { ...network([e]), appInfo }));
    }
  } finally { f.cleanup(); }
});
test('foreign, plaintext and credential redirects rejected before following', async () => {
  for (const location of ['http://github.com/file', 'https://example.invalid/file', 'https://' + ['user:password', 'objects.githubusercontent.com'].join('@') + '/file', `https://github.com/other/repo/releases/download/v1/file`]) {
    let calls = 0;
    await assert.rejects(u.getBuffer(`https://github.com/${REPOSITORY}/releases/download/v1/file`, { repository: REPOSITORY, maxBytes: 10, fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } }));
    assert.equal(calls, 1);
  }
});
test('official CDN redirects accepted with anonymous headers', async () => {
  let calls = 0;
  const r = await u.getBuffer(`https://github.com/${REPOSITORY}/releases/download/v1/file`, { repository: REPOSITORY, maxBytes: 10, fetchImpl: async (_url, init) => { assert.equal(init.headers.Authorization, undefined); return ++calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } }) : new Response('ok'); } });
  assert.equal(r.toString(), 'ok'); assert.equal(calls, 2);
});
test('oversized declared and streamed responses rejected', async () => {
  for (const response of [new Response('x', { headers: { 'content-length': '999' } }), new Response('x'.repeat(11))]) await assert.rejects(u.getBuffer(`https://github.com/${REPOSITORY}/releases/download/v1/file`, { repository: REPOSITORY, maxBytes: 10, fetchImpl: async () => response }), e => e.updateCode === 'SIZE');
});
test('no confirmation means zero download and no writes', async () => {
  const f = fixture(); try { const { value, net } = await candidate(f); const before = net.calls.length; await assert.rejects(u.applyUpdate(value, f, { ...net, appInfo, running: () => false }), e => e.updateCode === 'CONFIRMATION'); assert.equal(net.calls.length, before); assert.equal(fs.existsSync(path.join(f.profileDir, '.side-chat-installer')), false); } finally { f.cleanup(); }
});
test('running app refuses update without download or termination', async () => {
  const f = fixture(); try { const { value, net } = await candidate(f); const before = net.calls.length; await assert.rejects(u.applyUpdate(value, f, { ...net, confirmed: true, appInfo, running: () => true }), e => e.updateCode === 'RUNNING'); assert.equal(net.calls.length, before); } finally { f.cleanup(); }
});
test('Harness change while confirming refuses stale candidate', async () => {
  const f = fixture(); try { const { value, net } = await candidate(f); await assert.rejects(u.applyUpdate(value, f, { ...net, confirmed: true, appInfo: () => ({ version: '0.3.0' }), running: () => false }), e => e.updateCode === 'COMPATIBILITY'); } finally { f.cleanup(); }
});
test('app starting during download refuses installation after validation', async () => {
  const f = fixture(); try {
    const { value, net } = await candidate(f); let checks = 0, ran = false;
    await assert.rejects(u.applyUpdate(value, f, { ...net, confirmed: true, appInfo, running: () => ++checks > 1, installRunner() { ran = true; } }), e => e.updateCode === 'RUNNING');
    assert.equal(ran, false); assert.equal(fs.existsSync(path.join(f.profileDir, '.side-chat-installer')), false);
  } finally { f.cleanup(); }
});
test('checksum failure never executes installer', async () => {
  const f = fixture(); try {
    const entry = makeRelease('1.2.0'); const { value } = await candidate(f, entry); let ran = false;
    await assert.rejects(u.applyUpdate(value, f, { confirmed: true, appInfo, running: () => false, fetchImpl: async () => new Response(Buffer.alloc(entry.bytes.length)), installRunner() { ran = true; } }), e => e.updateCode === 'CHECKSUM');
    assert.equal(ran, false); assert.equal(fs.existsSync(path.join(f.profileDir, '.side-chat-installer')), false);
  } finally { f.cleanup(); }
});
test('real archive passes structural checks', () => { assert.ok(u.inspectZip(future.bytes, `${u.PRODUCT}-macos-v1.2.0`).entries > 10); });
function craftedZip(name, { localName = name, mode = 0x8000, extraType, declared = 1 } = {}) {
  const n = Buffer.from(name), l = Buffer.from(localName), content = Buffer.from('x');
  const extra = extraType === undefined ? Buffer.alloc(0) : Buffer.from([extraType & 255, extraType >> 8, 0, 0]);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(0x8cdc1683, 14); local.writeUInt32LE(1, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(l.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(0x8cdc1683, 16); central.writeUInt32LE(1, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(n.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt32LE((mode * 65536) >>> 0, 38);
  const start = local.length + l.length + 1, size = central.length + n.length + extra.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(start, 16);
  return Buffer.concat([local, l, content, central, n, extra, end]);
}
test('archive blocks traversal, absolute names, links, alternate names and bombs', () => {
  const root = `${u.PRODUCT}-macos-v1.2.0`;
  assert.equal(u.inspectZip(craftedZip(`${root}/README.md`), root).entries, 1);
  for (const bytes of [craftedZip(`${root}/../escape`), craftedZip('/absolute'), craftedZip(`${root}/README.md`, { mode: 0xa000 }), craftedZip(`${root}/README.md`, { localName: `${root}/other.txt` }), craftedZip(`${root}/README.md`, { extraType: 0x7075 }), craftedZip(`${root}/README.md`, { declared: 10 * 1024 * 1024 })]) assert.throws(() => u.inspectZip(bytes, root));
});
test('archive accepts the explicit English README but refuses unlisted root files', () => {
  const root = `${u.PRODUCT}-macos-v1.2.0`;
  assert.equal(u.inspectZip(craftedZip(`${root}/README.en.md`), root).entries, 1);
  assert.throws(() => u.inspectZip(craftedZip(`${root}/unexpected.md`), root));
});
test('confirmed update uses real future installer, saves new tools and supports rollback', async () => {
  const f = fixture(); try {
    engine.install({ profile: f.profileDir, root: ROOT });
    const { value, net } = await candidate(f);
    const result = await u.applyUpdate(value, f, { ...net, confirmed: true, appInfo, running: () => false, installRunner(dir, opts) {
      require(path.join(dir, 'tools/installer.cjs')).install({ profile: opts.profileDir, root: dir }); return { status: 0 };
    } });
    assert.equal(u.currentVersion(f), '1.2.0'); assert.ok(fs.existsSync(path.join(result.toolDirectory, '回退上一版.command')));
    const newEngine = require(path.join(result.toolDirectory, 'tools/installer.cjs')); newEngine.rollback({ profile: f.profileDir });
    assert.equal(u.currentVersion(f), engine.VERSION);
    assert.match(fs.readFileSync(path.join(f.profileDir, 'cordis.patch.yml'), 'utf8'), /preserve-me/);
  } finally { f.cleanup(); }
});
test('new Harness version handed to compatible future installer', async () => {
  const f = fixture(); try {
    const info = () => ({ version: '0.3.0' }), entry = makeRelease('1.2.0', '0.3.0', otherHarness.bytes);
    const { value, net } = await candidate(f, entry, info);
    await u.applyUpdate(value, f, { ...net, confirmed: true, appInfo: info, running: () => false, installRunner(dir, opts) { const next = require(path.join(dir, 'tools/installer.cjs')); assert.equal(next.SUPPORTED, '0.3.0'); next.install({ profile: opts.profileDir, root: dir }); return { status: 0 }; } });
    assert.equal(u.currentVersion(f), '1.2.0');
  } finally { f.cleanup(); }
});
test('default worker launches actual future installer CLI with explicit isolated home', async () => {
  const f = fixture(), previous = process.env.NODE_OPTIONS;
  try {
    const app = path.join(f.home, 'Harness Fixture.app'); fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.deepseek.dsh</string><key>CFBundleShortVersionString</key><string>${HARNESS}</string></dict></plist>`);
    const stub = path.join(f.home, 'worker-fixture.cjs');
    fs.writeFileSync(stub, `if (!process.argv.includes(${JSON.stringify(f.home)})) process.exit(90); const cp=require('node:child_process'),original=cp.spawnSync;cp.spawnSync=function(file,...args){if(file==='/usr/bin/osascript')return {status:0,stdout:'false\\n'};return original.call(this,file,...args)};`);
    process.env.NODE_OPTIONS = '--require ' + JSON.stringify(stub);
    const opts = { ...f, app }, { value, net } = await candidate(opts);
    await u.applyUpdate(value, opts, { ...net, confirmed: true, appInfo, running: () => false });
    assert.equal(u.currentVersion(f), '1.2.0');
    assert.match(fs.readFileSync(path.join(f.profileDir, 'cordis.patch.yml'), 'utf8'), /preserve-me/);
  } finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; f.cleanup(); }
});
test('future installer failure restores old plugin and removes staged update cache', async () => {
  const f = fixture(); try {
    engine.install({ profile: f.profileDir, root: ROOT }); const before = engine.stateOf(engine.locations(f.profileDir));
    const { value, net } = await candidate(f);
    await assert.rejects(u.applyUpdate(value, f, { ...net, confirmed: true, appInfo, running: () => false, installRunner(dir, opts) { try { require(path.join(dir, 'tools/installer.cjs')).install({ profile: opts.profileDir, root: dir, failAt: 'patch' }); } catch { return { status: 1 }; } throw new Error('fault injection did not happen'); } }), e => e.updateCode === 'INSTALL');
    assert.deepEqual(engine.stateOf(engine.locations(f.profileDir)), before);
    assert.deepEqual(fs.readdirSync(path.join(f.profileDir, '.side-chat-installer/updates')), []);
  } finally { f.cleanup(); }
});
