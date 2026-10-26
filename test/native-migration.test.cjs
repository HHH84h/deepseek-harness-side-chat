'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const engine = require('../tools/installer.cjs');
const { migrate, restore } = require('../tools/migrate.cjs');
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), '原生迁移 空格-')), profile = path.join(home, 'profiles/desktop'); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'demo-profile', dependencies: { other: '1.0.0' }, dsh: { profile: { bundles: [] } } }));
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# keep\n- insert:\n    - id: other\n      name: other\n');
  const options = { profile, root: path.resolve(__dirname, '..') }; engine.install(options);
  const state = path.join(home, 'side-chat'); fs.mkdirSync(state); fs.writeFileSync(path.join(state, 'active.json'), '{"demo":"session-side-demo"}');
  return { home, profile, options, clean: () => fs.rmSync(home, { recursive: true, force: true }) };
}
function later(f) {
  const file = path.join(f.profile, 'package.json'), p = JSON.parse(fs.readFileSync(file)); p.dependencies.later = '2.0.0'; fs.writeFileSync(file, JSON.stringify(p));
  fs.appendFileSync(path.join(f.profile, 'cordis.patch.yml'), '\n- insert:\n    - id: later\n      name: later\n');
}
test('native migration and restore preserve data, same-block siblings and later unrelated changes', () => {
  const f = fixture(); try {
    const p = engine.locations(f.profile); assert.equal(migrate(f.options).changed, true); assert.equal(migrate(f.options).changed, false);
    assert.equal(fs.existsSync(p.plugin), false); assert.equal(fs.existsSync(p.module), false); later(f);
    restore(f.options); assert.equal(fs.existsSync(p.plugin), true); assert.equal(fs.lstatSync(p.module).isSymbolicLink(), true);
    assert.equal(JSON.parse(fs.readFileSync(p.package)).dependencies.later, '2.0.0'); assert.match(fs.readFileSync(p.patch, 'utf8'), /later/);
    assert.equal(fs.readFileSync(path.join(f.home, 'side-chat/active.json'), 'utf8'), '{"demo":"session-side-demo"}');
  } finally { f.clean(); }
});
for (const stage of ['backup', 'patch', 'link', 'plugin', 'history']) test(`native migration failure ${stage} restores prior state`, () => {
  const f = fixture(); try { const p = engine.locations(f.profile), before = engine.stateOf(p); assert.throws(() => migrate({ ...f.options, failAt: stage }), /TEST_FAILURE/); assert.deepEqual(engine.stateOf(p), before); } finally { f.clean(); }
});
test('native migration refuses native install and foreign dependency', () => {
  for (const native of [true, false]) { const f = fixture(); try {
    const file = path.join(f.profile, 'package.json'), p = JSON.parse(fs.readFileSync(file)); if (native) p.dsh.profile.bundles.push(engine.ID); else p.dependencies[engine.ID] = 'file:./foreign'; fs.writeFileSync(file, JSON.stringify(p));
    assert.throws(() => migrate(f.options)); assert.equal(fs.existsSync(engine.locations(f.profile).plugin), true);
  } finally { f.clean(); } }
});
test('native restore refuses changed owned configuration', () => {
  const f = fixture(); try { migrate(f.options); fs.appendFileSync(path.join(f.profile, 'cordis.patch.yml'), '\n- insert:\n    - id: ui-side-chat\n      name: dsh-client-ui-side\n'); assert.throws(() => restore(f.options), /手动修改/); } finally { f.clean(); }
});
