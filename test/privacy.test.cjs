const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('../scripts/privacy.cjs');
test('clean project has no privacy findings', () => { const r = scan(path.resolve(__dirname, '..')); assert.equal(r.passed, true, JSON.stringify(r.findings)); });
test('scanner rejects excluded files, user paths and key-like values without echoing matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'side-privacy-'));
  try {
    const example = ['sk', '-'].join('') + 'A'.repeat(32);
    const privatePath = ['', 'Users', 'example-person', 'private'].join('/');
    fs.writeFileSync(path.join(root, 'README.md'), `${example}\n${privatePath}`);
    fs.mkdirSync(path.join(root, 'sessions'));
    fs.writeFileSync(path.join(root, 'sessions', 'private.log'), 'private');
    const r = scan(root);
    assert.equal(r.passed, false);
    assert.ok(r.findings.some(x => x.category === 'provider-key'));
    assert.ok(r.findings.some(x => x.category === 'private-user-path'));
    assert.ok(r.findings.some(x => x.category === 'excluded-path'));
    assert.equal(JSON.stringify(r.findings).includes(example), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
