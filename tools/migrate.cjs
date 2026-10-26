#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const engine = require('./installer.cjs');
function preflight(profile) {
  const p = engine.locations(profile);
  if (!fs.existsSync(profile) || !fs.statSync(profile).isDirectory()) throw new Error('未找到 profile；请先启动一次 Harness。');
  const pkg = fs.existsSync(p.package) ? JSON.parse(fs.readFileSync(p.package)) : {};
  if (pkg.dsh?.profile?.bundles?.includes(engine.ID)) throw new Error('原生插件已安装；如需恢复旧版，请先在 Harness 停用并卸载原生插件，再退出应用。');
  const dep = pkg.dependencies?.[engine.ID];
  if (dep !== undefined && dep !== `file:./plugins/${engine.ID}` && dep !== `file:plugins/${engine.ID}`) throw new Error('发现非旧版安装器管理的依赖，未修改；请先在插件管理器核对。');
  const st = fs.lstatSync(p.module, { throwIfNoEntry: false });
  if (st) {
    if (!st.isSymbolicLink() || path.resolve(path.dirname(p.module), fs.readlinkSync(p.module)) !== p.plugin) throw new Error('模块入口并非旧版插件链接，未修改。');
  }
  return p;
}
function migrate(options) {
  const p = preflight(options.profile);
  const result = engine.uninstall(options);
  if (result.changed) {
    const file = path.join(p.state, 'migration.json'), temp = `${file}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify({ schema: 1, backupId: result.backupId }) + '\n', { mode: 0o600 }); fs.renameSync(temp, file); }
    catch (error) { fs.rmSync(temp, { force: true }); engine.rollback(options); throw error; }
  }
  return { ...result, operation: 'migrate' };
}
function restore(options) {
  const p = preflight(options.profile), file = path.join(p.state, 'migration.json');
  if (!fs.existsSync(file)) throw new Error('没有迁移备份；未修改配置。');
  const record = JSON.parse(fs.readFileSync(file));
  const history = JSON.parse(fs.readFileSync(p.history));
  if (record.schema !== 1 || history.at(-1)?.id !== record.backupId || history.at(-1)?.operation !== 'uninstall') throw new Error('迁移后的安装历史已改变，停止恢复以保护当前配置。');
  const result = engine.rollback(options); fs.rmSync(file, { force: true });
  return { ...result, operation: 'restore' };
}
function cli(argv) {
  const action = argv.shift();
  if (!['migrate', 'restore'].includes(action)) throw new Error('请选择迁移旧版或恢复旧版。');
  const args = { home: path.join(os.homedir(), '.dsh'), profile: 'desktop', app: process.env.DSH_SIDE_APP, dryRun: false };
  while (argv.length) {
    const a = argv.shift();
    if (a === '--dry-run') args.dryRun = true;
    else if (['--home', '--profile', '--app'].includes(a) && argv[0] && !argv[0].startsWith('--')) args[a.slice(2)] = argv.shift();
    else throw new Error('参数无效。');
  }
  if (process.platform !== 'darwin') throw new Error('迁移工具仅支持 macOS。');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(args.profile)) throw new Error('profile 名称无效。');
  args.app ??= ['/Applications/DeepSeek Harness.app', path.join(os.homedir(), 'Applications/DeepSeek Harness.app')].find(fs.existsSync);
  if (!args.app) throw new Error('未找到 Harness；请先安装并启动一次。');
  engine.appInfo(args.app);
  if (engine.running()) throw new Error('请先自行完全退出 Harness 后重试；不会结束应用进程。');
  const options = { profile: path.join(path.resolve(args.home), 'profiles', args.profile) };
  preflight(options.profile);
  if (args.dryRun) { console.log('预检通过；未修改任何配置。'); return; }
  const result = action === 'migrate' ? migrate(options) : restore(options);
  console.log(action === 'migrate' ? result.changed ? '旧版已备份并移除。请启动 Harness，在「插件 → 添加插件」导入随附 .tgz。侧聊和其他插件数据已保留。' : '未检测到旧版安装，无需迁移。请直接导入 .tgz。' : '已恢复旧版；请自行启动 Harness。');
}
module.exports = { migrate, restore, preflight, cli };
if (require.main === module) { try { cli(process.argv.slice(2)); } catch (e) { console.error(/^(原生插件|发现非|模块入口|没有迁移|迁移后的|请选择|参数无效|迁移工具|profile 名称|未找到|请先|此安装包|所选应用|无法读取|配置|本插件)/.test(e.message) ? `操作未完成：${e.message}` : `操作未完成：本地检查或文件操作失败（${e.code ?? 'UNKNOWN'}）；未输出配置原文。`); process.exitCode = 1; } }
