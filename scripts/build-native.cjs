#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { scan } = require('./privacy.cjs');
const ROOT = path.resolve(__dirname, '..');
const SOURCE = ['plugin', 'tools', 'vendor', 'scripts', 'test', 'docs', '.github', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', '.gitignore', 'release-manifest.json', 'update-source.json', '迁移旧版.command', '恢复旧版.command', '安装或更新.command', '检查安装.command', '回退上一版.command', '卸载.command', '检查更新.command'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const run = (cmd, args, cwd) => { const r = cp.spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`构建操作失败：${path.basename(cmd)}`); return r.stdout; };
function build(out) {
  if (!JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/package.json'), 'utf8')).dsh?.bundle?.patch) throw new Error('此源码是双击安装版，请运行 npm run build；原生包请使用独立的原生发行源码。');
  out = path.resolve(out); if (out === ROOT || out.startsWith(ROOT + path.sep)) throw new Error('输出必须位于源码目录之外。');
  const { VERSION, SUPPORTED, FILES } = require('../tools/installer.cjs');
  fs.writeFileSync(path.join(ROOT, 'release-manifest.json'), JSON.stringify({ version: VERSION, supportedHarness: SUPPORTED, files: Object.fromEntries(FILES.map(f => [`plugin/${f}`, sha(path.join(ROOT, 'plugin', f))])) }, null, 2) + '\n');
  const before = scan(ROOT); if (!before.passed) throw new Error(`源码隐私检查未通过：${JSON.stringify(before.findings)}`);
  fs.mkdirSync(out, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'side-native-build-'));
  const artifacts = [], scans = [];
  try {
    const pack = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--cache', path.join(tmp, 'npm-cache'), '--pack-destination', tmp], path.join(ROOT, 'plugin')))[0];
    if (pack.files.map(f => f.path).sort().join('\n') !== [...FILES].sort().join('\n')) throw new Error('原生插件白名单不一致。');
    const tgz = path.join(out, pack.filename); fs.copyFileSync(path.join(tmp, pack.filename), tgz); artifacts.push(tgz);
    const unpack = path.join(tmp, 'unpack'); fs.mkdirSync(unpack);
    run('/usr/bin/tar', ['-xzf', tgz, '-C', unpack]);
    const nativeScan = scan(path.join(unpack, 'package'), { native: true }); if (!nativeScan.passed) throw new Error('解压插件隐私检查失败。'); scans.push({ kind: 'native-package', passed: true, files: nativeScan.fileCount });
    const sourceName = `deepseek-harness-side-chat-source-v${VERSION}`;
    const source = path.join(tmp, sourceName); fs.mkdirSync(source);
    for (const file of SOURCE) fs.cpSync(path.join(ROOT, file), path.join(source, file), { recursive: true });
    const sourceScan = scan(source); if (!sourceScan.passed) throw new Error('源码白名单检查失败。');
    const sourceZip = path.join(out, `${sourceName}.zip`); run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', source, sourceZip]); artifacts.push(sourceZip);
    const sourceUnpack = path.join(tmp, 'source-unpack'); run('/usr/bin/ditto', ['-x', '-k', sourceZip, sourceUnpack]);
    const extractedScan = scan(path.join(sourceUnpack, sourceName)); if (!extractedScan.passed) throw new Error('解压源码隐私检查失败。'); scans.push({ kind: 'source-zip', passed: true, files: extractedScan.fileCount });
    const migration = path.join(tmp, `旧版迁移与恢复-v${VERSION}`); fs.mkdirSync(migration);
    for (const file of ['tools/installer.cjs', 'tools/migrate.cjs', 'tools/migrate-launcher.sh', '迁移旧版.command', '恢复旧版.command', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      const dest = path.join(migration, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(ROOT, file), dest);
    }
    fs.cpSync(path.join(ROOT, 'vendor'), path.join(migration, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(migration, 'README.md'), '仅旧脚本安装用户需要迁移。完全退出 Harness 后双击「迁移旧版.command」，再通过插件管理器导入 .tgz。\n恢复：先卸载原生插件并退出应用，再双击「恢复旧版.command」。\n迁移和恢复均保留侧聊数据及其他插件配置。备份仅存本机，不应上传。\n');
    for (const f of ['迁移旧版.command', '恢复旧版.command', 'tools/migrate-launcher.sh']) fs.chmodSync(path.join(migration, f), 0o755);
    const migrationZip = path.join(out, `side-chat-migration-macos-v${VERSION}.zip`); run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', migration, migrationZip]); artifacts.push(migrationZip);
    const migrationUnpack = path.join(tmp, 'migration-unpack'); run('/usr/bin/ditto', ['-x', '-k', migrationZip, migrationUnpack]);
    const migrationScan = scan(path.join(migrationUnpack, path.basename(migration))); if (!migrationScan.passed) throw new Error('解压迁移工具隐私检查失败。'); scans.push({ kind: 'migration-zip', passed: true, files: migrationScan.fileCount });
    const feed = path.join(out, 'side-chat-plugin-update.json'); fs.writeFileSync(feed, JSON.stringify({ schema: 1, product: 'deepseek-harness-side-chat', packageName: 'dsh-client-ui-side', format: 'harness-bundle', platform: 'darwin', version: VERSION, supportedHarness: [SUPPORTED], artifact: { name: path.basename(tgz), sha256: sha(tgz), bytes: fs.statSync(tgz).size } }, null, 2) + '\n'); artifacts.push(feed);
    fs.writeFileSync(path.join(out, '隐私检查结果.json'), JSON.stringify({ passed: true, source: { passed: true, files: before.fileCount }, archives: scans, findings: [] }, null, 2) + '\n');
    fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), artifacts.map(f => `${sha(f)}  ${path.basename(f)}`).join('\n') + '\n');
    return artifacts.map(f => ({ name: path.basename(f), bytes: fs.statSync(f).size, sha256: sha(f) }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
module.exports = { build, SOURCE };
if (require.main === module) { try { const at = process.argv.indexOf('--out'); console.log(JSON.stringify(build(at === -1 ? path.join(ROOT, '../native-dist') : process.argv[at + 1]), null, 2)); } catch (e) { console.error(e.message); process.exitCode = 1; } }
