'use strict';
const cp = require('node:child_process');
const path = require('node:path');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
let failed = false;
for (const file of ['client.test.mjs', 'client-contract.test.mjs']) {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, file)], { cwd: ROOT, stdio: 'inherit', timeout: 30000 });
  if (r.status !== 0) failed = true;
}
let cordis = process.env.DSH_CORDIS_MODULE;
if (!cordis && process.env.DSH_CLI) {
  try {
    const fs = require('node:fs');
    let dir = path.dirname(fs.realpathSync(process.env.DSH_CLI));
    while (dir !== path.dirname(dir)) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg)).name === '@deepseek-ai/dsh') {
        cordis = createRequire(pkg).resolve('@deepseek-ai/cordis'); break;
      }
      dir = path.dirname(dir);
    }
  } catch { /* Report unavailable instead of implying an integration pass. */ }
}
if (cordis) {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'client-injection.test.mjs')], {
    cwd: ROOT, stdio: 'inherit', timeout: 30000, env: { ...process.env, DSH_CORDIS_MODULE: cordis },
  });
  if (r.status !== 0) failed = true;
} else console.log(JSON.stringify({ suite: 'real-cordis', skipped: true, reason: 'Set DSH_CLI or DSH_CORDIS_MODULE to a compatible local runtime.' }));
process.exitCode = failed ? 1 : 0;
