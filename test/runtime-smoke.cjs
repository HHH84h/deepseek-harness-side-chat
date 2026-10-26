'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const YAML = require('../vendor/yaml');
const { spawnOwned } = require('./process-tools.cjs');
const ROOT = path.resolve(__dirname, '..');
function findCli() {
  const file = process.env.DSH_CLI || cp.spawnSync('/bin/sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).stdout.trim();
  if (!file || !fs.existsSync(file)) throw new Error('兼容版本的 dsh CLI 未找到；请通过 DSH_CLI 指定。');
  let dir = path.dirname(fs.realpathSync(file));
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg)).name === '@deepseek-ai/dsh') return { cli: file, dir, require: createRequire(pkg) };
    dir = path.dirname(dir);
  }
  throw new Error('无法定位 dsh 的依赖。');
}
function prepare(root = process.env.SIDE_COMMAND_ROOT || ROOT) {
  const runtime = findCli();
  if (JSON.parse(fs.readFileSync(path.join(runtime.dir, 'package.json'))).version !== '0.2.1-rc.3') throw new Error('测试要求 dsh 0.2.1-rc.3。');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'side-chat-runtime-'));
  const cwd = path.join(home, 'Side Chat Demo'); fs.mkdirSync(cwd);
  const profile = path.join(home, 'profiles/web'); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'isolated-side-chat-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2));
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), YAML.stringify([{ id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'fake-side', model: 'fake-1' } }]));
  const installer = require(path.join(root, 'tools/installer.cjs'));
  const nativeArchive = process.env.SIDE_NATIVE_PACKAGE;
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('DSH_') || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|CLIENT_SECRET)$/.test(name)) delete env[name];
  Object.assign(env, { DSH_HOME: home, DSH_FAKE_LLM_LOG: path.join(home, 'requests.jsonl'), npm_config_cache: path.join(home, 'npm-cache') });
  if (nativeArchive && process.env.SIDE_NATIVE_INSTALL !== 'service') {
    const result = cp.spawnSync(runtime.cli, ['plugin', '--profile', 'web', 'add', path.resolve(nativeArchive), '--offline', '--ignore-scripts', '--config.auto-install-peers=false', '--store-dir', path.join(home, 'store')], { cwd, env, encoding: 'utf8', timeout: 45000, detached: process.platform !== 'win32' });
    if (process.platform !== 'win32' && result.pid) for (const signal of ['SIGTERM', 'SIGKILL']) { try { process.kill(-result.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    if (result.status !== 0) { fs.rmSync(home, { recursive: true, force: true }); throw new Error('Official native package installation failed.'); }
  } else if (!nativeArchive) installer.install({ profile, root });
  if (nativeArchive) fs.writeFileSync(path.join(profile, '.npmrc'), `auto-install-peers=false\nignore-scripts=true\noffline=true\nstore-dir=${path.join(home, 'store')}\n`);
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'test/fake-llm'), path.join(profile, 'node_modules/fake-side-llm'));
  fs.appendFileSync(path.join(profile, 'cordis.patch.yml'), YAML.stringify([{ insert: [{ id: 'fake-side-llm', name: 'fake-side-llm' }] }]));
  // Production script installations do not add framework aliases to the profile.
  // Keep the fixture faithful instead of supplying hidden peer links here.
  return { ...runtime, root: ROOT, payloadRoot: root, home, cwd, profile, env, nativeArchive, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
function addDriver(f) {
  const driver = path.join(f.home, 'driver');
  fs.mkdirSync(path.join(driver, 'test'), { recursive: true });
  fs.cpSync(path.join(f.root ?? ROOT, 'test/host'), path.join(driver, 'test/host'), { recursive: true });
  fs.symlinkSync(path.join(f.profile, f.nativeArchive ? 'node_modules/dsh-client-ui-side' : 'plugins/dsh-client-ui-side'), path.join(driver, 'plugin'));
  fs.symlinkSync(path.join(driver, 'test/host'), path.join(f.profile, 'node_modules/side-chat-test-driver'));
  const file = path.join(f.profile, 'cordis.patch.yml');
  const patch = f.nativeArchive ? fs.readFileSync(file, 'utf8') + YAML.stringify([{ id: 'ui-side-chat', disabled: true }, { insert: [{ id: 'native-test-driver', name: 'side-chat-test-driver' }] }]) : fs.readFileSync(file, 'utf8').replace('name: dsh-client-ui-side', 'name: side-chat-test-driver');
  fs.writeFileSync(file, patch);
}
async function run(f, extra = {}) {
  let owned, timer;
  try {
    owned = spawnOwned(f.cli, ['web', '--no-open', '--port', '0'], { cwd: f.cwd, env: { ...f.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    const child = owned.child;
    const reports = []; let pending = '', permissionDenied = false, errorTail = ''; 
    child.stdout.on('data', b => { pending += b; const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) { try { const x = JSON.parse(line); if ((x.selftest || x.phase || x.stateTest) && reports.length < 2048) reports.push(x); } catch {} } if (pending.length > 65536) pending = ''; });
    child.stderr.on('data', b => { errorTail = (errorTail + b.toString()).slice(-5000); if (/EPERM|EACCES/.test(b.toString())) permissionDenied = true; });
    timer = setTimeout(() => { void owned.stop(); }, 90000); timer.unref();
    const { code } = await owned.closed;
    const failures = reports.filter(r => r.ok === false).map(r => r.selftest);
    const summary = reports.findLast(r => r.selftest === 'summary');
    const result = { passed: code === 0 && failures.length === 0 && (extra.DSH_SIDE_SELFTEST ? summary?.passed === summary?.total && summary?.total > 0 : reports.some(r => r.phase || r.stateTest)), exitCode: code, assertions: reports.filter(r => typeof r.ok === 'boolean').length, failures, summary: summary ? { passed: summary.passed, total: summary.total } : null, reports };
    if (!result.passed) result.errorTail = errorTail.replace(/\/(?:Users|private|var)\/[^\s\n)]+/g, '<local-path>');
    if (!result.passed && permissionDenied) result.permission = 'local-listener-permission-required';
    return result;
  } finally { clearTimeout(timer); await owned?.stop(); }
}
async function smoke() {
  const f = prepare();
  try {
    addDriver(f);
    const suite = await run(f, { DSH_SIDE_SELFTEST: '1', DSH_SIDE_SELFTEST_LLM: '1', DSH_SIDE_OPT_TESTS: '1' });
    delete suite.reports;
    return suite;
  } finally { f.cleanup(); }
}
module.exports = { prepare, addDriver, run, smoke };
if (require.main === module) smoke().then(r => { console.log(JSON.stringify(r, null, 2)); if (!r.passed) process.exitCode = 1; }).catch(e => { console.error(e.message); process.exitCode = 1; });
