'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const engine = require('../tools/installer.cjs');
const YAML = require('../vendor/yaml');
const ROOT = path.resolve(__dirname, '..');
const fixture = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'side-chat-安装 测试-'));
  const profile = path.join(home, 'profiles', 'desktop'); fs.mkdirSync(profile, { recursive: true });
  const patch = '# preserve this comment\n- insert:\n    - id: sibling\n      name: other-plugin\n      config:\n        value: keep\n';
  const pkg = { name: 'sample-profile', private: true, dependencies: { sibling: 'file:./sibling' }, dsh: { profile: { bundles: ['sample-base'] } } };
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), patch);
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const session = path.join(home, 'sessions', 'ordinary', 'keep.txt'); fs.mkdirSync(path.dirname(session), { recursive: true }); fs.writeFileSync(session, 'ordinary session remains');
  return { home, profile, patch, pkg, session, options: { profile, root: ROOT }, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
};
function entries(profile) { return engine.managed(engine.parsePatch(path.join(profile, 'cordis.patch.yml'))); }
function targets(profile) { const p = engine.locations(profile); return Object.fromEntries(['patch', 'package', 'history'].map(k => [k, fs.existsSync(p[k]) ? fs.readFileSync(p[k], 'utf8') : null]).concat([['state', engine.stateOf(p)]])); }
function addOther(f) {
  fs.appendFileSync(path.join(f.profile, 'cordis.patch.yml'), '\n# added later\n- insert:\n    - id: later-plugin\n      name: later-plugin\n');
  const p = path.join(f.profile, 'package.json'), pkg = JSON.parse(fs.readFileSync(p)); pkg.dependencies.later = '2.0.0'; fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
}
test('fresh install, all payload files, module link and doctor', () => {
  const f = fixture(); try {
    assert.equal(engine.install(f.options).changed, true);
    assert.equal(engine.doctor(f.options).healthy, true);
    const p = engine.locations(f.profile);
    assert.deepEqual(fs.readdirSync(p.plugin).sort(), [...new Set(engine.FILES.map(f => f.split('/')[0]))].sort());
    assert.equal(fs.lstatSync(p.module).isSymbolicLink(), true);
    assert.match(fs.readFileSync(p.patch, 'utf8'), /preserve this comment/);
    assert.equal(fs.readFileSync(f.session, 'utf8'), 'ordinary session remains');
    const id = JSON.parse(fs.readFileSync(p.history))[0].id;
    assert.equal(fs.statSync(path.join(p.state, 'backups', id)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(p.state, 'backups', id, 'patch')).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});
test('identical install is a no-op and creates no extra backups', () => {
  const f = fixture(); try { engine.install(f.options); const before = targets(f.profile); assert.equal(engine.install(f.options).changed, false); assert.deepEqual(targets(f.profile), before); } finally { f.cleanup(); }
});
test('legacy upgrade backs up old files and rollback restores them, preserving later unrelated edits', () => {
  const f = fixture(); try {
    const p = engine.locations(f.profile); fs.mkdirSync(path.join(p.plugin, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(p.plugin, 'package.json'), JSON.stringify({ name: engine.ID, version: '0.9.0' }));
    fs.writeFileSync(path.join(p.plugin, 'lib', 'index.js'), 'legacy marker');
    fs.mkdirSync(path.dirname(p.module), { recursive: true }); fs.symlinkSync(`../plugins/${engine.ID}`, p.module);
    const doc = engine.parsePatch(p.patch); doc.contents.items[0].get('insert', true).items.push(doc.createNode(engine.ENTRIES[0])); fs.writeFileSync(p.patch, doc.toString());
    engine.install(f.options); addOther(f); engine.rollback(f.options);
    assert.equal(fs.readFileSync(path.join(p.plugin, 'lib/index.js'), 'utf8'), 'legacy marker');
    assert.equal(JSON.parse(fs.readFileSync(p.package)).dependencies.later, '2.0.0');
    assert.match(fs.readFileSync(p.patch, 'utf8'), /later-plugin/);
    assert.match(fs.readFileSync(p.patch, 'utf8'), /sibling/);
    assert.deepEqual(entries(f.profile)['ui-side-chat'], engine.ENTRIES[0]);
    assert.equal(entries(f.profile)['preset-side-chat'], null);
  } finally { f.cleanup(); }
});
test('rollback a first install returns to not installed without removing later plugin changes', () => {
  const f = fixture(); try { engine.install(f.options); addOther(f); engine.rollback(f.options); const p = engine.locations(f.profile); assert.equal(fs.existsSync(p.plugin), false); assert.match(fs.readFileSync(p.patch, 'utf8'), /later-plugin/); assert.equal(JSON.parse(fs.readFileSync(p.package)).dependencies.later, '2.0.0'); assert.equal(entries(f.profile)['ui-side-chat'], null); } finally { f.cleanup(); }
});
for (const stage of ['backup', 'stage', 'plugin', 'link', 'package', 'patch', 'history']) test(`install failure at ${stage} restores bytes, links and old plugin`, () => {
  const f = fixture(); try {
    engine.install(f.options);
    fs.writeFileSync(path.join(f.profile, 'plugins', engine.ID, 'marker'), 'keep old plugin');
    const before = targets(f.profile);
    assert.throws(() => engine.install({ ...f.options, failAt: stage }), /TEST_FAILURE/);
    assert.deepEqual(targets(f.profile), before);
    assert.equal(fs.readFileSync(path.join(f.profile, 'plugins', engine.ID, 'marker'), 'utf8'), 'keep old plugin');
    assert.equal(fs.existsSync(engine.locations(f.profile).lock), false);
  } finally { f.cleanup(); }
});
test('uninstall removes only managed entries, leaves same-block siblings, sessions, credentials and later changes', () => {
  const f = fixture(); try {
    engine.install(f.options); addOther(f);
    const p = engine.locations(f.profile), doc = engine.parsePatch(p.patch);
    const owned = doc.contents.items.find(n => n.get?.('insert', true)?.items.some(x => x.get?.('id') === 'ui-side-chat'));
    owned.get('insert', true).items.push(doc.createNode({ id: 'another-sibling', name: 'keep-another' })); fs.writeFileSync(p.patch, doc.toString());
    engine.uninstall(f.options);
    assert.equal(fs.existsSync(p.plugin), false); assert.equal(fs.existsSync(p.module), false);
    assert.equal(entries(f.profile)['ui-side-chat'], null); assert.equal(entries(f.profile)['preset-side-chat'], null);
    assert.match(fs.readFileSync(p.patch, 'utf8'), /another-sibling/); assert.match(fs.readFileSync(p.patch, 'utf8'), /preserve this comment/);
    assert.equal(JSON.parse(fs.readFileSync(p.package)).dependencies.later, '2.0.0');
    assert.equal(fs.readFileSync(f.session, 'utf8'), 'ordinary session remains');
    assert.equal(engine.uninstall(f.options).changed, false);
  } finally { f.cleanup(); }
});
test('rollback can undo uninstall', () => {
  const f = fixture(); try { engine.install(f.options); engine.uninstall(f.options); engine.rollback(f.options); assert.equal(engine.doctor(f.options).healthy, true); } finally { f.cleanup(); }
});
test('rollback refuses changed managed configuration and preserves it', () => {
  const f = fixture(); try { engine.install(f.options); const p = engine.locations(f.profile); const doc = engine.parsePatch(p.patch); const map = doc.contents.items.find(n => n.get?.('insert', true)?.items.some(x => x.get?.('id') === 'ui-side-chat')); map.get('insert', true).items[0].set('disabled', true); fs.writeFileSync(p.patch, doc.toString()); const before = targets(f.profile); assert.throws(() => engine.rollback(f.options), /手动修改/); assert.deepEqual(targets(f.profile), before); } finally { f.cleanup(); }
});
test('empty profile works and rollback removes only installer-created files', () => {
  const f = fixture(); try { const p = engine.locations(f.profile); fs.unlinkSync(p.patch); fs.unlinkSync(p.package); engine.install(f.options); assert.equal(engine.doctor(f.options).healthy, true); engine.rollback(f.options); assert.equal(fs.existsSync(p.patch), false); assert.equal(fs.existsSync(p.package), false); } finally { f.cleanup(); }
});
test('foreign config ID and duplicate ID are refused before changes', () => {
  for (const data of ['- id: ui-side-chat\n  name: unrelated\n', '- id: ui-side-chat\n  name: dsh-client-ui-side\n- id: ui-side-chat\n  name: dsh-client-ui-side\n']) {
    const f = fixture(); try { const p = engine.locations(f.profile); fs.writeFileSync(p.patch, data); const original = fs.readFileSync(p.patch, 'utf8'); assert.throws(() => engine.install(f.options)); assert.equal(fs.readFileSync(p.patch, 'utf8'), original); assert.equal(fs.existsSync(p.state), false); } finally { f.cleanup(); }
  }
});
test('invalid YAML is refused, with no config contents in the error', () => {
  const f = fixture(); try { const p = engine.locations(f.profile); fs.writeFileSync(p.patch, '[invalid'); assert.throws(() => engine.install(f.options), /YAML 无法解析/); assert.equal(fs.readFileSync(p.patch, 'utf8'), '[invalid'); } finally { f.cleanup(); }
});
test('payload modification is detected before touching profile', () => {
  const f = fixture(), copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'side-payload-')); try { fs.cpSync(path.join(ROOT, 'plugin'), path.join(copyRoot, 'plugin'), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'release-manifest.json'), path.join(copyRoot, 'release-manifest.json')); fs.appendFileSync(path.join(copyRoot, 'plugin/lib/client.js'), '\n// changed'); assert.throws(() => engine.install({ ...f.options, root: copyRoot }), /校验失败/); assert.equal(fs.existsSync(engine.locations(f.profile).state), false); } finally { f.cleanup(); fs.rmSync(copyRoot, { recursive: true, force: true }); }
});
test('foreign destination directory is refused', () => {
  const f = fixture(); try { const p = engine.locations(f.profile); fs.mkdirSync(p.plugin, { recursive: true }); fs.writeFileSync(path.join(p.plugin, 'package.json'), JSON.stringify({ name: 'not-our-plugin' })); assert.throws(() => engine.install(f.options), /不是本插件/); } finally { f.cleanup(); }
});
test('in-use lock prevents a concurrent mutation', () => {
  const f = fixture(); try { const p = engine.locations(f.profile); fs.mkdirSync(p.state, { recursive: true }); fs.writeFileSync(p.lock, JSON.stringify({ pid: process.pid })); assert.throws(() => engine.install(f.options), /正在进行/); assert.equal(fs.existsSync(p.plugin), false); } finally { f.cleanup(); }
});
test('stale lock can be recovered', () => {
  const f = fixture(); try { const p = engine.locations(f.profile); fs.mkdirSync(p.state, { recursive: true }); fs.writeFileSync(p.lock, JSON.stringify({ pid: 2147483647 })); engine.install(f.options); assert.equal(engine.doctor(f.options).healthy, true); } finally { f.cleanup(); }
});
function cliWith(stubs, options) {
  const mod = { exports: {} };
  const code = fs.readFileSync(path.join(ROOT, 'tools/installer.cjs'), 'utf8');
  const fakeProcess = { ...process, platform: stubs.platform ?? 'darwin', env: stubs.env ?? {}, argv: [], exitCode: 0 };
  const spawnSync = (command, args) => {
    if (command.endsWith('PlistBuddy')) return { status: 0, stdout: args[1].includes('CFBundleIdentifier') ? 'com.deepseek.dsh\n' : `${stubs.version ?? '0.2.1-rc.3'}\n` };
    return { status: 0, stdout: stubs.running ? 'true\n' : 'false\n' };
  };
  const sandbox = { module: mod, exports: mod.exports, require: name => name === 'node:child_process' ? { spawnSync } : name === 'node:os' && stubs.userHome ? { ...os, homedir: () => stubs.userHome } : name === '../vendor/yaml' ? YAML : require(name), __dirname: path.join(ROOT, 'tools'), process: fakeProcess, console: { log() {}, error() {} } };
  vm.runInNewContext(code, sandbox, { filename: 'installer.cjs' });
  return mod.exports.cli(options);
}
test('unsupported OS, version and running app fail without changes', () => {
  const f = fixture(); try { const before = targets(f.profile); const args = ['install', '--home', f.home, '--app', '/Applications/Test.app']; assert.throws(() => cliWith({ platform: 'win32' }, [...args]), /仅支持 macOS/); assert.throws(() => cliWith({ version: '9.9.9' }, [...args]), /仅支持 DeepSeek/); assert.throws(() => cliWith({ running: true }, [...args]), /完全退出/); assert.deepEqual(targets(f.profile), before); } finally { f.cleanup(); }
});
test('dry-run and doctor do not create backups or modify files', () => {
  const f = fixture(); try { const before = targets(f.profile); cliWith({}, ['install', '--home', f.home, '--app', '/Applications/Test.app', '--dry-run']); assert.deepEqual(targets(f.profile), before); assert.equal(fs.existsSync(engine.locations(f.profile).state), false); engine.doctor(f.options); assert.deepEqual(targets(f.profile), before); } finally { f.cleanup(); }
});
test('default profile is inside user home .dsh, ignoring inherited DSH_HOME', () => {
  const f = fixture(); try {
    const actual = path.join(f.home, '.dsh/profiles/desktop');
    fs.mkdirSync(path.dirname(actual), { recursive: true }); fs.cpSync(f.profile, actual, { recursive: true });
    cliWith({ userHome: f.home, env: { DSH_HOME: path.join(f.home, 'wrong-home') } }, ['install', '--app', '/Applications/Test.app']);
    assert.equal(engine.doctor({ profile: actual, root: ROOT }).healthy, true);
    assert.equal(fs.existsSync(path.join(f.profile, 'plugins')), false);
    assert.equal(fs.existsSync(path.join(f.home, 'wrong-home')), false);
  } finally { f.cleanup(); }
});
test('older installer refuses downgrade and leaves newer plugin intact', () => {
  const f = fixture(); try {
    engine.install(f.options);
    const file = path.join(f.profile, 'plugins', engine.ID, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file)); pkg.version = '9.0.0'; fs.writeFileSync(file, JSON.stringify(pkg));
    const before = targets(f.profile);
    assert.throws(() => engine.install(f.options), /停止降级/);
    assert.deepEqual(targets(f.profile), before);
  } finally { f.cleanup(); }
});
test('actual macOS command launcher uses bundled runtime and handles a spaced path in dry-run', { skip: process.platform !== 'darwin' || !fs.existsSync('/Applications/DeepSeek Harness.app') }, () => {
  const f = fixture(); try { const before = targets(f.profile); const r = cp.spawnSync('/bin/bash', [path.join(ROOT, '安装或更新.command'), '--home', f.home, '--dry-run'], { encoding: 'utf8', timeout: 25000 }); assert.equal(r.status, 0, r.stderr || r.stdout); assert.match(r.stdout, /预检通过/); assert.deepEqual(targets(f.profile), before); } finally { f.cleanup(); }
});
