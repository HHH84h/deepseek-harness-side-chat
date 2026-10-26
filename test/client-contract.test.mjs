import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(process.env.SIDE_CLIENT_FILE ?? new URL("../plugin/lib/client.js", import.meta.url), "utf8");
let failed = 0;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function mount(initial, refresh) {
  let module, tabType;
  let snapshot = initial;
  let refreshes = 0;
  const events = new Map();
  const opened = [];
  const window = { __ModuleLoader__: { load(record) { module = record.factory(() => ({})); } } };
  vm.runInNewContext(source, {
    window, console: { warn() {} }, URL,
    setTimeout(callback) { queueMicrotask(callback); return 0; }, clearTimeout() {},
  });
  const ctx = {
    effect: (fn) => fn(), on: (name, fn) => { events.set(name, fn); return () => {}; },
    remote: { commands: { execute: async () => ({ ok: true, value: { result: { kind: "success" } } }) } },
    resources: { register() {} },
    sidebarRightTabs: { register(type) { tabType = type; } },
    slots: { inject() {}, register() {} },
    sidebarRight: { registerCloseHandler() {}, openResource(address) { opened.push(address); } },
    sessions: {
      list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      async refreshProjections(id) {
        refreshes++;
        if (refresh) snapshot = refresh(snapshot, id);
      },
    },
    workspaces: { list: { getSnapshot: () => ({ phase: "ready", items: [] }), subscribe: () => () => {} } },
  };
  module.apply(ctx);
  return {
    opened,
    set(next) { snapshot = next; },
    run(main = "session-main") { events.get("command/executed")(main, "side", { kind: "success" }); },
    title: () => tabType.title("dsh-resource://sidechat/session/session-side"),
    refreshes: () => refreshes,
  };
}

/** One complete client snapshot in either public or legacy list shape. */
function state({ shape = "public", main = "session-main", side = "session-side", parent = main, binding = side, preset = "side-chat" } = {}) {
  const projectionsBySession = {
    [main]: { values: { sideChatBinding: { sideId: binding } } },
    [side]: { values: { agentPreset: preset } },
  };
  const byId = {
    [main]: { id: main },
    [side]: { id: side, parentId: parent, title: "侧聊标题" },
  };
  return shape === "public"
    ? { ids: [main, side], byId, projectionsBySession }
    : { items: [{ sessionId: side, parentSessionId: parent, title: "侧聊标题" }], projectionsBySession };
}

function check(name, ok) {
  if (!ok) failed++;
  console.log(JSON.stringify({ name, ok }));
}

for (const shape of ["public", "legacy"]) {
  const ui = mount(state({ shape }));
  ui.run();
  await settle();
  check(`${shape}.opens.bound.side`, ui.opened.length === 1 && ui.opened[0].includes("/session-side"));
  check(`${shape}.uses.fallback.title`, ui.title() === "侧边聊天");
}

const wrong = mount(state({ parent: "other-main" }));
wrong.run();
await settle();
check("public.rejects.wrong.parent", wrong.opened.length === 0);

const stale = mount(state({ binding: null }), (snapshot) => ({
  ...snapshot,
  projectionsBySession: {
    ...snapshot.projectionsBySession,
    "session-main": { values: { sideChatBinding: { sideId: "session-side" } } },
  },
}));
stale.run();
await settle();
check("public.refreshes.present.but.stale.binding", stale.refreshes() > 0 && stale.opened.length === 1);

console.log(JSON.stringify({ summary: { passed: 6 - failed, total: 6 } }));
process.exitCode = failed ? 1 : 0;
