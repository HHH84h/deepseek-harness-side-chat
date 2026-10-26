'use strict';
const cp = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitBounded(promise, ms) {
  let timer;
  try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
}
/** Own one process group; never match or kill processes by an application name. */
function spawnOwned(command, args, options = {}) {
  const grouped = process.platform !== 'win32';
  const child = cp.spawn(command, args, { ...options, detached: grouped });
  let done = false, stopping, spawnError;
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = error.code ?? 'spawn-error'; });
    child.once('close', (code, signal) => { done = true; resolve({ code, signal, spawnError }); });
  });
  const signal = value => {
    if (!child.pid) return;
    try { if (grouped) process.kill(-child.pid, value); else if (!done) child.kill(value); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  async function stop(graceMs = 1500) {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!done) {
        signal('SIGTERM');
        await waitBounded(closed, graceMs);
        if (!done) signal('SIGKILL');
        await waitBounded(closed, graceMs);
      }
      // A browser/server can leave children after the leader exits. The group
      // was created here and exists only for this disposable test run.
      if (grouped && child.pid) { signal('SIGTERM'); await sleep(25); signal('SIGKILL'); }
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
      if (!done) throw new Error('owned process did not close');
      return closed;
    })();
    return stopping;
  }
  const onInterrupt = () => { process.exitCode = 130; void stop().catch(() => { process.exitCode = 1; }); };
  const onTerminate = () => { process.exitCode = 143; void stop().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  return { child, closed, stop, get isClosed() { return done; } };
}
module.exports = { spawnOwned };
