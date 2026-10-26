#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { scan } = require('./privacy.cjs');
const ROOT = path.resolve(__dirname, '..');
const { VERSION, SUPPORTED, FILES } = require('../tools/installer.cjs');
const SOURCE = ['plugin', 'tools', 'vendor', 'scripts', 'test', 'docs', '.github', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', '.gitignore', 'release-manifest.json', 'update-source.json', '检查更新.command', '安装或更新.command', '检查安装.command', '回退上一版.command', '卸载.command'];
const RELEASE = ['plugin', 'tools', 'vendor', 'docs', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'release-manifest.json', 'update-source.json', '检查更新.command', '安装或更新.command', '检查安装.command', '回退上一版.command', '卸载.command'];
const RELEASE_TOOLS = ['entry.cjs', 'installer.cjs', 'launcher.sh', 'updater.cjs'];
const RELEASE_DOCS = ['双击安装使用说明.md', '更新功能说明.md', '验收与隐私报告.md', 'GITHUB发布指南.md', 'assets/side-chat-demo.png'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function manifest() {
  const files = Object.fromEntries(FILES.map(file => [`plugin/${file}`, hash(fs.readFileSync(path.join(ROOT, 'plugin', file)))]));
  fs.writeFileSync(path.join(ROOT, 'release-manifest.json'), JSON.stringify({ version: VERSION, supportedHarness: SUPPORTED, files }, null, 2) + '\n');
}
function build(out) {
  out = path.resolve(out);
  if (out === ROOT || out.startsWith(ROOT + path.sep)) throw new Error('请把构建输出放到源码目录之外，例如 ../dist；避免把生成物混入待发布源码。');
  manifest();
  const result = scan(ROOT);
  if (!result.passed) throw new Error(`隐私扫描失败：${JSON.stringify(result.findings)}`);
  fs.mkdirSync(out, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'side-chat-release-'));
  const results = [];
  try {
    for (const [kind, list] of [['macos', RELEASE], ['source', SOURCE]]) {
      const name = `deepseek-harness-side-chat-${kind}-v${VERSION}`;
      const stage = path.join(tmp, name); fs.mkdirSync(stage);
      for (const file of list) {
        if (kind === 'macos' && file === 'tools') {
          fs.mkdirSync(path.join(stage, 'tools'));
          for (const name of RELEASE_TOOLS) fs.copyFileSync(path.join(ROOT, 'tools', name), path.join(stage, 'tools', name));
        } else if (kind === 'macos' && file === 'docs') {
          for (const name of RELEASE_DOCS) {
            const destination = path.join(stage, 'docs', name);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(path.join(ROOT, 'docs', name), destination);
          }
        } else fs.cpSync(path.join(ROOT, file), path.join(stage, file), { recursive: true });
      }
      for (const file of list.filter(f => f.endsWith('.command'))) fs.chmodSync(path.join(stage, file), 0o755);
      fs.chmodSync(path.join(stage, 'tools/launcher.sh'), 0o755);
      const check = scan(stage); if (!check.passed) throw new Error('分发白名单扫描失败。');
      const zip = path.join(out, `${name}.zip`);
      const r = cp.spawnSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', stage, zip], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error('ZIP 构建失败。');
      const unpack = path.join(tmp, `unpack-${kind}`);
      const extract = cp.spawnSync('/usr/bin/ditto', ['-x', '-k', zip, unpack], { encoding: 'utf8' });
      if (extract.status !== 0) throw new Error('ZIP 解压校验失败。');
      const unpacked = path.join(unpack, name), inspected = scan(unpacked);
      if (!inspected.passed) throw new Error('ZIP 解压后的隐私扫描失败。');
      for (const file of list.filter(f => f.endsWith('.command'))) if (!(fs.statSync(path.join(unpacked, file)).mode & 0o111)) throw new Error('ZIP 未保留双击脚本执行权限。');
      results.push({ name: path.basename(zip), sha256: hash(fs.readFileSync(zip)), files: inspected.fileCount, privacy: 'PASS' });
    }
    fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), results.map(r => `${r.sha256}  ${r.name}`).join('\n') + '\n');
    const macos = results.find(r => r.name.includes('-macos-'));
    fs.writeFileSync(path.join(out, 'side-chat-update.json'), JSON.stringify({ schema: 1, product: 'deepseek-harness-side-chat', version: VERSION, platform: 'darwin', installerApi: 1, supportedHarness: [SUPPORTED], artifact: { name: macos.name, sha256: macos.sha256, bytes: fs.statSync(path.join(out, macos.name)).size } }, null, 2) + '\n');
    return results;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
module.exports = { manifest, build, SOURCE, RELEASE, RELEASE_TOOLS, RELEASE_DOCS };
if (require.main === module) {
  const at = process.argv.indexOf('--out');
  const out = path.resolve(at < 0 ? path.join(ROOT, '..', 'dist') : process.argv[at + 1]);
  try { console.log(JSON.stringify(build(out), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
