'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), assert = require('node:assert/strict');

function main() {
  const [legacyZip, currentZip] = process.argv.slice(2).map(p => path.resolve(p));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'side-real-upgrade-中文 空格-'));
  const checks = [];
  try {
    const unpack = (zip, sub) => {
      const dest = path.join(temp, sub);
      assert.equal(cp.spawnSync('/usr/bin/ditto', ['-x', '-k', zip, dest]).status, 0);
      return path.join(dest, fs.readdirSync(dest)[0]);
    };
    const oldRoot = unpack(legacyZip, 'old'), root = unpack(currentZip, 'new');
    const old = require(path.join(oldRoot, 'tools/installer.cjs'));
    const next = require(path.join(root, 'tools/installer.cjs'));
    const profile = path.join(temp, 'profile'); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo","private":true}');
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: sibling\n      name: keep-sibling\n');
    const data = path.join(temp, 'side-chat'); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'active.json'), '{"fixture":"unfinished"}');
    old.install({ profile, root: oldRoot });
    const p = next.locations(profile), before = next.stateOf(p);
    const history = JSON.parse(fs.readFileSync(p.history)).length;
    next.install({ profile, root });
    assert.equal(next.doctor({ profile, root }).healthy, true);
    assert.equal(JSON.parse(fs.readFileSync(p.history)).length, history + 1);
    checks.push({ name: `actual-${old.VERSION}-archive-upgrades-to-current`, passed: true });
    const pkg = JSON.parse(fs.readFileSync(p.package)); pkg.dependencies.later = '2.0.0'; fs.writeFileSync(p.package, JSON.stringify(pkg));
    fs.appendFileSync(p.patch, '\n- insert:\n    - id: later\n      name: preserve-later\n');
    next.rollback({ profile });
    assert.deepEqual(next.stateOf(p), before);
    assert.equal(JSON.parse(fs.readFileSync(p.package)).dependencies.later, '2.0.0');
    assert.match(fs.readFileSync(p.patch, 'utf8'), /preserve-later/);
    assert.equal(fs.readFileSync(path.join(data, 'active.json'), 'utf8'), '{"fixture":"unfinished"}');
    checks.push({ name: 'rollback-restores-real-old-payload-preserves-later-config-and-side-data', passed: true });
    console.log(JSON.stringify({ passed: true, oldVersion: old.VERSION, newVersion: next.VERSION, checks }, null, 2));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) try { main(); } catch (error) { console.error(JSON.stringify({ passed: false, code: error.code ?? 'ASSERTION', message: String(error.message).replace(/\/(?:Users|private|var)\/[^\n]*/g, '<local-path>') })); process.exitCode = 1; }
