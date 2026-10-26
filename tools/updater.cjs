'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { TextDecoder } = require('node:util');
const engine = require('./installer.cjs');
const ROOT = path.resolve(__dirname, '..');
const PRODUCT = 'deepseek-harness-side-chat';
const FEED = 'side-chat-update.json';
const MAX_ZIP = 16 * 1024 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code) { const e = new Error(code); e.updateCode = code; throw e; }
function version(v) {
  if (typeof v !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) fail('VERSION');
  const parts = v.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) fail('VERSION');
  return parts;
}
function compare(a, b) { const x = version(a), y = version(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1; return 0; }
function readSource(root = ROOT) {
  let s; try { s = JSON.parse(fs.readFileSync(path.join(root, 'update-source.json'), 'utf8')); } catch { fail('SOURCE'); }
  if (s?.schema !== 1 || typeof s.enabled !== 'boolean' || typeof s.autoCheck !== 'boolean' || s.channel !== 'stable') fail('SOURCE');
  if (s.enabled && (typeof s.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s.repository))) fail('SOURCE');
  return s;
}
function parseOptions(argv) {
  const options = { home: path.join(os.homedir(), '.dsh'), profile: 'desktop', app: process.env.DSH_SIDE_APP, dryRun: false };
  while (argv.length) {
    const arg = argv.shift();
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--disable-auto-check') options.autoCheck = false;
    else if (arg === '--enable-auto-check') options.autoCheck = true;
    else if (['--home', '--profile', '--app'].includes(arg) && argv[0] && !argv[0].startsWith('--')) options[arg.slice(2)] = argv.shift();
    else fail('ARGUMENT');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.profile)) fail('ARGUMENT');
  options.home = path.resolve(options.home);
  options.profileDir = path.join(options.home, 'profiles', options.profile);
  options.app ??= ['/Applications/DeepSeek Harness.app', path.join(os.homedir(), 'Applications/DeepSeek Harness.app')].find(p => fs.existsSync(p));
  return options;
}
function preferenceFile(options) { return path.join(options.profileDir, '.side-chat-installer', 'update-preferences.json'); }
function autoAllowed(options, source) {
  if (!source.enabled || !source.autoCheck) return false;
  try {
    const file = preferenceFile(options);
    if (!fs.existsSync(file)) return true;
    const p = JSON.parse(fs.readFileSync(file));
    return p?.schema === 1 && p.autoCheck === true;
  } catch { return false; }
}
function setPreference(options) {
  if (!fs.existsSync(options.profileDir)) fail('PROFILE');
  const file = preferenceFile(options), tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(tmp, JSON.stringify({ schema: 1, autoCheck: options.autoCheck }) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
function currentVersion(options) {
  const file = path.join(options.profileDir, 'plugins', engine.ID, 'package.json');
  if (!fs.existsSync(file)) return engine.VERSION;
  let pkg; try { pkg = JSON.parse(fs.readFileSync(file)); } catch { fail('INSTALLED_VERSION'); }
  if (pkg.name !== engine.ID) fail('INSTALLED_VERSION');
  try { version(pkg.version); } catch { fail('INSTALLED_VERSION'); }
  return pkg.version;
}
function allowedURL(value, repository) {
  let u; try { u = new URL(value); } catch { fail('URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) fail('URL');
  if (u.hostname === 'api.github.com') { if (!u.pathname.startsWith(`/repos/${repository}/releases`)) fail('URL'); }
  else if (u.hostname === 'github.com') { if (!u.pathname.startsWith(`/${repository}/releases/download/`)) fail('URL'); }
  else if (!['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname)) fail('URL');
  return u;
}
async function openResponse(url, { repository, maxBytes, fetchImpl = fetch, signal = AbortSignal.timeout(15000) }) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    const u = allowedURL(current, repository);
    const headers = { 'User-Agent': 'side-chat-updater', Accept: u.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' };
    let response;
    try { response = await fetchImpl(u.href, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', signal }); }
    catch { fail('NETWORK'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) fail('URL'); current = new URL(location, u).href; continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); fail(response.status === 403 || response.status === 429 ? 'RATE_LIMIT' : 'NETWORK'); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body?.cancel(); fail('SIZE'); }
    if (!response.body) fail('NETWORK');
    return response;
  }
  fail('URL');
}
async function getBuffer(url, options) {
  const response = await openResponse(url, options);
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > options.maxBytes) fail('SIZE'); chunks.push(Buffer.from(chunk)); }
  } catch (e) { if (e.updateCode) throw e; fail('NETWORK'); }
  return Buffer.concat(chunks);
}
/** ZIP downloads use bounded stream backpressure, never chunks + concat. */
async function downloadToFile(url, file, options) {
  const response = await openResponse(url, options);
  const hash = crypto.createHash('sha256'); let bytes = 0, created = false;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > options.maxBytes) { const error = new Error('SIZE'); error.updateCode = 'SIZE'; done(error); return; }
      hash.update(chunk); done(null, chunk);
    },
  });
  try {
    const fd = fs.openSync(file, 'wx', 0o600); created = true;
    const sink = fs.createWriteStream(file, { fd, autoClose: true, highWaterMark: 64 * 1024 });
    await pipeline(Readable.fromWeb(response.body), meter, sink, { signal: options.signal });
    return { bytes, sha256: hash.digest('hex') };
  } catch (e) {
    if (!response.body.locked) await response.body.cancel().catch(() => {});
    if (created) fs.rmSync(file, { force: true });
    if (e.updateCode) throw e;
    if (['EACCES', 'ENOSPC', 'EEXIST', 'EROFS', 'ENOENT'].includes(e.code)) fail('DOWNLOAD_IO');
    fail('NETWORK');
  }
}
function json(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('MANIFEST'); } }
function assetURL(repository, tag, name) { return `https://github.com/${repository}/releases/download/${tag}/${name}`; }
function findAsset(release, name, repository) {
  const assets = (Array.isArray(release.assets) ? release.assets : []).filter(a => a.name === name);
  if (assets.length !== 1 || assets[0].browser_download_url !== assetURL(repository, release.tag_name, name)) fail('ASSET');
  return assets[0];
}
function validateManifest(m, tag) {
  if (m?.schema !== 1 || m.product !== PRODUCT || m.platform !== 'darwin' || m.installerApi !== 1 || `v${m.version}` !== tag) fail('MANIFEST');
  version(m.version);
  if (!Array.isArray(m.supportedHarness) || m.supportedHarness.length < 1 || m.supportedHarness.length > 20 || !m.supportedHarness.every(v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(v) && v.length <= 64)) fail('MANIFEST');
  if (m.artifact?.name !== `${PRODUCT}-macos-v${m.version}.zip` || !/^[a-f0-9]{64}$/.test(m.artifact.sha256) || !Number.isInteger(m.artifact.bytes) || m.artifact.bytes < 1 || m.artifact.bytes > MAX_ZIP) fail('MANIFEST');
  return m;
}
async function check(options, deps = {}) {
  const source = readSource(options.root ?? ROOT);
  if (!source.enabled) return { status: 'disabled' };
  if (options.dryRun) return { status: 'dry-run' };
  if (!options.app) fail('APP');
  const info = (deps.appInfo ?? engine.appInfo)(options.app, { strict: false });
  const installed = currentVersion(options), signal = AbortSignal.timeout(15000);
  const request = (url, maxBytes) => getBuffer(url, { repository: source.repository, maxBytes, signal, fetchImpl: deps.fetchImpl });
  const list = json(await request(`https://api.github.com/repos/${source.repository}/releases?per_page=20`, 1024 * 1024));
  if (!Array.isArray(list) || list.length > 20) fail('MANIFEST');
  const releases = list.filter(r => r?.draft === false && r.prerelease === false && /^v\d+\.\d+\.\d+$/.test(r.tag_name ?? ''));
  releases.sort((a, b) => compare(b.tag_name.slice(1), a.tag_name.slice(1)));
  for (const release of releases) {
    if (compare(release.tag_name.slice(1), installed) <= 0) continue;
    if (!release.assets?.some(a => a.name === FEED)) continue;
    const feed = findAsset(release, FEED, source.repository);
    const m = validateManifest(json(await request(feed.browser_download_url, 65536)), release.tag_name);
    if (!m.supportedHarness.includes(info.version)) continue;
    const asset = findAsset(release, m.artifact.name, source.repository);
    if (asset.size !== m.artifact.bytes || (asset.digest && asset.digest !== `sha256:${m.artifact.sha256}`)) fail('ASSET');
    return { status: 'available', installed, harness: info.version, repository: source.repository, manifest: m, url: asset.browser_download_url,
      notes: typeof release.body === 'string' ? release.body.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, 1200) : '' };
  }
  return { status: info.version === engine.SUPPORTED ? 'up-to-date' : 'no-compatible', installed, harness: info.version };
}
// Validate names, types, sizes and matching local headers BEFORE extracting.
// ZIP64, links, traversal and oversized/duplicate entries are deliberately refused.
function inspectZip(bytes, expectedRoot) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ZIP || bytes.length < 22) fail('ZIP');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('ZIP');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count < 1 || count > 1000 || bytes.readUInt16LE(end + 8) !== count || start + size !== end) fail('ZIP');
  const names = new Set(); let at = start, total = 0;
  function checkExtra(begin, length) {
    const limit = begin + length; if (limit > bytes.length) fail('ZIP');
    while (begin < limit) {
      if (begin + 4 > limit) fail('ZIP');
      const type = bytes.readUInt16LE(begin), size = bytes.readUInt16LE(begin + 2);
      // Only timestamps/NTFS time metadata; no alternative paths, link modes,
      // ZIP64 sizes or Unicode-name overrides interpreted by extractors.
      if (![0x5855, 0x5455, 0x000a].includes(type) || begin + 4 + size > limit) fail('ZIP');
      begin += 4 + size;
    }
  }
  const roots = new Set(['plugin', 'tools', 'vendor', 'docs', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'release-manifest.json', 'update-source.json', '安装或更新.command', '检查安装.command', '回退上一版.command', '卸载.command', '检查更新.command']);
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail('ZIP');
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), packed = bytes.readUInt32LE(at + 20), unpacked = bytes.readUInt32LE(at + 24);
    const n = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), local = bytes.readUInt32LE(at + 42);
    if (at + 46 + n + extra + comment > end || (flags & 1) || ![0, 8].includes(method) || bytes.readUInt16LE(at + 34)) fail('ZIP');
    checkExtra(at + 46 + n, extra);
    let name; try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at + 46, at + 46 + n)); } catch { fail('ZIP'); }
    const parts = name.replace(/\/$/, '').split('/');
    if (name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || parts.some(p => !p || p === '.' || p === '..') || parts[0] !== expectedRoot || (parts.length > 1 && !roots.has(parts[1]))) fail('ZIP');
    const key = name.replace(/\/$/, ''); if (names.has(key)) fail('ZIP'); names.add(key);
    const mode = (bytes.readUInt32LE(at + 38) >>> 16) & 0xf000;
    if (mode && mode !== (name.endsWith('/') ? 0x4000 : 0x8000)) fail('ZIP');
    total += unpacked; if (total > 64 * 1024 * 1024 || unpacked > 8 * 1024 * 1024 || packed > bytes.length || local + 30 > start) fail('ZIP');
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 26) !== n) fail('ZIP');
    if (!bytes.subarray(local + 30, local + 30 + n).equals(bytes.subarray(at + 46, at + 46 + n))) fail('ZIP');
    const localExtra = bytes.readUInt16LE(local + 28), dataStart = local + 30 + n + localExtra;
    if (dataStart + packed > start) fail('ZIP');
    checkExtra(local + 30 + n, localExtra);
    let plain;
    try { plain = method === 0 ? bytes.subarray(dataStart, dataStart + packed) : zlib.inflateRawSync(bytes.subarray(dataStart, dataStart + packed), { maxOutputLength: unpacked + 1 }); }
    catch { fail('ZIP'); }
    if (plain.length !== unpacked || crc32(plain) !== bytes.readUInt32LE(at + 16)) fail('ZIP');
    at += 46 + n + extra + comment;
  }
  if (at !== end) fail('ZIP');
  return { entries: count, uncompressedBytes: total };
}
let crcTable;
function crc32(bytes) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : (n >>> 1); return n >>> 0; });
  let n = 0xffffffff;
  for (const value of bytes) n = crcTable[(n ^ value) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
function verifyExtracted(root, candidate) {
  let r, pkg; try { r = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'))); pkg = JSON.parse(fs.readFileSync(path.join(root, 'plugin/package.json'))); } catch { fail('PAYLOAD'); }
  if (r.version !== candidate.manifest.version || r.supportedHarness !== candidate.harness || pkg.name !== engine.ID || pkg.version !== r.version || JSON.stringify(Object.keys(r.files ?? {}).sort()) !== JSON.stringify(engine.FILES.map(f => `plugin/${f}`).sort())) fail('PAYLOAD');
  const files = [];
  function walk(dir) { for (const name of fs.readdirSync(dir)) { const p = path.join(dir, name), st = fs.lstatSync(p); if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) fail('PAYLOAD'); if (st.isDirectory()) walk(p); else files.push(p); } }
  walk(root);
  for (const f of engine.FILES) if (sha(fs.readFileSync(path.join(root, 'plugin', f))) !== r.files[`plugin/${f}`]) fail('PAYLOAD');
  for (const f of ['tools/installer.cjs', 'tools/entry.cjs', 'tools/launcher.sh', '回退上一版.command']) if (!fs.existsSync(path.join(root, f))) fail('PAYLOAD');
}
async function applyUpdate(candidate, options, deps = {}) {
  if (candidate.status !== 'available') fail('CANDIDATE');
  if (deps.confirmed !== true) fail('CONFIRMATION');
  if (!fs.existsSync(options.profileDir)) fail('PROFILE');
  if ((deps.running ?? engine.running)()) fail('RUNNING');
  if (compare(candidate.manifest.version, currentVersion(options)) <= 0) fail('NOT_NEWER');
  const source = readSource(options.root ?? ROOT);
  if (!source.enabled || source.repository !== candidate.repository || candidate.url !== assetURL(source.repository, `v${candidate.manifest.version}`, candidate.manifest.artifact.name)) fail('SOURCE');
  validateManifest(candidate.manifest, `v${candidate.manifest.version}`);
  const info = (deps.appInfo ?? engine.appInfo)(options.app, { strict: false });
  if (info.version !== candidate.harness || !candidate.manifest.supportedHarness.includes(info.version)) fail('COMPATIBILITY');
  const name = `${PRODUCT}-macos-v${candidate.manifest.version}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'side-chat-update-'));
  let cache, installed = false;
  try {
    const zip = path.join(tmp, 'release.zip'), unpack = path.join(tmp, 'unpack');
    const receipt = await downloadToFile(candidate.url, zip, { repository: source.repository, maxBytes: MAX_ZIP, signal: AbortSignal.timeout(60000), fetchImpl: deps.fetchImpl });
    if (receipt.bytes !== candidate.manifest.artifact.bytes || receipt.sha256 !== candidate.manifest.artifact.sha256) fail('CHECKSUM');
    inspectZip(fs.readFileSync(zip), name);
    if (cp.spawnSync('/usr/bin/ditto', ['-x', '-k', zip, unpack], { timeout: 20000, stdio: 'ignore' }).status !== 0) fail('ZIP');
    const root = path.join(unpack, name); verifyExtracted(root, candidate);
    if ((deps.running ?? engine.running)()) fail('RUNNING');
    const parent = path.join(options.profileDir, '.side-chat-installer', 'updates'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    cache = path.join(parent, `${candidate.manifest.version}-${crypto.randomUUID()}`); fs.cpSync(root, cache, { recursive: true });
    // Do not terminate a transactional installer midway through its writes.
    const result = (deps.installRunner ?? ((dir, opts) => cp.spawnSync(process.execPath, [path.join(dir, 'tools/installer.cjs'), 'install', '--home', opts.home, '--profile', opts.profile, '--app', opts.app], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })))(cache, options);
    if (result.status !== 0) fail('INSTALL');
    if (currentVersion(options) !== candidate.manifest.version) fail('INSTALL');
    installed = true;
    return { version: candidate.manifest.version, toolDirectory: cache };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); if (cache && !installed) fs.rmSync(cache, { recursive: true, force: true }); }
}
const MESSAGES = { DOWNLOAD_IO: '下载文件无法安全保存，已停止；未修改插件。', SOURCE: '更新来源未配置或格式不正确，未执行更新。', NETWORK: '暂时无法连接发布服务；未修改插件。', RATE_LIMIT: '发布服务暂时限制请求，请稍后重试。', MANIFEST: '发布信息格式不符合更新协议，已停止。', ASSET: '发布附件信息不一致，已停止。', URL: '下载地址不在固定发布来源范围，已停止。', SIZE: '发布文件超出允许大小，已停止。', VERSION: '版本格式无法识别，已停止。', INSTALLED_VERSION: '无法安全识别已安装插件的版本，已停止。', CHECKSUM: '下载文件校验失败，未运行安装。', ZIP: '下载压缩包的结构不安全或不受支持，未运行安装。', PAYLOAD: '解压后的运行文件校验失败，未运行安装。', RUNNING: '请先自行完全退出 Harness，再检查更新；不会强制退出。', PROFILE: '未找到桌面 profile，请先启动过一次 Harness。', APP: '未找到 Harness 应用。', ARGUMENT: '更新参数不正确。', CONFIRMATION: '尚未确认安装，未下载更新。', NOT_NEWER: '候选版本不高于当前版本，已停止。', COMPATIBILITY: 'Harness 版本已变化或不兼容，已停止。', INSTALL: '新版安装未完成；安装器会对自身事务失败执行恢复，请使用检查安装确认状态。' };
function message(error) { return MESSAGES[error.updateCode] ?? '更新检查未完成，未输出原始配置或网络错误。'; }
function show(result, log = console.log) {
  if (result.status === 'disabled') log('尚未配置 GitHub 发布仓库，联网检查保持关闭；没有发出网络请求。');
  else if (result.status === 'dry-run') log('更新预检结束；未联网、未下载、未修改插件。');
  else if (result.status === 'up-to-date') log('未发现更高版本的兼容更新。');
  else if (result.status === 'no-compatible') log(`暂未找到兼容 Harness ${result.harness} 的新版；不会强行安装。`);
  else { log(`发现兼容新版 ${result.manifest.version}（当前插件 ${result.installed}，Harness ${result.harness}）。`); if (result.notes) log(result.notes); }
}
async function confirmUpdate({ input = process.stdin, output = process.stdout, timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const rl = require('node:readline/promises').createInterface({ input, output });
  const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
  rl.on('SIGINT', () => controller.abort());
  rl.once('close', () => controller.abort());
  try {
    const answer = await rl.question('将下载并安装上述新版，旧版会备份。输入“更新”确认（两分钟内），直接回车取消：', { signal: controller.signal });
    return answer.trim() === '更新';
  } catch { return false; }
  finally { clearTimeout(timer); rl.close(); }
}
async function interactive(candidate, options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.log('请在交互终端运行“检查更新.command”确认安装；本次没有下载。'); return false; }
  if (engine.running()) { console.log(MESSAGES.RUNNING); return false; }
  if (!(await confirmUpdate())) { console.log('已取消或确认等待超时，没有下载或修改插件。'); return false; }
  const r = await applyUpdate(candidate, options, { confirmed: true });
  console.log(`已更新至 ${r.version}。新版安装/回退工具保存在本机：${r.toolDirectory}`);
  console.log('请自行重新打开 Harness；未来请优先使用该目录里的新版工具。');
  return true;
}
module.exports = { PRODUCT, FEED, compare, readSource, parseOptions, autoAllowed, setPreference, currentVersion, getBuffer, downloadToFile, confirmUpdate, check, validateManifest, inspectZip, verifyExtracted, applyUpdate, show, message, interactive };
