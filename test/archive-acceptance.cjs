'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function main() {
  const zip = path.resolve(process.argv[2]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'side-archive-中文 路径-'));
  const checks = [];
  const check = (name, fn) => { fn(); checks.push({ name, passed: true }); };
  try {
    const extracted = path.join(tmp, '解压 安装包');
    assert.equal(cp.spawnSync('/usr/bin/ditto', ['-x', '-k', zip, extracted]).status, 0);
    const root = path.join(extracted, fs.readdirSync(extracted)[0]);
    const engine = require(path.join(root, 'tools/installer.cjs'));
    check('archive-payload-and-host-module', () => { engine.verifyPayload(root); assert.ok(fs.existsSync(path.join(root, 'plugin/lib/host.js'))); assert.equal(fs.existsSync(path.join(root, 'test')), false); });
    const home = path.join(tmp, '隔离 用户');
    const profile = path.join(home, 'profiles/desktop'); fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: sibling\n      name: unchanged-plugin\n');
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'test-profile', private: true }));
    // A temporary app fixture uses a real Node executable. Only the running-app
    // query is stubbed, so mutations stay inside this explicitly supplied home.
    const app = path.join(tmp, '测试 应用.app');
    fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
    const plist = version => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.deepseek.dsh</string><key>CFBundleExecutable</key><string>TestRuntime</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;
    fs.writeFileSync(path.join(app, 'Contents/Info.plist'), plist('0.2.1-rc.5'));
    const stub = path.join(tmp, 'fixture-runtime.cjs');
    fs.writeFileSync(stub, "const fs=require('node:fs'),cp=require('node:child_process'),original=cp.spawnSync,rename=fs.renameSync;let failed=false;cp.spawnSync=function(command,...args){if(command==='/usr/bin/osascript')return {status:0,stdout:(process.env.SIDE_FIXTURE_RUNNING==='1'?'true':'false')+'\\n'};return original.call(this,command,...args)};fs.renameSync=function(from,to){if(process.env.SIDE_FIXTURE_FAIL_AT_PATCH==='1'&&!failed&&String(to).endsWith('/cordis.patch.yml')){failed=true;const e=new Error('injected');e.code='EIO';throw e;}return rename.call(this,from,to)};\n");
    fs.writeFileSync(path.join(app, 'Contents/MacOS/TestRuntime'), `#!/bin/bash\nexec ${quote(process.execPath)} --require ${quote(stub)} "$@"\n`, { mode: 0o755 });
    const call = (entry, extra = [], env = {}) => cp.spawnSync('/bin/bash', [path.join(root, entry), '--home', home, ...extra], { encoding: 'utf8', timeout: 25000, env: { ...process.env, DSH_SIDE_APP: app, ...env } });
    const options = { profile, root };
    check('unpacked-install-entry-chinese-and-space-path', () => { const r = call('安装或更新.command'); assert.equal(r.status, 0, r.stderr); assert.equal(engine.doctor(options).healthy, true); });
    check('unpacked-check-entry', () => { assert.equal(call('检查安装.command').status, 0); });
    check('unpacked-update-entry-unconfigured-offline', () => { const before = engine.stateOf(engine.locations(profile)); const r = call('检查更新.command'); assert.equal(r.status, 0); assert.match(r.stdout, /没有发出网络请求/); assert.deepEqual(engine.stateOf(engine.locations(profile)), before); });
    check('unpacked-success-in-tty-autoexits', () => {
      const py = `import os,pty,subprocess,sys,errno
master,slave=pty.openpty()
child=subprocess.Popen(['/bin/bash',*sys.argv[1:]],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
while True:
    try: data=os.read(master,8192)
    except OSError as e:
        if e.errno==errno.EIO: break
        raise
    if not data: break
    os.write(sys.stdout.fileno(),data)
os.close(master)
sys.exit(child.wait())
`;
      const r = cp.spawnSync('/usr/bin/python3', ['-u', '-c', py, path.join(root, '检查安装.command'), '--home', home], { encoding: 'utf8', timeout: 8000, env: { ...process.env, SIDE_KEEP_OPEN: '0', DSH_SIDE_APP: app } });
      assert.equal(r.status, 0); assert.match(r.stdout, /脚本自动退出/);
    });
    check('unpacked-repeat-no-extra-backup', () => { const file = engine.locations(profile).history, before = fs.readFileSync(file, 'utf8'); assert.equal(call('安装或更新.command').status, 0); assert.equal(fs.readFileSync(file, 'utf8'), before); });
    check('unpacked-uninstall-and-sibling-preservation', () => { assert.equal(call('卸载.command').status, 0); assert.equal(fs.existsSync(engine.locations(profile).plugin), false); assert.match(fs.readFileSync(engine.locations(profile).patch, 'utf8'), /unchanged-plugin/); });
    check('unpacked-rollback-entry', () => { assert.equal(call('回退上一版.command').status, 0); assert.equal(engine.doctor(options).healthy, true); });
    check('running-app-refuses-without-writing-or-forcing-exit', () => {
      const before = engine.stateOf(engine.locations(profile));
      const r = call('安装或更新.command', [], { SIDE_FIXTURE_RUNNING: '1' });
      assert.equal(r.status, 1); assert.match(r.stderr, /完全退出/);
      assert.deepEqual(engine.stateOf(engine.locations(profile)), before);
    });
    check('native-install-conflict-refuses-actual-entry', () => {
      const file = engine.locations(profile).package, original = fs.readFileSync(file, 'utf8');
      const pkg = JSON.parse(original); pkg.dsh = { profile: { bundles: [engine.ID] } };
      fs.writeFileSync(file, JSON.stringify(pkg));
      try {
        const before = engine.stateOf(engine.locations(profile));
        const r = call('安装或更新.command'); assert.equal(r.status, 1); assert.match(r.stderr, /原生/);
        assert.deepEqual(engine.stateOf(engine.locations(profile)), before);
      } finally { fs.writeFileSync(file, original); }
    });
    check('actual-entry-install-failure-restores-old-state-and-history', () => {
      const p = engine.locations(profile), marker = path.join(p.plugin, 'old-marker');
      fs.writeFileSync(marker, 'preserve old installed content');
      const before = engine.stateOf(p), history = fs.readFileSync(p.history, 'utf8');
      const r = call('安装或更新.command', [], { SIDE_FIXTURE_FAIL_AT_PATCH: '1' });
      assert.equal(r.status, 1); assert.deepEqual(engine.stateOf(p), before);
      assert.equal(fs.readFileSync(p.history, 'utf8'), history);
      assert.equal(fs.existsSync(p.lock), false); fs.unlinkSync(marker);
    });
    check('unsupported-version-no-write', () => { const before = engine.stateOf(engine.locations(profile)); fs.writeFileSync(path.join(app, 'Contents/Info.plist'), plist('9.9.9')); const r = call('安装或更新.command'); assert.equal(r.status, 1); assert.match(r.stderr, /仅支持/); assert.deepEqual(engine.stateOf(engine.locations(profile)), before); fs.writeFileSync(path.join(app, 'Contents/Info.plist'), plist('0.2.1-rc.5')); });
    check('missing-profile-no-write', () => { const r = call('安装或更新.command', ['--profile', 'missing']); assert.equal(r.status, 1); assert.equal(fs.existsSync(path.join(home, 'profiles/missing')), false); });
    check('missing-app-no-write', () => { const before = engine.stateOf(engine.locations(profile)); assert.equal(call('安装或更新.command', [], { DSH_SIDE_APP: path.join(tmp, 'Absent.app') }).status, 1); assert.deepEqual(engine.stateOf(engine.locations(profile)), before); });
    check('missing-runtime-message-no-write-simulated', () => {
      const shellEnv = path.join(tmp, 'missing-runtime.sh');
      fs.writeFileSync(shellEnv, 'function [() { if builtin [ "$1" = "-x" ]; then return 1; fi; builtin [ "$@"; }\nfunction command() { if builtin [ "$1" = "-v" ] && builtin [ "$2" = "node" ]; then return 1; fi; builtin command "$@"; }\n');
      const before = engine.stateOf(engine.locations(profile));
      const r = call('安装或更新.command', [], { BASH_ENV: shellEnv });
      assert.equal(r.status, 1); assert.match(r.stdout, /运行环境不可用/); assert.deepEqual(engine.stateOf(engine.locations(profile)), before);
    });
    console.log(JSON.stringify({ passed: true, checks, nativeFinderDoubleClick: 'separate-manual-check', mutations: 'isolated-profile-only' }, null, 2));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
try { main(); } catch (error) { console.error(JSON.stringify({ passed: false, error: error.code ?? 'assertion-failed', message: String(error.message).replace(/\/(?:Users|private|var)\/[^\n]*/g, '<local-path>') })); process.exitCode = 1; }
