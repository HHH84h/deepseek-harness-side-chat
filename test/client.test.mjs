import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../plugin/lib/client.js", import.meta.url), "utf8");
let captured;
globalThis.window = { __ModuleLoader__: { load: (record) => { captured = record; } } };
globalThis.document = { head: { appendChild() {} }, createElement: () => ({ dataset: {}, textContent: "", remove() {} }) };
const React = { createElement: (t, p, ...c) => ({ t, p, c }), useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
new Function("require", source)((id) => (id === "react" ? React : {}));
const mod = captured.factory((id) => (id === "react" ? React : {}));

const opened = [];
const closeCalls = [];
const alerts = [];
let closeHandler;
const executedHandlers = [];
let executeImpl = async () => ({ ok: true, value: { result: { kind: "success" } } });
let items = [];
let projections = {};
globalThis.window.confirm = () => true;
globalThis.window.alert = (text) => alerts.push(text);

const ctx = {
	effect: (fn) => { fn(); return () => {}; },
	on: (name, fn) => { if (name === "command/executed") executedHandlers.push(fn); return () => {}; },
	remote: { $on: () => () => {}, commands: { execute: (...args) => executeImpl(...args) } },
	resources: { register: () => ({}) }, sidebarRightTabs: { register: () => ({}) },
	slots: { inject: (n, fn) => fn(), register: () => ({}) },
	sidebarRight: {
		registerCloseHandler: (kind, fn) => { closeHandler = fn; return () => {}; },
		mounted: { getSnapshot: () => "session-main-1" },
		openResource: (a) => opened.push(a),
		close: (id) => closeCalls.push(id),
	},
	commandUi: { register: () => ({}) },
	sessions: {
		list: { getSnapshot: () => ({ items, projectionsBySession: projections }), subscribe: () => () => {} },
		refreshProjections: async (id) => {
			projections[id] = { values: { ...(projections[id]?.values ?? {}), agentPreset: "side-chat", sideChatBinding: { sideId: "session-side-lag" } } };
		},
		retain: () => ({ release() {} }), using: () => Promise.resolve(),
	},
	uiWorkspace: { forkSession: async () => "x", archiveSession: async () => {} },
};
mod.apply(ctx);
const check = (id, ok, detail) => { console.log(JSON.stringify({ id, ok, detail })); if (!ok) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const side = (id, main, at) => ({ sessionId: id, parentSessionId: main, updatedAt: at ?? 1 });
const exec = (main) => executedHandlers[0](main, "side", { kind: "success" });
const preset = (id, value) => {
	projections[id] = { ...(projections[id] ?? { values: {} }), values: { ...(projections[id]?.values ?? {}), agentPreset: value } };
};
const binding = (main, sideId) => {
	projections[main] = { values: { ...(projections[main]?.values ?? {}), sideChatBinding: { sideId } } };
};

// 1. New side resolved by the agentPreset projection.
items = [side("session-side-new", "main-1")]; preset("session-side-new", "side-chat"); binding("main-1", "session-side-new");
exec("main-1"); await sleep(100);
check("client.new.id", opened.at(-1)?.includes("session-side-new") === true, JSON.stringify(opened));

// 2. Unrelated child (fork) is never selected.
opened.length = 0;
items = [side("session-fork", "main-2")]; preset("session-fork", "standard"); binding("main-2", "session-fork");
exec("main-2"); await sleep(400);
check("client.unrelated.ignored", opened.length === 0, `opened=${opened.length}`);

// 3. Reload/reuse: no new notification, existing side still opens.
opened.length = 0;
items = [side("session-side-existing", "main-3")]; preset("session-side-existing", "side-chat"); binding("main-3", "session-side-existing");
exec("main-3"); await sleep(100);
check("client.reload.reuse", opened.at(-1)?.includes("session-side-existing") === true, JSON.stringify(opened));

// 4. Old deleted + new created: only the new id is in the list, it is chosen.
opened.length = 0;
items = [side("session-side-old", "main-4", 999), side("session-side-fresh", "main-4", 1)];
preset("session-side-old", "side-chat"); preset("session-side-fresh", "side-chat"); binding("main-4", "session-side-fresh");
exec("main-4"); await sleep(100);
check("client.never.old", opened.at(-1)?.includes("session-side-fresh") === true, JSON.stringify(opened));

// 5. Projection lag: refreshProjections supplies the preset, then opens.
opened.length = 0;
items = [side("session-side-lag", "main-5")]; projections = {};
exec("main-5"); await sleep(300);
check("client.projection.refresh", opened.at(-1)?.includes("session-side-lag") === true, JSON.stringify(opened));

// 6. Close: tab closes first (release), one RPC per tab, failure reopens.
let rpc = 0;
let resolveRpc;
executeImpl = () => { rpc += 1; return new Promise((resolve) => { resolveRpc = resolve; }); };
const tab = { id: "tab-1", contentId: "dsh-resource://sidechat/session/session-side-lag" };
let threw = false;
try { closeHandler("main-1", tab); } catch { threw = true; }
check("client.close.allows", threw === false, "close proceeds");
closeHandler("main-1", tab); // duplicate click before the deferred RPC
await sleep(120);
check("client.close.single.rpc", rpc === 1, `rpc=${rpc}`);
resolveRpc({ ok: true, value: { result: { kind: "success" } } });
await sleep(50);
check("client.close.success.no.reclose", closeCalls.length === 0 && alerts.length === 0, `close=${closeCalls.length}`);

let rejectRpc;
executeImpl = () => { rpc += 1; return new Promise((_, reject) => { rejectRpc = reject; }); };
const tab2 = { id: "tab-2", contentId: "dsh-resource://sidechat/session/session-old" };
closeHandler("main-1", tab2);
await sleep(120);
rejectRpc(new Error("injected"));
await sleep(50);
check("client.close.failure.reported", alerts.length === 1 && String(alerts[0]).startsWith("侧聊删除失败：") && (String(alerts[0]).match(/侧聊删除失败/g) ?? []).length === 1, JSON.stringify(alerts));
check("client.close.failure.no.reopen", !opened.some((a) => a.includes("session-old")), JSON.stringify(opened.slice(-1)));
