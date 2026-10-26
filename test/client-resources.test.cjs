'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '../plugin/lib/client.js'), 'utf8');
function mount(source = SOURCE) {
  const sets = [], maps = [], observers = [], cleanups = [], frames = new Map(), timers = new Map();
  let module, provider, usage, close, sequence = 0, rpcCalls = 0, retains = 0, releases = 0, bindingThrows = false, beforeRpc;
  class TrackedSet extends Set { constructor(...a) { super(...a); sets.push(this); } }
  class TrackedMap extends Map { constructor(...a) { super(...a); maps.push(this); } set(k, v) { if (typeof v?.getSnapshot === 'function' && typeof v?.subscribe === 'function') this.usageMap = true; return super.set(k, v); } }
  class Observer { constructor(callback) { this.callback = callback; this.active = false; observers.push(this); } observe() { this.active = true; } disconnect() { this.active = false; } }
  const sidebar = { isConnected: true }, body = {}, rootListeners = new Set();
  const section = () => {
    const s = { kind: 'section', isConnected: true, dataset: {}, style: { removeProperty() {}, setProperty() {} }, querySelector: () => null, querySelectorAll: () => [header] };
    return s;
  };
  let current = section(), header = { parentElement: current };
  const document = { body, head: { appendChild() {} }, createElement: () => ({ dataset: {}, remove() {} }), querySelector: () => sidebar, querySelectorAll: () => [header] };
  const snapshot = { ids: ['session-side-test'], byId: { 'session-side-test': { id: 'session-side-test', parentId: 'main', projectionValues: { agentPreset: 'side-chat' } } }, projectionsBySession: {} };
  const window = { confirm: () => true, alert() {}, __ModuleLoader__: { load(record) { module = record.factory(() => ({})); } } };
  vm.runInNewContext(source, { window, document, console: { warn() {} }, Set: TrackedSet, Map: TrackedMap, URL, URLSearchParams, MutationObserver: Observer,
    requestAnimationFrame(fn) { const id = ++sequence; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  const ctx = {
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); return off; }, on() { return () => {}; },
    sessions: { list: { getSnapshot: () => snapshot, subscribe(fn) { rootListeners.add(fn); return () => rootListeners.delete(fn); } },
      retain() { retains++; return { get binding() { if (bindingThrows) throw new Error('binding failed'); return {}; }, release() { releases++; } }; },
    },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [] }), subscribe: () => () => {} } },
    resources: { register(p) { provider = p; return () => {}; } }, sidebarRightTabs: { register: () => () => {} },
    slots: { inject(_name, fn) { return fn(); }, register(spec) { if (spec.id === 'side-usage') usage = spec; return () => {}; } },
    sidebarRight: { registerCloseHandler(_kind, fn) { close = fn; return () => {}; }, openResource() {} }, commandUi: {}, uiWorkspace: {},
    remote: { commands: { async execute() { rpcCalls++; const response = beforeRpc?.(); if (response) return response; return { ok: true, value: { result: { kind: 'success' } } }; } } },
  };
  module.apply(ctx);
  const flush = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  flush();
  return {
    replaceGroup() { current.isConnected = false; current = section(); header = { parentElement: current }; for (const o of observers) if (o.active) o.callback([]); flush(); },
    detachedRetained: () => sets.reduce((n, set) => n + [...set].filter(x => x?.kind === 'section' && !x.isConnected).length, 0),
    usage: id => usage.inject(id).hooks.sideUsage,
    cachedSources: () => maps.filter(m => m.usageMap).reduce((n, m) => n + m.size, 0),
    dispose() { for (const fn of cleanups.reverse()) fn(); },
    sourceListeners: () => rootListeners.size,
    retained: () => retains, released: () => releases,
    provider: () => provider,
    bindingFailure() { bindingThrows = true; },
    beforeRpc(fn) { beforeRpc = fn; },
    close() { close('main', { id: 'tab', contentId: 'dsh-resource://sidechat/session/session-side-test?main=main' }); },
    runTimers() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    rpcCalls: () => rpcCalls,
  };
}
function resourceProbe(source) {
  const f = mount(source);
  for (let i = 0; i < 100; i++) f.replaceGroup();
  for (let i = 0; i < 100; i++) { const s = f.usage(`main-${i}`), off = s.subscribe(() => {}); s.getSnapshot(); off(); }
  const result = { replacedGroups: 100, detachedSectionsRetained: f.detachedRetained(), visitedMainSessions: 100, usageSourcesRetained: f.cachedSources() };
  f.dispose(); result.rootSubscriptionsAfterDispose = f.sourceListeners(); return result;
}
module.exports = { mount, resourceProbe };
if (!process.env.SIDE_RESOURCE_PROBE_ONLY) {
test('replaced navigation groups and unsubscribed usage sources are released', () => {
  const r = resourceProbe(SOURCE); assert.equal(r.detachedSectionsRetained, 0); assert.equal(r.usageSourcesRetained, 0); assert.equal(r.rootSubscriptionsAfterDispose, 0);
});
test('usage source stays stable until last subscriber and releases idempotently', () => {
  const f = mount(); try {
    const s = f.usage('main'), a = s.subscribe(() => {}), b = s.subscribe(() => {});
    assert.equal(f.usage('main'), s); assert.equal(s.getSnapshot(), s.getSnapshot());
    a(); a(); assert.equal(f.usage('main'), s); b(); assert.notEqual(f.usage('main'), s);
  } finally { f.dispose(); }
});
test('aborting ownership handshake never retains a side session', async () => {
  const f = mount(), controller = new AbortController();
  try { f.beforeRpc(() => controller.abort()); const r = await f.provider().open('dsh-resource://sidechat/session/session-side-test?main=main', { signal: controller.signal }).next(); assert.equal(r.done, true); assert.equal(f.retained(), 0); } finally { f.dispose(); }
});
test('binding failure releases an already acquired reference', async () => {
  const f = mount(); try { f.bindingFailure(); await assert.rejects(f.provider().open('dsh-resource://sidechat/session/session-side-test?main=main', { signal: new AbortController().signal }).next()); assert.equal(f.released(), 1); } finally { f.dispose(); }
});
test('ownership availability race retries without retaining early', async () => {
  const f = mount(), controller = new AbortController(); let attempts = 0;
  try {
    f.beforeRpc(() => ++attempts === 1 ? { ok: false, error: { code: 'OPERATION_FAILED', message: 'not ready' } } : undefined);
    const stream = f.provider().open('dsh-resource://sidechat/session/session-side-test?main=main', { signal: controller.signal });
    const pending = stream.next(); await new Promise(setImmediate); assert.equal(f.retained(), 0);
    f.runTimers(); const frame = await pending; assert.equal(frame.value.ok, true); assert.equal(attempts, 2);
    controller.abort(); await stream.return(); assert.equal(f.released(), 1);
  } finally { f.dispose(); }
});
test('ownership rejection is a failure frame instead of an unhandled stream throw', async () => {
  const f = mount(); try {
    f.beforeRpc(() => ({ ok: true, value: { result: { kind: 'error', text: 'ownership refused' } } }));
    const frame = await f.provider().open('dsh-resource://sidechat/session/session-side-test?main=main', { signal: new AbortController().signal }).next();
    assert.equal(frame.value.ok, false); assert.equal(frame.value.error.code, 'SIDE_UNAVAILABLE'); assert.equal(f.retained(), 0);
  } finally { f.dispose(); }
});
test('plugin unload cancels deferred close RPC and its timer', async () => {
  const f = mount(); f.close(); f.dispose(); f.runTimers(); await Promise.resolve(); assert.equal(f.rpcCalls(), 0);
});

}
