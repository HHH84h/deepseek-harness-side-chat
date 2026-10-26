/** Multi-process restart/barrier driver; test-only. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userMessage } from "../../plugin/lib/host.js";
import { report } from "./util.js";

export async function runPhase(ctx, api) {
	const { readFileSync: read, writeFileSync: write } = await import("node:fs");
	const { join: j } = await import("node:path");
	const home = process.env.DSH_HOME ?? j(process.env.HOME ?? "/tmp", ".dsh");
	const dir = j(home, "side-chat");
	const stateFile = j(dir, "phase.json");
	const readState = () => JSON.parse(read(stateFile, "utf8"));
	const writeState = (value) => write(stateFile, JSON.stringify(value));
	const phase = process.env.DSH_SIDE_PHASE;
	const selection = ctx.get("agentDefaultModel")?.currentSelection();
	const makeMain = async (mainId) => {
		for (let attempt = 0; attempt < 60; attempt += 1) {
			try {
				return (
					await ctx.agents.create({
						sessionId: mainId,
						meta: { cwd: process.cwd() },
						...(selection === void 0 ? {} : { agentOptions: selection }),
					})
				).agent;
			} catch (error) {
				const message = String(error?.message ?? error);
				if (/no agent factory/.test(message)) {
					await new Promise((resolve) => setTimeout(resolve, 250));
					continue;
				}
				if (/already exists/.test(message)) {
					const resumed = await ctx.agents.resume({
						resumeSessionId: mainId,
						...(selection === void 0 ? {} : { agentOptions: selection }),
					});
					return resumed.agent;
				}
				throw error;
			}
		}
		throw new Error("agent factory never registered");
	};

	if (phase === "1") {
		const mainId = `session-phase-main-${Date.now()}`;
		const main = await makeMain(mainId);
		const result = await ctx.commands.execute(main, "/side SIDE-ONLY-A", [], new AbortController().signal);
		const sideId = api.activeSideId(mainId);
		await ctx.agents.get(sideId)?.whenIdle();
		// This driver exits abruptly instead of closing the host normally. Drain
		// both sessions first, including the otherwise blank main's binding.
		await ctx.sessions.flush(main.session);
		const side = ctx.agents.get(sideId);
		if (side !== void 0) await ctx.sessions.flush(side.session);
		writeState({ mainId, sideId, phase: 1 });
		report({ phase: 1, mainId, sideId, result: result?.result?.kind ?? null, exit: 0 });
		process.exit(0);
	}

	if (phase === "2") {
		await api.awaitAdoptions();
		const state = readState();
		const resumed = await ctx.agents.resume({
			resumeSessionId: state.mainId,
			...(selection === void 0 ? {} : { agentOptions: selection }),
		});
		const adoptedAtBoot = api.hasHandle(state.sideId) === true;
		const before = api.activeSideId(state.mainId);
		const asked = await ctx.commands.execute(resumed.agent, "/side SIDE-CONTINUE", [], new AbortController().signal);
		await ctx.agents.get(state.sideId)?.whenIdle();
		const closed = await ctx.commands.execute(resumed.agent, `/side --close ${state.sideId}`, [], new AbortController().signal);
		const root = j(home, "sessions");
		const { readdirSync, existsSync } = await import("node:fs");
		const dirs = existsSync(root) ? readdirSync(root).filter((b) => existsSync(j(root, b, state.sideId))) : [];
		const cache = j(home, "storages", "session_projcache", "sessions", `${state.sideId}.json`);
		writeState({ ...state, phase: 2, closed: closed?.result?.kind === "success" });
		report({
			phase: 2,
			mainId: state.mainId,
			sideId: state.sideId,
			adoptedAtBoot,
			activeBefore: before,
			activeAfter: api.activeSideId(state.mainId) ?? null,
			asked: asked?.result?.kind ?? null,
			closed: closed?.result?.kind ?? null,
			dirs: dirs.length,
			cache: existsSync(cache),
			exit: closed?.result?.kind === "success" && dirs.length === 0 && !existsSync(cache) ? 0 : 1,
		});
		process.exit(closed?.result?.kind === "success" && dirs.length === 0 && !existsSync(cache) ? 0 : 1);
	}

	if (phase === "5") {
		await api.awaitAdoptions();
		const state = readState();
		const main = await makeMain(state.mainId);
		const registry = ctx.get("workspaceRegistry");
		const owner = (await registry.list()).find((workspace) => workspace.sessionIds.includes(state.mainId));
		if (owner === void 0) { report({ phase: 5, error: "main not in a workspace" }); return; }
		await owner.detachSession(state.mainId);
		const after = (await registry.list()).find((workspace) => workspace.id === owner.id);
		report({ phase: 5, mainId: state.mainId, workspaceId: owner.id, sessionIds: after?.sessionIds ?? [], accounted: after?.sessionIds.includes(state.mainId) === true });
		return;
	}

	if (phase === "6") {
		await api.awaitAdoptions();
		const fs = await import("node:fs");
		const { randomUUID } = await import("node:crypto");
		const barrier = j(home, "barrier");
		fs.rmSync(barrier, { recursive: true, force: true });
		fs.mkdirSync(barrier, { recursive: true });
		const mainId = `session-phase-main-${randomUUID()}`;
		const main = await makeMain(mainId);
		const original = `ORIGINAL-${randomUUID()}`;
		const late = `LATE-${randomUUID()}`;
		const question = `QUESTION-${randomUUID()}`;
		await ctx.commands.execute(main, "/side", [], new AbortController().signal);
		const sideId = api.activeSideId(mainId);
		const side = sideId === void 0 ? void 0 : ctx.agents.get(sideId);
		if (side === void 0) { report({ phase: 6, error: "fresh side missing", sideId }); process.exit(1); }
		await side.whenIdle();
		main.followup(userMessage(original));
		await main.whenIdle();
		side.followup(userMessage(question));
		let paused = false;
		for (let i = 0; i < 160 && !paused; i += 1) {
			paused = fs.existsSync(j(barrier, "paused.json"));
			if (!paused) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!paused) { report({ phase: 6, error: "barrier never paused" }); process.exit(1); }
		const saved = fs.readFileSync(j(barrier, "snapshot.txt"), "utf8");
		const pre = { hasOriginal: saved.includes(original), hasLate: saved.includes(late) };
		side.cancel();
		fs.writeFileSync(j(barrier, "release"), "");
		await side.whenIdle().catch(() => void 0);
		let refsInLog = 0;
		let records = 0;
		for (let seq = 0; seq < (side.session.seq ?? 0); seq += 1) {
			const event = side.session.eventAt(seq);
			if (event?.type === "plugin:side-chat/context") records += 1;
			if (event?.type === "user/message" && event.data?.source?.kind === "session-reference") refsInLog += 1;
		}
		let latePersisted = false;
		main.followup(userMessage(late));
		await main.whenIdle();
		latePersisted = main.session.eventAt(main.session.seq - 1)?.type === "assistant/message" || main.session.seq > 0;
		side.followup(userMessage(question));
		await side.whenIdle();
		const log = fs.readFileSync(process.env.DSH_FAKE_LLM_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const request = [...log].reverse().find((entry) => JSON.stringify(entry.messages ?? []).includes(question));
		const messages = request?.messages ?? [];
		const refs = messages.filter((message) => message.source?.kind === "session-reference");
		const refText = refs.map((message) => (message.content ?? []).map((block) => block.text ?? "").join("")).join("\n");
		const questions = messages.filter((message) => message.source?.kind === "user" && JSON.stringify(message.content ?? "").includes(question)).length;
		const exact = refText === saved;
		const result = { phase: 6, paused, pre, refs: refs.length, questions, exact, refsInLog, records, hasOriginal: refText.includes(original), hasLate: refText.includes(late), latePersisted };
		report(result);
		process.exit(pre.hasOriginal && !pre.hasLate && refs.length === 1 && questions === 1 && exact && refsInLog === 0 && records >= 1 ? 0 : 1);
	}

	if (phase === "7a") {
		await api.awaitAdoptions();
		const mainId = `session-phase-main-${Date.now()}`;
		const main = await makeMain(mainId);
		const first = await ctx.commands.execute(main, "/side PHASE7-FIRST", [], new AbortController().signal);
		const sideId = api.activeSideId(mainId);
		const side = ctx.agents.get(sideId);
		await side?.whenIdle();
		const marker = `PHASE7-LATE-${Date.now()}`;
		main.followup(userMessage(marker));
		await main.whenIdle();
		void ctx.commands.execute(main, `/side SLOW-TURN ${marker}`, [], new AbortController().signal);
		for (let i = 0; i < 80 && side?.status !== "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
		const refresh = await ctx.commands.execute(main, `/side --refresh ${sideId}`, [], new AbortController().signal);
		const requested = refresh?.result?.kind === "success" && refresh?.result?.text === "refresh-pending";
		await new Promise((resolve) => setTimeout(resolve, 250));
		writeState({ mainId, sideId, marker, phase: 7 });
		report({ phase: "7a", mainId, sideId, first: first?.result?.kind ?? null, running: side?.status ?? null, requested, exit: requested ? 0 : 1 });
		process.exit(requested ? 0 : 1);
	}

	if (phase === "7b") {
		await api.awaitAdoptions();
		const state = readState();
		const main = await makeMain(state.mainId);
		const side = ctx.agents.get(state.sideId);
		await side?.whenIdle();
		await new Promise((resolve) => setTimeout(resolve, 700));
		const context = side === void 0 ? void 0 : ctx.sessionProjections.stateOf(side.session, "sideChatContext");
		const surface = side === void 0 ? [] : side.session.surface.nodes.map((seq) => side.session.eventAt(seq)).filter((event) => event?.type === "user/message" && event.data?.source?.kind === "session-reference");
		const surfaceText = surface.map((event) => (event.data.content ?? []).map((block) => block.text ?? "").join("")).join("\n");
		const after = `PHASE7-AFTER-${Date.now()}`;
		await ctx.commands.execute(main, `/side ${after}`, [], new AbortController().signal);
		await side?.whenIdle();
		const log = readFileSync(process.env.DSH_FAKE_LLM_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const request = [...log].reverse().find((entry) => JSON.stringify(entry.messages ?? []).includes(after));
		const messages = request?.messages ?? [];
		const snapshots = messages.filter((message) => message.source?.kind === "session-reference");
		const snapText = snapshots.map((message) => (message.content ?? []).map((block) => block.text ?? "").join("")).join("\n");
		const questions = messages.filter((message) => message.source?.kind === "user" && JSON.stringify(message.content ?? "").includes(after)).length;
		const requested = context?.status === "ready" && snapshots.length === 1 && snapText.includes(state.marker) && questions === 1 && surface.length === 1;
		report({ phase: "7b", mainId: state.mainId, sideId: state.sideId, context: context?.status ?? null, surface: surface.length, snapshots: snapshots.length, questions, marker: snapText.includes(state.marker), exit: requested ? 0 : 1 });
		process.exit(requested ? 0 : 1);
	}

	if (phase === "4") {
		await api.awaitAdoptions();
		const state = readState();
		const main = await makeMain(state.mainId);
		const registry = ctx.get("workspaceRegistry");
		const created = await registry.create(main.session.header.cwd);
		await created.attachSession(state.mainId);
		const outcome = await ctx.commands.execute(main, "/side", [], new AbortController().signal);
		const sideId = api.activeSideId(state.mainId);
		await ctx.agents.get(sideId)?.whenIdle();
		const after = (await registry.list()).find((workspace) => workspace.id === created.id);
		const result = { outcome, sideId, workspaceId: created.id, mainId: state.mainId, sessionIds: after?.sessionIds ?? [], accounted: after?.sessionIds.includes(state.mainId) === true };
		try {
			const fs = await import("node:fs");
			fs.mkdirSync(j(home, "side-chat"), { recursive: true });
			fs.writeFileSync(j(home, "side-chat", "host-verify.json"), JSON.stringify(result));
		} catch (error) {
			report({ phase: 4, writeError: String(error) });
		}
		report({ phase: 4, ...result });
		if (process.env.DSH_SIDE_TEST_CONTROL === "1") {
			const fs = await import("node:fs");
			const control = j(home, "test-control");
			fs.mkdirSync(control, { recursive: true });
			const write = (name, value) => fs.writeFileSync(j(control, name), JSON.stringify(value));
			setInterval(async () => {
				const actionPath = j(control, "action.json");
				if (!fs.existsSync(actionPath)) return;
				let action;
				try { action = JSON.parse(fs.readFileSync(actionPath, "utf8")); } catch { return; }
				fs.rmSync(actionPath, { force: true });
				try {
					if (action.action === "detach") {
						const list = await registry.list();
						const owner = list.find((workspace) => workspace.sessionIds.includes(state.mainId));
						if (owner === void 0) { write("result.json", { error: "main not in workspace" }); return; }
						await owner.detachSession(state.mainId);
						const after = (await registry.list()).find((workspace) => workspace.id === owner.id);
						write("result.json", { action: "detach", mainId: state.mainId, accounted: after?.sessionIds.includes(state.mainId) === true, sessionIds: after?.sessionIds ?? [] });
					} else if (action.action === "open-side") {
						await ctx.commands.execute(main, "/side", [], new AbortController().signal);
						write("result.json", { action: "open-side", sideId: api.activeSideId(state.mainId) ?? null });
					}
				} catch (error) {
					write("result.json", { action: action.action, error: String(error) });
				}
			}, 300);
		}
		return;
	}

	if (phase === "3") {
		await api.awaitAdoptions();
		const state = readState();
		const root = j(home, "sessions");
		const { readdirSync, existsSync } = await import("node:fs");
		const dirs = existsSync(root) ? readdirSync(root).filter((b) => existsSync(j(root, b, state.sideId))) : [];
		const main = await makeMain(state.mainId).catch(() => undefined);
		const ok = dirs.length === 0;
		if (main !== undefined) {
			await ctx.commands.execute(main, "/side SIDE-FRESH", [], new AbortController().signal);
			const freshId = api.activeSideId(state.mainId);
			await ctx.agents.get(freshId)?.whenIdle();
			report({ phase: 3, mainId: state.mainId, oldSideId: state.sideId, newSideId: freshId ?? null, unique: freshId !== state.sideId, dirs: dirs.length, exit: ok && freshId !== state.sideId ? 0 : 1 });
			process.exit(ok && freshId !== state.sideId ? 0 : 1);
		}
		report({ phase: 3, error: "main resume failed", dirs: dirs.length, exit: 1 });
		process.exit(1);
	}
}
