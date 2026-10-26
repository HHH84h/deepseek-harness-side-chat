'use strict';
const updater = require('./updater.cjs');
const engine = require('./installer.cjs');
async function main(argv) {
  const mode = argv.shift(), options = updater.parseOptions([...argv]);
  if (mode === 'update') {
    if (process.platform !== 'darwin') throw new Error('此更新器仅支持 macOS。');
    if (options.autoCheck !== undefined) {
      updater.setPreference(options);
      console.log(options.autoCheck ? '已允许安装工具启动时检查更新；发布来源未配置时仍不联网。' : '已关闭安装工具的自动检查；仍可手动检查更新。'); return;
    }
    const result = await updater.check(options); updater.show(result);
    if (result.status === 'available') await updater.interactive(result, options);
    return;
  }
  if (['install', 'doctor'].includes(mode) && !options.dryRun) {
    let result;
    try {
      const source = updater.readSource();
      if (updater.autoAllowed(options, source)) {
        result = await updater.check(options); updater.show(result);
      }
    } catch (error) { console.log(updater.message(error)); }
    // A failed confirmed update must not fall through to installing this older
    // bundle after the new transaction has restored the previous state.
    if (result?.status === 'available' && mode === 'install') { await updater.interactive(result, options); return; }
  }
  engine.cli([mode, ...argv]);
}
module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.updateCode ? updater.message(error) : engine.safeMessage(error)); process.exitCode = 1; });
