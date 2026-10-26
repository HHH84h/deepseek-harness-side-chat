#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const YAML = require('../vendor/yaml');

const ID = 'dsh-client-ui-side';
const VERSION = '1.1.2';
const SUPPORTED = '0.2.1-rc.3';
const ROOT = path.resolve(__dirname, '..');
const FILES = ['package.json', 'lib/index.js', 'lib/host.js', 'lib/client.js', 'lib/metadata.js', 'lib/update.js', 'cordis.patch.yml', 'update-source.json', 'README.md', 'LICENSE'];
const ENTRIES = [
  { id: 'ui-side-chat', name: ID },
  { id: 'preset-side-chat', name: '@deepseek-ai/dsh-agent-preset', config: {
    id: 'side-chat', order: 9, plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '你是主对话旁的临时侧聊助手，只解释、讨论和阅读，不修改文件。默认使用用户当前提问的语言回答；只有用户明确要求其他语言时才切换，不要因为参考的主对话内容包含其他语言而改变回答语言。', complete: true } },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { read: true, readImage: true, write: false, edit: false } },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } }
    ]
  } }
];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const equal = (a, b) => stable(a) === stable(b);
function stable(x) { return JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v); }
function readJson(file, fallback) { return exists(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
function atomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.side-tmp-${crypto.randomUUID()}`;
  try { fs.writeFileSync(tmp, content, { mode }); fs.renameSync(tmp, file); }
  finally { if (exists(tmp)) fs.rmSync(tmp, { force: true }); }
}
function remove(p) { if (exists(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copy(src, dst) {
  if (!exists(src)) return;
  const st = fs.lstatSync(src);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
  else if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true, mode: st.mode & 0o777 });
    for (const name of fs.readdirSync(src)) copy(path.join(src, name), path.join(dst, name));
  } else { fs.copyFileSync(src, dst); fs.chmodSync(dst, st.mode & 0o777); }
}
function locations(profile) {
  const state = path.join(profile, '.side-chat-installer');
  return { profile, state, history: path.join(state, 'history.json'), lock: path.join(state, 'lock'),
    plugin: path.join(profile, 'plugins', ID), module: path.join(profile, 'node_modules', ID),
    patch: path.join(profile, 'cordis.patch.yml'), package: path.join(profile, 'package.json') };
}

function parsePatch(file) {
  const doc = YAML.parseDocument(exists(file) ? fs.readFileSync(file, 'utf8') : '[]\n', { uniqueKeys: true });
  if (doc.errors.length) throw new Error('配置 YAML 无法解析；未修改任何配置。');
  if (doc.contents === null) doc.contents = doc.createNode([]);
  if (!YAML.isSeq(doc.contents)) throw new Error('配置不是预期的 YAML 列表；请保留原文件并反馈兼容性问题。');
  return doc;
}
function findEntries(doc) {
  const found = [];
  function walk(seq) {
    for (let i = 0; i < seq.items.length; i++) {
      const node = seq.items[i];
      if (!YAML.isMap(node)) continue;
      const id = node.get('id');
      if (ENTRIES.some(e => e.id === id)) found.push({ id, node, seq });
      const insert = node.get('insert', true);
      if (YAML.isSeq(insert)) walk(insert);
    }
  }
  walk(doc.contents);
  for (const e of ENTRIES) {
    const rows = found.filter(r => r.id === e.id);
    if (rows.length > 1) throw new Error(`配置中 ${e.id} 重复，已停止。`);
    if (rows[0] && rows[0].node.get('name') !== e.name) throw new Error(`配置 ID ${e.id} 已被其他插件使用，已停止。`);
  }
  return found;
}
function managed(doc) {
  const rows = findEntries(doc);
  return Object.fromEntries(ENTRIES.map(e => [e.id, rows.find(r => r.id === e.id)?.node.toJSON() ?? null]));
}
function setEntries(doc, values) {
  for (const entry of ENTRIES) {
    const row = findEntries(doc).find(r => r.id === entry.id);
    const value = values[entry.id];
    if (row) {
      const at = row.seq.items.indexOf(row.node);
      if (value === null) row.seq.items.splice(at, 1);
      else {
        const next = doc.createNode(value);
        next.commentBefore = row.node.commentBefore;
        next.comment = row.node.comment;
        row.seq.items[at] = next;
      }
    } else if (value !== null) doc.contents.items.push(doc.createNode({ insert: [value] }));
  }
  // Only remove empty, pure insert wrappers. Siblings and unrelated entries survive.
  function prune(seq) {
    for (let i = seq.items.length - 1; i >= 0; i--) {
      const map = seq.items[i];
      if (!YAML.isMap(map)) continue;
      const insert = map.get('insert', true);
      if (!YAML.isSeq(insert)) continue;
      prune(insert);
      if (insert.items.length === 0 && map.items.length === 1) seq.items.splice(i, 1);
    }
  }
  prune(doc.contents);
}
function parsePackage(file) {
  const pkg = readJson(file, { name: 'dsh-profile-desktop', private: true });
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || (pkg.dependencies !== undefined && (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)))) throw new Error('profile package.json 格式不兼容，已停止。');
  return pkg;
}
function dependency(pkg) { return own(pkg.dependencies ?? {}, ID) ? { present: true, value: pkg.dependencies[ID] } : { present: false }; }
function setDependency(pkg, dep) {
  if (dep.present) { pkg.dependencies ??= {}; pkg.dependencies[ID] = dep.value; }
  else if (pkg.dependencies) { delete pkg.dependencies[ID]; if (!Object.keys(pkg.dependencies).length) delete pkg.dependencies; }
}
function treeFingerprint(dir) {
  if (!exists(dir)) return null;
  if (fs.lstatSync(dir).isSymbolicLink()) return `link:${fs.readlinkSync(dir)}`;
  const rows = [];
  function walk(base, rel = '') {
    for (const name of fs.readdirSync(base).sort()) {
      const file = path.join(base, name), next = path.posix.join(rel, name), st = fs.lstatSync(file);
      if (st.isSymbolicLink()) rows.push([next, 'link', fs.readlinkSync(file)]);
      else if (st.isDirectory()) walk(file, next);
      else rows.push([next, sha(fs.readFileSync(file))]);
    }
  }
  walk(dir); return sha(stable(rows));
}
function stateOf(p) {
  return { entries: managed(parsePatch(p.patch)), dependency: dependency(parsePackage(p.package)),
    pluginHash: treeFingerprint(p.plugin), moduleHash: treeFingerprint(p.module) };
}
function saveConfig(p, entries, dep, beforeFiles = {}) {
  const doc = parsePatch(p.patch); setEntries(doc, entries);
  if (beforeFiles.patch === false && doc.contents.items.length === 0 && !doc.commentBefore && !doc.comment) remove(p.patch);
  else atomic(p.patch, doc.toString());
  const pkg = parsePackage(p.package); setDependency(pkg, dep);
  if (beforeFiles.package === false && equal(pkg, { name: 'dsh-profile-desktop', private: true })) remove(p.package);
  else atomic(p.package, JSON.stringify(pkg, null, 2) + '\n');
}
function verifyPayload(root) {
  const manifest = readJson(path.join(root, 'release-manifest.json'));
  if (manifest?.version !== VERSION || manifest?.supportedHarness !== SUPPORTED) throw new Error('发行清单缺失或版本不一致。');
  if (!equal(Object.keys(manifest.files).sort(), FILES.map(f => `plugin/${f}`).sort())) throw new Error('发行文件白名单不一致。');
  if (!equal(fs.readdirSync(path.join(root, 'plugin')).sort(), [...new Set(FILES.map(f => f.split('/')[0]))].sort()) || !equal(fs.readdirSync(path.join(root, 'plugin/lib')).sort(), FILES.filter(f => f.startsWith('lib/')).map(f => f.slice(4)).sort())) throw new Error('发行插件目录含白名单外的文件。');
  for (const file of FILES) {
    const target = path.join(root, 'plugin', file);
    if (!exists(target) || fs.lstatSync(target).isSymbolicLink() || sha(fs.readFileSync(target)) !== manifest.files[`plugin/${file}`]) throw new Error(`发行文件校验失败：${file}`);
  }
  return manifest;
}
function validateTarget(p) {
  if (!exists(p.profile) || !fs.statSync(p.profile).isDirectory()) throw new Error('未找到 profile。请先启动一次 DeepSeek Harness，再退出后安装。');
  fs.accessSync(p.profile, fs.constants.W_OK);
  const pkg = parsePackage(p.package);
  if (pkg.dsh?.profile?.bundles?.includes(ID)) throw new Error('已安装原生侧聊插件；请先在 Harness 停用并卸载该插件，再退出应用运行双击安装。未修改任何文件。');
  const dep = dependency(pkg);
  if (dep.present && ![`file:./plugins/${ID}`, `file:plugins/${ID}`].includes(dep.value)) throw new Error('本插件的依赖来自原生包或其他位置；请先在 Harness 卸载原生插件，或检查已有安装。未修改任何文件。');
  if (exists(p.module)) {
    const st = fs.lstatSync(p.module);
    if (!st.isSymbolicLink() || path.resolve(path.dirname(p.module), fs.readlinkSync(p.module)) !== p.plugin) throw new Error('模块入口并非本安装器管理的侧聊链接；请先卸载原生插件或检查已有安装。未修改任何文件。');
  }
  if (exists(p.plugin)) {
    if (fs.lstatSync(p.plugin).isSymbolicLink()) throw new Error('插件目录是外部链接，已停止，避免覆盖其他位置。');
    if (readJson(path.join(p.plugin, 'package.json'), {})?.name !== ID) throw new Error('目标目录不是本插件，已停止。');
  }
  findEntries(parsePatch(p.patch)); parsePackage(p.package);
}
function lock(p) {
  fs.mkdirSync(p.state, { recursive: true, mode: 0o700 }); fs.chmodSync(p.state, 0o700);
  try { fs.writeFileSync(p.lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const previous = readJson(p.lock, {});
    try { if (!Number.isInteger(previous.pid)) throw new Error('锁文件异常'); process.kill(previous.pid, 0); }
    catch (check) {
      if (check.code === 'ESRCH') { fs.unlinkSync(p.lock); return lock(p); }
      throw new Error('已有安装操作或锁文件需要检查，已停止。');
    }
    throw new Error('已有安装操作正在进行，请稍后重试。');
  }
  return () => remove(p.lock);
}
function transaction(p, operation, action, options = {}) {
  validateTarget(p);
  const unlock = lock(p);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const backup = path.join(p.state, 'backups', id);
  const objects = ['plugin', 'module', 'patch', 'package', 'history'];
  let captured = false;
  const fail = stage => { if (options.failAt === stage) throw new Error(`TEST_FAILURE:${stage}`); };
  try {
    validateTarget(p);
    const beforeFiles = { patch: exists(p.patch), package: exists(p.package) };
    const before = stateOf(p);
    if (options.expectedState && !equal(before, options.expectedState)) throw new Error('回退目标在检查后发生变化，已停止。');
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const key of objects) {
      copy(p[key], path.join(backup, key));
      if (['patch', 'package', 'history'].includes(key) && exists(path.join(backup, key))) fs.chmodSync(path.join(backup, key), 0o600);
    }
    captured = true; fail('backup');
    action({ backup, fail, beforeFiles });
    const after = stateOf(p);
    if (options.rollbackId) {
      const history = readJson(p.history, []);
      if (history.at(-1)?.id !== options.rollbackId) throw new Error('回退历史已变化，已停止。');
      history.pop(); atomic(p.history, JSON.stringify(history, null, 2) + '\n');
    } else {
      const receipt = { id, operation, version: VERSION, before, after, beforeFiles };
      atomic(path.join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
      const history = readJson(p.history, []); history.push({ id, operation, version: VERSION });
      atomic(p.history, JSON.stringify(history, null, 2) + '\n');
    }
    fail('history');
    return { operation, changed: true, version: VERSION, backupId: id };
  } catch (e) {
    if (captured) for (const key of objects) { remove(p[key]); copy(path.join(backup, key), p[key]); }
    remove(backup); throw e;
  } finally { unlock(); }
}
function install(options) {
  const p = locations(options.profile), root = options.root ?? ROOT;
  verifyPayload(root); validateTarget(p);
  const installedVersion = readJson(path.join(p.plugin, 'package.json'), {})?.version;
  if (/^\d+\.\d+\.\d+$/.test(installedVersion ?? '')) {
    const old = installedVersion.split('.').map(Number), next = VERSION.split('.').map(Number);
    const difference = old.findIndex((n, i) => n !== next[i]);
    if (difference >= 0 && old[difference] > next[difference]) throw new Error('已安装的插件高于此工具版本，已停止降级；如需恢复，请使用回退上一版。');
  }
  const desired = Object.fromEntries(ENTRIES.map(e => [e.id, e]));
  const dep = { present: true, value: `file:./plugins/${ID}` };
  const wanted = treeFingerprint(p.plugin) === treeFingerprint(path.join(root, 'plugin'));
  const state = stateOf(p);
  if (wanted && equal(state.entries, desired) && equal(state.dependency, dep) && exists(p.module) && fs.lstatSync(p.module).isSymbolicLink() && path.resolve(path.dirname(p.module), fs.readlinkSync(p.module)) === p.plugin) return { operation: 'install', changed: false, version: VERSION };
  return transaction(p, 'install', ({ fail }) => {
    const stage = path.join(p.state, `stage-${crypto.randomUUID()}`);
    try {
      fs.mkdirSync(path.join(stage, 'lib'), { recursive: true });
      for (const file of FILES) fs.copyFileSync(path.join(root, 'plugin', file), path.join(stage, file));
      fail('stage'); remove(p.plugin); fs.mkdirSync(path.dirname(p.plugin), { recursive: true }); fs.renameSync(stage, p.plugin); fail('plugin');
      remove(p.module); fs.mkdirSync(path.dirname(p.module), { recursive: true }); fs.symlinkSync(`../plugins/${ID}`, p.module); fail('link');
      const pkg = parsePackage(p.package); setDependency(pkg, dep); atomic(p.package, JSON.stringify(pkg, null, 2) + '\n'); fail('package');
      const doc = parsePatch(p.patch); setEntries(doc, desired); atomic(p.patch, doc.toString()); fail('patch');
    } finally { remove(stage); }
  }, options);
}
function uninstall(options) {
  const p = locations(options.profile); validateTarget(p);
  const state = stateOf(p);
  if (!state.pluginHash && !state.moduleHash && !state.dependency.present && Object.values(state.entries).every(v => v === null)) return { operation: 'uninstall', changed: false };
  return transaction(p, 'uninstall', ({ fail, beforeFiles }) => {
    saveConfig(p, Object.fromEntries(ENTRIES.map(e => [e.id, null])), { present: false }, beforeFiles); fail('patch');
    remove(p.module); fail('link'); remove(p.plugin); fail('plugin');
  }, options);
}
function rollback(options) {
  const p = locations(options.profile);
  validateTarget(p);
  const history = readJson(p.history, []), latest = history.at(-1);
  if (!latest || !/^[\w.-]+$/.test(latest.id)) throw new Error('没有可回退的安装记录。旧脚本的备份不会被自动猜测或覆盖。');
  const source = path.join(p.state, 'backups', latest.id), receipt = readJson(path.join(source, 'receipt.json'));
  if (!receipt || !equal(stateOf(p), receipt.after)) throw new Error('本插件的文件或配置在安装后被手动修改，已停止回退，避免覆盖。其他插件的独立修改不受限制。');
  return transaction(p, 'rollback', ({ fail }) => {
    saveConfig(p, receipt.before.entries, receipt.before.dependency, receipt.beforeFiles); fail('patch');
    remove(p.plugin); copy(path.join(source, 'plugin'), p.plugin); fail('plugin');
    remove(p.module); copy(path.join(source, 'module'), p.module); fail('link');
  }, { ...options, rollbackId: latest.id, expectedState: receipt.after });
}
function doctor(options) {
  const p = locations(options.profile); validateTarget(p);
  const manifest = verifyPayload(options.root ?? ROOT), state = stateOf(p);
  const installed = Boolean(state.pluginHash);
  const filesMatch = installed && FILES.every(f => exists(path.join(p.plugin, f)) && sha(fs.readFileSync(path.join(p.plugin, f))) === manifest.files[`plugin/${f}`]);
  const entriesMatch = equal(state.entries, Object.fromEntries(ENTRIES.map(e => [e.id, e])));
  const dependencyMatch = equal(state.dependency, { present: true, value: `file:./plugins/${ID}` });
  const linkMatch = exists(p.module) && fs.lstatSync(p.module).isSymbolicLink() && path.resolve(path.dirname(p.module), fs.readlinkSync(p.module)) === p.plugin;
  return { installed, filesMatch, entriesMatch, dependencyMatch, linkMatch, healthy: Boolean(filesMatch && entriesMatch && dependencyMatch && linkMatch) };
}

function appInfo(app, { strict = true } = {}) {
  const info = path.join(app, 'Contents', 'Info.plist');
  const read = key => { const r = cp.spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, info], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 }); if (r.status !== 0) throw new Error('无法读取应用信息。'); return r.stdout.trim(); };
  if (read('CFBundleIdentifier') !== 'com.deepseek.dsh') throw new Error('所选应用不是 DeepSeek Harness。');
  const version = read('CFBundleShortVersionString');
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || version.length > 64) throw new Error('无法识别应用版本。');
  if (strict && version !== SUPPORTED) throw new Error(`此安装包仅支持 DeepSeek Harness ${SUPPORTED}；检测到 ${version}，未修改配置。`);
  return { app, version };
}
function running() {
  const result = cp.spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.deepseek.dsh").count > 0;'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  const value = result.stdout?.trim();
  if (result.status !== 0 || !['true', 'false'].includes(value)) throw new Error('无法确认应用是否退出；请先退出应用后重试。');
  return value === 'true';
}
function cli(argv) {
  const mode = argv.shift();
  if (!['install', 'doctor', 'rollback', 'uninstall'].includes(mode)) throw new Error('用法：installer.cjs install|doctor|rollback|uninstall [--home 目录] [--profile 名称] [--app 应用路径] [--dry-run]');
  const args = { home: path.join(os.homedir(), '.dsh'), profile: 'desktop', app: process.env.DSH_SIDE_APP, dryRun: false };
  while (argv.length) {
    const arg = argv.shift();
    if (arg === '--dry-run') args.dryRun = true;
    else if (['--home', '--profile', '--app'].includes(arg) && argv[0] && !argv[0].startsWith('--')) args[arg.slice(2)] = argv.shift();
    else throw new Error(`不支持的参数：${arg}`);
  }
  if (process.platform !== 'darwin') throw new Error('第一版安装器仅支持 macOS。');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(args.profile)) throw new Error('profile 名称格式不正确。');
  const app = args.app ?? ['/Applications/DeepSeek Harness.app', path.join(os.homedir(), 'Applications', 'DeepSeek Harness.app')].find(exists);
  if (!app) throw new Error('未找到 DeepSeek Harness，请先安装并启动一次。');
  appInfo(path.resolve(app));
  const options = { profile: path.join(path.resolve(args.home), 'profiles', args.profile) };
  verifyPayload(ROOT); validateTarget(locations(options.profile));
  if (mode !== 'doctor' && !args.dryRun && running()) throw new Error('请先完全退出 DeepSeek Harness，再运行此操作。不会强制结束你的任务。');
  if (args.dryRun) { console.log('预检通过。未写入配置、插件、备份或会话。'); return; }
  const result = ({ install, doctor, rollback, uninstall })[mode](options);
  if (mode === 'doctor') {
    console.log(result.healthy ? '检查通过：插件文件、配置与模块入口一致。' : result.installed ? '检查未通过：文件或配置与此发行包不一致，请运行“安装或更新”。' : '尚未安装此插件。');
    if (!result.healthy) process.exitCode = 2;
  } else {
    console.log(result.changed === false ? '无需修改：当前状态已经一致。' : '操作完成。请重新打开 DeepSeek Harness。');
    if (result.backupId) console.log(`本次本地备份编号：${result.backupId}`);
    if (mode === 'uninstall') console.log('仅移除了插件及其配置；未删除任何会话、密钥或其他插件。');
  }
}
function safeMessage(e) {
  const known = /^(配置|profile|发行|目标|模块|未找到|未支持|没有|已有|已安装|本插件|插件目录|此安装包|所选|无法|请先|第一版|用法|不支持|回退)/.test(e.message);
  return `操作未完成：${known ? e.message : `本地文件操作失败（${e.code ?? '未预期错误'}）。未输出配置内容；请运行“检查安装”。`}`;
}
module.exports = { ID, VERSION, SUPPORTED, FILES, ENTRIES, locations, parsePatch, managed, verifyPayload, stateOf, install, doctor, uninstall, rollback, appInfo, running, safeMessage, cli };
if (require.main === module) {
  try { cli(process.argv.slice(2)); }
  catch (e) {
    // Do not echo config contents, environment values, model errors, or credential-bearing stacks.
    console.error(safeMessage(e));
    process.exitCode = 1;
  }
}
