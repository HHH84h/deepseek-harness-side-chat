'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnOwned } = require('./process-tools.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PTY = `import os,pty,subprocess,select,sys,errno
master,slave=pty.openpty()
child=subprocess.Popen(['/bin/bash',sys.argv[1],'doctor'],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
while True:
    ready,_,_=select.select([master,sys.stdin.fileno()],[],[],0.1)
    if master in ready:
        try: data=os.read(master,8192)
        except OSError as e:
            if e.errno==errno.EIO: break
            raise
        if not data: break
        os.write(sys.stdout.fileno(),data)
    if sys.stdin.fileno() in ready:
        data=os.read(sys.stdin.fileno(),8192)
        if data: os.write(master,data)
    if child.poll() is not None and not ready: break
os.close(master)
sys.exit(child.wait())
`;
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture(code = 0) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'side-launcher-中文 路径-')), tools = path.join(home, 'tools'); fs.mkdirSync(tools);
  fs.copyFileSync(path.join(__dirname, '../tools/launcher.sh'), path.join(tools, 'launcher.sh'));
  fs.writeFileSync(path.join(tools, 'entry.cjs'), `console.log('SYNTHETIC-DONE');process.exit(${code});`);
  const app = path.join(home, 'Fixture App.app'); fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>FixtureNode</string></dict></plist>');
  fs.writeFileSync(path.join(app, 'Contents/MacOS/FixtureNode'), `#!/bin/bash\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  return { home, tools, app, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
async function scenario(f, extra, task) {
  const child = spawnOwned('/usr/bin/python3', ['-u', '-c', PTY, path.join(f.tools, 'launcher.sh')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DSH_SIDE_APP: f.app, SIDE_KEEP_OPEN: '0', ...extra } });
  let output = ''; child.child.stdout.on('data', b => { output = (output + b).slice(-4096); });
  try { await task(child, () => output); } finally { await child.stop(200); f.cleanup(); }
}
test('TTY success exits without Enter or EOF', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/python3'), timeout: 7000 }, async () => {
  const f = fixture(); await scenario(f, {}, async (p, out) => { const timeout = setTimeout(() => { void p.stop(200); }, 5000); try { const r = await p.closed; assert.equal(r.code, 0); assert.match(out(), /脚本自动退出/); assert.ok(!p.child.stdin.destroyed || p.isClosed); } finally { clearTimeout(timeout); } });
});
test('TTY failure uses bounded wait and preserves original code', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/python3'), timeout: 7000 }, async () => {
  const f = fixture(7), env = path.join(f.home, 'read-timeout.sh');
  fs.writeFileSync(env, 'read() { if [ "$3" = "20" ]; then printf "TIMEOUT-20\\n"; return 142; fi; return 1; }\n');
  await scenario(f, { BASH_ENV: env }, async (p, out) => { const timeout = setTimeout(() => { void p.stop(200); }, 5000); try { const r = await p.closed; assert.equal(r.code, 7); assert.match(out(), /TIMEOUT-20/); } finally { clearTimeout(timeout); } });
});
test('explicit keep-open remains available until Enter', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/python3'), timeout: 7000 }, async () => {
  const f = fixture(); await scenario(f, { SIDE_KEEP_OPEN: '1' }, async (p, out) => { for (let i = 0; i < 30 && !out().includes('已选择保留结果'); i++) await sleep(50); assert.match(out(), /已选择保留结果/); assert.equal(p.isClosed, false); p.child.stdin.write('\n'); assert.equal((await p.closed).code, 0); });
});
