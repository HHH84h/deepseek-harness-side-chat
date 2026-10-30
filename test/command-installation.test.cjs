'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const engine = require('../tools/installer.cjs');
const root = path.resolve(__dirname, '..');
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'side-command-conflict-'));
  const profile = path.join(home, 'profiles/desktop'); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'demo', private: true }));
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: other\n      name: other-plugin\n');
  return { home, profile, options: { root, profile }, clean: () => fs.rmSync(home, { recursive: true, force: true }) };
}
function snapshot(dir) {
  const rows = {};
  function walk(p, rel = '') {
    for (const name of fs.readdirSync(p).sort()) {
      const full = path.join(p, name), next = path.posix.join(rel, name), st = fs.lstatSync(full);
      if (st.isSymbolicLink()) rows[next] = ['link', fs.readlinkSync(full)];
      else if (st.isDirectory()) { rows[next] = ['directory']; walk(full, next); }
      else rows[next] = ['file', fs.readFileSync(full).toString('base64')];
    }
  }
  walk(dir); return rows;
}
for (const mode of ['selected-native', 'disabled-native-dependency', 'foreign-link', 'native-module-directory']) {
  test(`command installer refuses ${mode} without changes for every operation`, () => {
    const f = fixture();
    try {
      const p = engine.locations(f.profile), pkg = JSON.parse(fs.readFileSync(p.package));
      if (mode === 'selected-native') pkg.dsh = { profile: { bundles: [engine.ID] } };
      if (mode === 'disabled-native-dependency') pkg.dependencies = { [engine.ID]: 'file:./downloaded-side.tgz' };
      fs.writeFileSync(p.package, JSON.stringify(pkg));
      if (mode === 'foreign-link') {
        fs.mkdirSync(path.dirname(p.module), { recursive: true });
        fs.symlinkSync(path.join(f.home, 'foreign-target'), p.module);
      }
      if (mode === 'native-module-directory') {
        fs.mkdirSync(p.module, { recursive: true });
        fs.writeFileSync(path.join(p.module, 'package.json'), JSON.stringify({ name: engine.ID, version: '1.1.1' }));
      }
      const before = snapshot(f.home);
      for (const operation of ['install', 'doctor', 'uninstall', 'rollback']) {
        assert.throws(() => engine[operation](f.options), /原生|模块入口/);
        assert.deepEqual(snapshot(f.home), before);
      }
    } finally { f.clean(); }
  });
}
test('command payload does not advertise a native bundle or install scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'plugin/package.json')));
  assert.equal(pkg.dsh.bundle, undefined);
  assert.equal(pkg.scripts, undefined);
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.engines.dsh, '0.2.1-rc.5');
});
test('old script upgrade is one transaction and rollback restores its bytes and state', () => {
  const f = fixture();
  try {
    const p = engine.locations(f.profile);
    fs.mkdirSync(path.join(p.plugin, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(p.plugin, 'package.json'), JSON.stringify({ name: engine.ID, version: '1.0.2' }));
    fs.writeFileSync(path.join(p.plugin, 'lib/index.js'), 'old script marker');
    const data = path.join(f.home, 'side-chat'); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'active.json'), '{"fixture":"unfinished"}');
    const before = engine.stateOf(p);
    engine.install(f.options);
    assert.equal(JSON.parse(fs.readFileSync(path.join(p.plugin, 'package.json'))).version, engine.VERSION);
    assert.equal(engine.doctor(f.options).healthy, true);
    engine.rollback(f.options);
    assert.deepEqual(engine.stateOf(p), before);
    assert.equal(fs.readFileSync(path.join(data, 'active.json'), 'utf8'), '{"fixture":"unfinished"}');
  } finally { f.clean(); }
});
