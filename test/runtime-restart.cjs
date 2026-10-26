'use strict';
const path = require('node:path');
const { prepare, addDriver, run } = require('./runtime-smoke.cjs');
async function group(phases) {
  const f = prepare();
  try {
    addDriver(f);
    const rows = [];
    for (const phase of phases) {
      const r = await run(f, { DSH_SIDE_PHASE: phase, ...(phase === '6' ? { DSH_SIDE_CONTEXT_BARRIER: path.join(f.home, 'barrier') } : {}) });
      const record = r.reports.findLast(x => String(x.phase) === phase);
      const passed = r.passed && record && (record.exit === undefined || record.exit === 0);
      rows.push({ phase, passed: Boolean(passed), ...(phase === '6' ? { exact: record?.exact, references: record?.refs, questions: record?.questions } : {}) });
      if (!passed) break;
    }
    return rows;
  } finally { f.cleanup(); }
}
async function main() {
  const phases = [...await group(['1', '2', '3']), ...await group(['6']), ...await group(['7a', '7b'])];
  const state = [];
  for (const mode of ['corrupt', 'migration', 'writefail']) {
    const f = prepare();
    try {
      addDriver(f);
      const r = await run(f, { DSH_SIDE_STATE_TEST: mode });
      const summary = r.reports.findLast(x => x.stateTest === 'summary');
      state.push({ mode, passed: r.passed && summary?.passed === true });
    } finally { f.cleanup(); }
  }
  const passed = phases.length === 6 && phases.every(x => x.passed) && state.every(x => x.passed);
  console.log(JSON.stringify({ passed, phases, state }, null, 2));
  if (!passed) process.exitCode = 1;
}
if (require.main === module) main().catch(() => { console.error('隔离重启测试未完成；没有输出原始日志。'); process.exitCode = 1; });
