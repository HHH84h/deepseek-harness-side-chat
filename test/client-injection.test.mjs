import { readFileSync } from "node:fs";
import vm from "node:vm";
const { Context, symbols } = await import(process.env.DSH_CORDIS_MODULE ?? "@deepseek-ai/cordis");
const source = readFileSync(process.env.SIDE_CLIENT_FILE ?? new URL("../plugin/lib/client.js", import.meta.url), "utf8");
let plugin, closeHandler;
let calls = 0, closes = 0;
const alerts = [];
const window = {
  confirm: () => true, alert: (text) => alerts.push(text),
  __ModuleLoader__: { load(record) { plugin = record.factory(() => ({})); } },
};
vm.runInNewContext(source, { window, console, URL, URLSearchParams, setTimeout, clearTimeout });
const root = new Context();
const noop = () => () => {};
const remote = {};
Object.defineProperty(remote, symbols.tracker, { value: { associate: "remote" } });
const services = {
  commandUi: {}, resources: { register: noop },
  sessions: { list: { getSnapshot: () => ({ ids: [], byId: {}, projectionsBySession: {} }), subscribe: noop } },
  workspaces: { list: { getSnapshot: () => ({ phase: "ready", items: [] }), subscribe: noop } },
  slots: { inject: noop }, uiWorkspace: {}, sidebarRightTabs: { register: noop },
  sidebarRight: {
    registerCloseHandler(_kind, callback) { closeHandler = callback; return () => {}; },
    close() { closes++; },
  },
  remote,
};
for (const [name, value] of Object.entries(services)) root.reflect.provide(name, value);
try {
  const provider = root.plugin({ name: "commands-provider", apply(ctx) {
    ctx.reflect.provide("remote.commands", { async execute() {
      calls++;
      return { ok: true, value: { result: { kind: "success" } } };
    } });
  } });
  await provider.await();
  const fiber = root.plugin({ name: "side-client-injection-test", inject: plugin.inject, apply: plugin.apply });
  await fiber.await();
  if (typeof closeHandler !== "function") throw new Error("client plugin did not activate");
  try { closeHandler("main", { id: "side-tab", contentId: "dsh-resource://sidechat/session/session-side-test" }); } catch {}
  // The close handler defers the RPC until after the tab has unmounted so its
  // Session retain is released before the Host disposes the Agent.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const ok = calls === 1 && closes === 0 && alerts.length === 0;
  console.log(JSON.stringify({ test: "real-cordis.close-can-call-remote-commands", ok, calls, closes, alerts }));
  process.exitCode = ok ? 0 : 1;
} finally {
  await root.fiber.dispose();
}
