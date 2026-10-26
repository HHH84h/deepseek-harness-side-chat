/**
 * Targeted release checks for context refresh, send stages, multi-target
 * cleanup, status/diagnostics and surface replacement. Uses the production
 * host API and the recording fake provider; contains no production code.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { firstQuestionText, userMessage } from "../../plugin/lib/host.js";
import { readRequests, requestText } from "./util.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const markerOf = (prefix) => `${prefix}-${randomUUID()}`;

/** Session user-message texts, for main/侧 isolation checks. */
function userTexts(session) {
	const out = [];
	for (let seq = 0; seq < (session?.seq ?? 0); seq += 1) {
		const event = session.eventAt(seq);
		if (event?.type !== "user/message") continue;
		out.push((event.data.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n"));
	}
	return out;
}

/** Count one marker in the exact request the fake adapter received. */
function findRequest(file, marker) {
	return readRequests(file).filter((request) => requestText(request.messages).includes(marker)).at(-1);
}

function requestShape(request, marker) {
	const messages = request?.messages ?? [];
	const snapshots = messages.filter((message) => message.source?.kind === "session-reference");
	return {
		messages: messages.length,
		snapshots: snapshots.length,
		snapshotText: snapshots.map((message) => (message.content ?? []).map((block) => block.text ?? "").join("")).join("\n"),
		questionCount: messages.filter((message) => message.source?.kind === "user" && requestText([message]).includes(marker)).length,
	};
}

function surfaceSnapshotCount(session, mainId) {
	let count = 0;
	for (const seq of session.surface.nodes) {
		const event = session.eventAt(seq);
		if (event?.type !== "user/message" || event.data?.source?.kind !== "session-reference") continue;
		if ((event.data.source.references ?? []).some((reference) => reference.sessionId === mainId)) count += 1;
	}
	return count;
}

function sendStates(session) {
	const states = [];
	for (let seq = 0; seq < (session?.seq ?? 0); seq += 1) {
		const event = session.eventAt(seq);
		if (event?.type === "plugin:side-chat/send") states.push(event.data?.state);
	}
	return states;
}

async function command(ctx, main, line) {
	const outcome = await ctx.commands.execute(main.agent ?? main, line, [], new AbortController().signal);
	return outcome?.result;
}

export async function runOptimizationTests(ctx, api, check) {
	const file = process.env.DSH_FAKE_LLM_LOG;
	if (file === void 0) {
		check("opt.log.configured", false, "DSH_FAKE_LLM_LOG missing");
		return;
	}
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const cwd = process.cwd();
	const mainId = `session-opt-${randomUUID()}`;
	const main = (await ctx.agents.create({ sessionId: mainId, meta: { cwd }, agentOptions: ctx.get("agentDefaultModel")?.currentSelection() })).agent;
	const run = async (line) => {
		const result = await command(ctx, main, line);
		const sideId = api.activeSideId(mainId);
		await (sideId === void 0 ? void 0 : ctx.agents.get(sideId)?.whenIdle());
		return result;
	};

	// Entry one: /side <question>.
	const q1 = markerOf("OPT-FIRST");
	check("opt.first.command", (await run(`/side ${q1}`))?.kind === "success", "first /side");
	const sideId = api.activeSideId(mainId);
	const side = sideId === void 0 ? void 0 : ctx.agents.get(sideId);
	check("opt.side.created", side !== void 0, String(sideId));
	await wait(120);
	check("resource.inbox.rpc.cache.released", api.state.sides.get(mainId)?.sent?.size === 0, "persisted requests leave inbox cache");
	const firstContext = side === void 0 ? void 0 : ctx.sessionProjections.stateOf(side.session, "sideChatContext");
	check("opt.context.ready", firstContext?.status === "ready" && typeof firstContext?.snapshotSeq === "number" && typeof firstContext?.capturedAt === "string", JSON.stringify(firstContext));
	const first = findRequest(file, q1);
	const firstShape = requestShape(first, q1);
	check("opt.first.one.snapshot", first !== void 0 && firstShape.snapshots === 1, JSON.stringify({ snapshots: firstShape.snapshots, messages: firstShape.messages }));
	check("opt.first.snapshot.rich", (first?.messages ?? []).some((message) => message.source?.kind === "session-reference" && message.source.references?.[0]?.capturedFormatVersion !== void 0), "capture metadata");
	check("opt.first.question.once", firstShape.questionCount === 1, `questions=${firstShape.questionCount}`);
	check("opt.first.main.clean", userTexts(main.session).every((text) => !text.includes(q1)), `${userTexts(main.session).length} main messages`);
	const sendFinal = api.state.pending.get(mainId);
	check("opt.send.completed", sendFinal?.state === "completed", JSON.stringify(sendFinal));
	const states = side === void 0 ? [] : sendStates(side.session);
	check("opt.send.stages", ["queued", "accepted", "completed"].every((state) => states.includes(state)), JSON.stringify(states));

	// Normal follow-up must not add a snapshot or a context record.
	const q2 = markerOf("OPT-SECOND");
	check("opt.second.command", (await run(`/side ${q2}`))?.kind === "success", "second /side");
	const secondShape = requestShape(findRequest(file, q2), q2);
	check("opt.second.one.snapshot", secondShape.snapshots === 1, `snapshots=${secondShape.snapshots}`);
	const contextRecordsBefore = (() => {
		let count = 0;
		for (let seq = 0; seq < (side?.session.seq ?? 0); seq += 1) if (side.session.eventAt(seq)?.type === "plugin:side-chat/context") count += 1;
		return count;
	})();
	check("opt.second.one.record", contextRecordsBefore === 1, `records=${contextRecordsBefore}`);

	// Explicit refresh: new main marker is absent before, present after.
	const late = markerOf("OPT-LATE");
	main.followup(userMessage(late));
	await main.whenIdle();
	const q3 = markerOf("OPT-BEFORE-REFRESH");
	check("opt.before.command", (await run(`/side ${q3}`))?.kind === "success", "pre-refresh question");
	const before = requestShape(findRequest(file, q3), q3);
	check("opt.before.no.late", before.snapshotText !== "" && !before.snapshotText.includes(late), `snapshotLength=${before.snapshotText.length}`);
	const contextBefore = ctx.sessionProjections.stateOf(side.session, "sideChatContext");
	const refreshed = await run(`/side --refresh ${sideId}`);
	check("opt.refresh.command", refreshed?.kind === "success", JSON.stringify(refreshed));
	await wait(160);
	const contextAfter = ctx.sessionProjections.stateOf(side.session, "sideChatContext");
	check("opt.refresh.ready", contextAfter?.status === "ready" && contextAfter?.capturedAt !== contextBefore?.capturedAt, JSON.stringify(contextAfter));
	check("opt.refresh.one.surface", surfaceSnapshotCount(side.session, mainId) === 1, `surface=${surfaceSnapshotCount(side.session, mainId)}`);
	const q4 = markerOf("OPT-AFTER-REFRESH");
	check("opt.after.command", (await run(`/side ${q4}`))?.kind === "success", "post-refresh question");
	const after = requestShape(findRequest(file, q4), q4);
	check("opt.after.has.late", after.snapshotText.includes(late), `snapshotLength=${after.snapshotText.length}`);
	check("opt.after.one.snapshot", after.snapshots === 1, `snapshots=${after.snapshots}`);
	check("opt.after.questions", after.questionCount === 1, `questions=${after.questionCount}`);

	// Refresh while generating: queued now, applied before the next request.
	const slow = markerOf("OPT-SLOW");
	void command(ctx, main, `/side SLOW-TURN ${slow}`);
	await wait(120);
	check("opt.running.is.running", side.status === "running", String(side.status));
	const queued = await command(ctx, main, `/side --refresh ${sideId}`);
	check("opt.running.queued", queued?.kind === "success" && queued?.text === "refresh-pending", JSON.stringify(queued));
	const pendingState = ctx.sessionProjections.stateOf(side.session, "sideChatContext");
	check("opt.running.pending.state", pendingState?.status === "pending" || pendingState?.status === "preparing", JSON.stringify(pendingState));
	await side.whenIdle();
	await wait(200);
	const afterQueued = ctx.sessionProjections.stateOf(side.session, "sideChatContext");
	check("opt.running.applied", afterQueued?.status === "ready", JSON.stringify(afterQueued));
	check("opt.running.one.surface", surfaceSnapshotCount(side.session, mainId) === 1, `surface=${surfaceSnapshotCount(side.session, mainId)}`);

	// Refresh failure: old snapshot stays, error is visible, retry succeeds.
	const contextBeforeFailure = ctx.sessionProjections.stateOf(side.session, "sideChatContext");
	mkdirSync(join(home, "side-chat"), { recursive: true });
	writeFileSync(join(home, "side-chat", "fail-refresh"), "1");
	const failed = await command(ctx, main, `/side --refresh ${sideId}`);
	check("opt.refresh.failure.command", failed?.kind === "error", JSON.stringify(failed));
	await wait(120);
	const afterFailure = ctx.sessionProjections.stateOf(side.session, "sideChatContext");
	check("opt.refresh.failure.state", afterFailure?.status === "failed" && afterFailure?.capturedAt === contextBeforeFailure?.capturedAt, JSON.stringify(afterFailure));
	rmSync(join(home, "side-chat", "fail-refresh"), { force: true });
	const retried = await command(ctx, main, `/side --refresh ${sideId}`);
	check("opt.refresh.failure.retry", retried?.kind === "success", JSON.stringify(retried));
	await wait(160);

	// Send failure: the original text stays in the ledger, retry is safe, and
	// the eventual request contains it once.
	const failedSend = markerOf("OPT-FAILED-SEND");
	const requestId = randomUUID();
	api.state.pending.set(mainId, { text: failedSend, requestId, sideId, state: "pending", createdAt: Date.now(), errorCode: null, updatedAt: Date.now() });
	const originalFollowup = side.followup;
	side.followup = () => { throw new Error("injected send failure"); };
	let sendError;
	try { await api.retrySend(mainId, sideId); } catch (error) { sendError = error; }
	const failedEntry = api.state.pending.get(mainId);
	check("opt.send.failure.kept", sendError !== void 0 && failedEntry?.text === failedSend && failedEntry?.state === "failed" && failedEntry?.errorCode === "NOT_ENQUEUED", JSON.stringify(failedEntry));
	side.followup = originalFollowup;
	await api.retrySend(mainId, sideId);
	await side.whenIdle();
	await wait(120);
	const retriedSend = requestShape(findRequest(file, failedSend), failedSend);
	check("opt.send.retry.once", retriedSend.questionCount === 1 && retriedSend.snapshots === 1, JSON.stringify(retriedSend));

	// Multi-target cleanup: two failed deletions remain independently retryable.
	const main2Id = `session-opt-cleanup-${randomUUID()}`;
	const main2 = (await ctx.agents.create({ sessionId: main2Id, meta: { cwd }, agentOptions: ctx.get("agentDefaultModel")?.currentSelection() })).agent;
	const run2 = async (line) => {
		const result = await command(ctx, main2, line);
		const current = api.activeSideId(main2Id);
		await (current === void 0 ? void 0 : ctx.agents.get(current)?.whenIdle());
		return result;
	};
	await run2(`/side ${markerOf("OPT-CLEAN-A")}`);
	const a = api.activeSideId(main2Id);
	writeFileSync(join(home, "side-chat", "fail-close"), "1");
	const closeA = await run2(`/side --close ${a}`);
	check("opt.cleanup.first.failed", closeA?.kind === "error" && api.state.pendingClose.get(main2Id)?.size === 1, JSON.stringify(closeA));
	await run2(`/side ${markerOf("OPT-CLEAN-B")}`);
	const b = api.activeSideId(main2Id);
	check("opt.cleanup.new.id", b !== a && b !== void 0, `${String(a)} -> ${String(b)}`);
	const closeB = await run2(`/side --close ${b}`);
	check("opt.cleanup.second.failed", closeB?.kind === "error" && api.state.pendingClose.get(main2Id)?.size === 2, JSON.stringify({ closeB, targets: api.state.pendingClose.get(main2Id)?.size }));
	const persisted = JSON.parse(readFileSync(join(home, "side-chat", "pending-close.json"), "utf8"))[main2Id];
	check("opt.cleanup.persisted.two", Array.isArray(persisted) && persisted.length === 2, JSON.stringify(persisted));
	rmSync(join(home, "side-chat", "fail-close"), { force: true });
	const retriedClose = await run2("/side --retry-close");
	check("opt.cleanup.retry.all", retriedClose?.kind === "success" && (api.state.pendingClose.get(main2Id)?.size ?? 0) === 0, JSON.stringify(retriedClose));

	// Status/diagnostic command results stay short; structured data rides the
	// side Session projection so it never enters the main command result.
	const statusNonce = randomUUID();
	const statusCommand = await command(ctx, main, `/side --status ${sideId} ${statusNonce}`);
	const statusProjection = ctx.sessionProjections.stateOf(side.session, "sideChatStatus");
	check("opt.status.command", statusCommand?.kind === "success" && statusCommand?.text === "status-ready" && !JSON.stringify(statusCommand).includes("sidestatus/1"), JSON.stringify(statusCommand));
	check("opt.status.projection", statusProjection?.requestId === statusNonce && statusProjection?.schema === "sidestatus/1", JSON.stringify({ requestId: statusProjection?.requestId, schema: statusProjection?.schema }));
	const diagnosticNonce = randomUUID();
	const diagnosticCommand = await command(ctx, main, `/side --diagnose ${sideId} ${diagnosticNonce}`);
	const diagnosticProjection = ctx.sessionProjections.stateOf(side.session, "sideChatDiagnostic");
	check("opt.diagnostic.command", diagnosticCommand?.kind === "success" && diagnosticCommand?.text === "diagnostic-ready" && !JSON.stringify(diagnosticCommand).includes("sidechat-diagnostic/1"), JSON.stringify(diagnosticCommand));
	check("opt.diagnostic.projection", diagnosticProjection?.requestId === diagnosticNonce && diagnosticProjection?.schema === "sidechat-diagnostic/1", JSON.stringify({ requestId: diagnosticProjection?.requestId, schema: diagnosticProjection?.schema }));

	// Status and diagnostic: whitelist only, no ids/text/titles.
	const status = await api.statusReport(mainId, sideId);
	check("opt.status.shape", status?.schema === "sidestatus/1" && Array.isArray(status?.checks) && status.checks.some((item) => item.code === "service.commands" && item.ok === true), "status shape");
	const diagnostic = await api.diagnosticReport(mainId, sideId);
	const diagnosticText = JSON.stringify(diagnostic);
	check("opt.diagnostic.whitelist", diagnostic?.schema === "sidechat-diagnostic/1" && /^[0-9a-f]{12}$/u.test(diagnostic?.correlationId ?? "") && !diagnosticText.includes(mainId) && !diagnosticText.includes(sideId) && !diagnosticText.includes(q1) && !diagnosticText.includes("OPT-"), "diagnostic whitelist");
	check("opt.diagnostic.no.snapshot", !Object.hasOwn(diagnostic ?? {}, "snapshot") && !Object.hasOwn(diagnostic?.context ?? {}, "mainTitle"), "no snapshot/title");
}
