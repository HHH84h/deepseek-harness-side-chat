/** Offline and fake-provider self tests; never part of the production plugin. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { firstQuestionText, userMessage, SIDE_PRESET } from "../../plugin/lib/host.js";
import { readRequests, report, requestText } from "./util.js";
import { runOptimizationTests } from "./optimization.js";

export async function runSelfTest(ctx, api) {
	const results = [];
	const check = (id, ok, detail) => {
		results.push({ id, ok, detail });
		report({ selftest: id, ok, detail });
	};
	try {
		const cwd = process.cwd();
		const mainId = `session-side-selftest-${Date.now()}`;
		let main;
		for (let attempt = 0; attempt < 60; attempt += 1) {
			try {
				main = await ctx.agents.create({ sessionId: mainId, meta: { cwd } });
				break;
			} catch (error) {
				if (!/no agent factory/.test(String(error?.message))) throw error;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
		if (main === void 0) throw new Error("agent factory never registered");
		check("main.created", main.agent.session.header.id === mainId, mainId);

		const descriptor = ctx.commands.find(main.agent, "side");
		check(
			"command.registered",
			descriptor !== void 0 && descriptor.input !== void 0,
			descriptor === void 0 ? "missing" : `input=${descriptor.input !== void 0}`,
		);

		const controller = new AbortController();
		const execution = await ctx.commands.execute(main.agent, "/side hello world", [], controller.signal);
		report({ selftest: "command.result", detail: execution?.result ?? null });
		check("command.executed", execution?.result?.kind === "success", execution?.result?.text ?? execution?.result?.kind ?? "undefined");

		const sideId = api.activeSideId(mainId);
		const sideSession = sideId === void 0 ? void 0 : ctx.sessions.get(sideId);
		const header = sideSession?.header;
		check(
			"side.adopted.projection",
			sideId !== void 0 && ctx.sessionProjections?.stateOf?.(sideSession, "sideChatAdopted")?.adopted === true,
			JSON.stringify(sideId === void 0 ? null : ctx.sessionProjections?.stateOf?.(sideSession, "sideChatAdopted") ?? null),
		);
		check(
			"side.created",
			header !== void 0 &&
				header.parentSession === mainId &&
				header.agentPreset === "side-chat" &&
				header.isSeeded === false,
			header === void 0
				? "missing"
				: `parent=${String(header.parentSession)} preset=${String(header.agentPreset)} seeded=${String(header.isSeeded)}`,
		);

		// Dry routing: append the exact first-question text to the side log only.
		const sideAgent = ctx.agents.get(sideId);
		const questionText = firstQuestionText(mainId, "hello world");
		sideAgent?.session.append(
			"user/message",
			{
				content: [{ type: "text", text: questionText }],
				source: { kind: "user" },
				role: "user",
				id: randomUUID(),
			},
			{ surfaceOp: "append" },
		);

		const texts = (session) => {
			const out = [];
			for (let seq = 0; seq < (session?.seq ?? 0); seq += 1) {
				const event = session.eventAt(seq);
				if (event?.type === "user/message") out.push(JSON.stringify(event.data.content));
			}
			return out;
		};
		const sideTexts = texts(sideSession);
		const mainTexts = texts(main.agent.session);
		check("aux.question.in.side", sideTexts.some((text) => text.includes("hello world")), `${sideTexts.length} side user messages`);
		check("aux.question.not.in.main", mainTexts.every((text) => !text.includes("hello world")), `${mainTexts.length} main user messages`);

		let commandRun;
		for (let seq = 0; seq < main.agent.session.seq; seq += 1) {
			const event = main.agent.session.eventAt(seq);
			if (event?.type === "command/run" && event.data?.name === "side") commandRun = event.data;
		}
		check("command.no.args", commandRun !== void 0 && commandRun.args === void 0, JSON.stringify(commandRun ?? null));

		// Preset composition of the side Agent (mounted module ids).
		const presets = ctx.get("agentPresets");
		let modules = [];
		try {
			const inspected = await presets?.inspectCompositions?.(sideAgent?.ctx);
			modules = (inspected ?? []).flatMap((entry) => entry.modules ?? []).map((row) => row.moduleName ?? String(row));
		} catch (error) {
			modules = [`inspect failed: ${error instanceof Error ? error.message : String(error)}`];
		}
		report({ selftest: "preset.modules", detail: modules });
		check("preset.mounted", modules.some((id) => String(id).includes("tool-fs")) && !modules.some((id) => String(id).includes("tool-bash")), modules.join(","));

		// A wrong preset must fail creation and leave no side Session behind.
		const badMainId = `${mainId}-bad`;
		const badMain = await ctx.agents.create({ sessionId: badMainId, meta: { cwd } });
		const badSideId = api.activeSideId(badMainId);
		let badError;
		try {
			await api.ensureSide(badMain.agent, "no-such-preset");
		} catch (error) {
			badError = error instanceof Error ? error.message : String(error);
		}
		check(
			"bad.preset.rejected",
			badError !== void 0 && ctx.sessions.get(badSideId) === void 0,
			badError ?? "created unexpectedly",
		);

		// Reuse refusal: plant a Session with the wrong parent under the same id.
		let reuseError;
		try {
			api.assertReusable(mainId, { parentSession: "someone-else", agentPreset: SIDE_PRESET }, sideId);
		} catch (error) {
			reuseError = error instanceof Error ? error.message : String(error);
		}
		check("reuse.refuses.foreign", reuseError !== void 0, reuseError ?? "no error raised");

		// Deletion must also verify the read-only preset, not just the parent id:
		// a same-parent Session with a different preset is never a side chat.
		const foreignCloseId = `session-side-foreign-${Date.now()}`;
		await ctx.agents.create({ sessionId: foreignCloseId, meta: { cwd, parentSession: mainId } });
		const foreignClose = await api.closeSide(mainId, foreignCloseId);
		check(
			"close.refuses.foreign.preset",
			foreignClose.ok === false && ctx.sessions.get(foreignCloseId) !== void 0,
			foreignClose.error ?? "deleted unexpectedly",
		);

		// Cancel targets the side Agent only.
		const cancelled = api.cancelSide(mainId);
		check("cancel.side", cancelled === true, `cancelled=${String(cancelled)}`);
		check("main.alive", ctx.agents.get(mainId) !== void 0, "main agent live");

		if (process.env.DSH_SIDE_SELFTEST_LLM === "1") {
			await runLlmSelfTest(ctx, api, check);
		}

		if (process.env.DSH_SIDE_SELFTEST_LLM === "1") {
			await runCloseSelfTest(ctx, api, check);
		}

		if (process.env.DSH_SIDE_OPT_TESTS === "1") {
			await runOptimizationTests(ctx, api, check);
		}

        const ownedIds = [...api.state.handles.keys()];
        const activeFile = join(process.env.DSH_HOME, "side-chat", "active.json");
        const diskBeforeDispose = readFileSync(activeFile, "utf8");
        await api.dispose(); await api.dispose();
        check("resource.dispose.maps.empty", Object.values(api.state).every((map) => map.size === 0), "instance maps cleared");
        check("resource.dispose.owned.handles.released", ownedIds.every((id) => ctx.agents.get(id) === void 0), "owned agents released");
        check("resource.dispose.durable.bindings.kept", readFileSync(activeFile, "utf8") === diskBeforeDispose, "disk ledger preserved for restart");
        let refusedAfterDispose = false;
        try { await api.ensureSide(main.agent); } catch { refusedAfterDispose = true; }
        check("resource.dispose.rejects.new.work", refusedAfterDispose, "no resurrection after unload");

	report({ selftest: "summary", passed: results.filter((row) => row.ok).length, total: results.length });
	} catch (error) {
		report({ selftest: "crashed", error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
	}
	setTimeout(() => process.exit(0), 300);
}

/** Extract every text payload from one recorded request message list. */

async function runLlmSelfTest(ctx, api, check) {
	const file = process.env.DSH_FAKE_LLM_LOG;
	if (file === void 0) {
		check("llm.log.configured", false, "DSH_FAKE_LLM_LOG missing");
		return;
	}
	const cwd = process.cwd();
	const mainId = `session-side-llm-${Date.now()}`;
	// The app's own entry point creates root sessions with the default selection;
	// the harness mirrors that here (no side-chat code involved).
	const defaultSelection = ctx.get("agentDefaultModel")?.currentSelection();
	const main = await ctx.agents.create({
		sessionId: mainId,
		meta: { cwd },
		...(defaultSelection === void 0 ? {} : { agentOptions: defaultSelection }),
	});
	main.agent.followup(userMessage("MAIN-HISTORY-QUESTION"));
	await main.agent.whenIdle();

	// Enter through the real command path; no internal helper route injection.
	const exec = async (line) => {
		const outcome = await ctx.commands.execute(main.agent, line, [], new AbortController().signal);
		const side = ctx.agents.get(api.activeSideId(mainId));
		await side?.whenIdle();
		return outcome?.result;
	};
	check("llm.command.first", (await exec("/side SIDE-FIRST"))?.kind === "success", "first via /side");
	check("llm.command.second", (await exec("/side SIDE-SECOND"))?.kind === "success", "follow-up via /side");

	main.agent.followup(userMessage("MAIN-AFTER"));
	await main.agent.whenIdle();

	const liveSide = ctx.agents.get(api.activeSideId(mainId));
	const dedupeEntry = { mainId, sideId: api.activeSideId(mainId), agent: liveSide, firstSent: true };
	const firstSend = liveSide === void 0 ? { duplicate: false } : api.askSide(dedupeEntry, "DUP-CHECK", "dup-1");
	const secondSend = liveSide === void 0 ? { duplicate: false } : api.askSide(dedupeEntry, "DUP-CHECK", "dup-1");
	await liveSide?.whenIdle();
	check("llm.duplicate.inbox", firstSend.duplicate === false && secondSend.duplicate === true, JSON.stringify({ firstSend, secondSend }));

	const requests = readRequests(file);
	check("llm.requests.recorded", requests.length >= 4, `count=${requests.length}`);

	const first = requests.find((request) => requestText(request.messages).includes("SIDE-FIRST"));
	const second = requests.find((request) => requestText(request.messages).includes("SIDE-SECOND"));
	const mainAfter = requests.find((request) => requestText(request.messages).includes("MAIN-AFTER"));

	check("llm.first.has.snapshot", first !== void 0 && requestText(first.messages).includes("## Referenced sessions"), first === void 0 ? "no first request" : "snapshot present");
	const secondText = second === void 0 ? "" : requestText(second.messages);
	check("llm.followup.no.new.snapshot", second !== void 0 && (secondText.match(/## Referenced sessions/gu) ?? []).length === 1, `snapshot count=${(secondText.match(/## Referenced sessions/gu) ?? []).length}`);

	// Dispose the live side Agent, then resume from persistence and keep chatting.
	const released = await api.releaseSide(mainId);
	check("llm.release.side", released === true && ctx.agents.get(api.activeSideId(mainId)) === void 0, `released=${released}`);
	const resumeResult = await exec("/side SIDE-THIRD");
	check("llm.resume.command", resumeResult?.kind === "success", JSON.stringify(resumeResult ?? null));
	check("llm.resume.live", ctx.agents.get(api.activeSideId(mainId)) !== void 0, "resumed agent live");

	const mainText = mainAfter === void 0 ? "" : requestText(mainAfter.messages);
	check(
		"llm.main.excludes.side",
		mainAfter !== void 0 && !mainText.includes("SIDE-FIRST") && !mainText.includes("SIDE-SECOND"),
		`main request length=${mainText.length}`,
	);

	const third = readRequests(file).find((request) => requestText(request.messages).includes("SIDE-THIRD"));
	const thirdText = third === void 0 ? "" : requestText(third.messages);
	check(
		"llm.resume.no.new.snapshot",
		third !== void 0 && (thirdText.match(/## Referenced sessions/gu) ?? []).length === 1,
		`snapshot count=${(thirdText.match(/## Referenced sessions/gu) ?? []).length}`,
	);
	const resumedTools = third?.tools ?? [];
	check(
		"llm.resume.tools.readonly",
		resumedTools.length > 0 && !resumedTools.some((name) => ["write", "edit", "bash", "shell", "terminal", "pwsh"].includes(String(name))),
		resumedTools.join(","),
	);

	const tools = first?.tools ?? [];
	const banned = tools.filter((name) => ["write", "edit", "bash", "shell", "terminal", "pwsh"].includes(String(name)));
	check("llm.tools.readonly", banned.length === 0, `tools=${tools.join(",")}`);
	check(
		"llm.tools.expected",
		["read", "read_image", "glob", "grep"].every((name) => tools.includes(name)),
		tools.join(","),
	);
}


/** Close-semantics test: delete is host-owned, verified on disk, and reopens fresh. */

async function runCloseSelfTest(ctx, api, check) {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const sessionsRoot = join(home, "sessions");
	const cacheOf = (id) => join(home, "storages", "session_projcache", "sessions", `${id}.json`);
	const dirOf = (id) => {
		if (!existsSync(sessionsRoot)) return [];
		return readdirSync(sessionsRoot).map((bucket) => join(sessionsRoot, bucket, id)).filter((dir) => existsSync(dir));
	};
	const cwd = process.cwd();
	const mainId = `session-side-close-${Date.now()}`;
	const selection = ctx.get("agentDefaultModel")?.currentSelection();
	const main = await ctx.agents.create({
		sessionId: mainId,
		meta: { cwd },
		...(selection === void 0 ? {} : { agentOptions: selection }),
	});
	const run = async (line) => {
		const outcome = await ctx.commands.execute(main.agent, line, [], new AbortController().signal);
		const id = api.activeSideId(mainId);
		await (id === void 0 ? void 0 : ctx.agents.get(id)?.whenIdle());
		return outcome?.result;
	};

	check("close.command.create", (await run("/side SIDE-UNIQUE-A"))?.kind === "success", "created");
	const firstId = api.activeSideId(mainId);
	check("close.id.is.unique", typeof firstId === "string" && firstId.startsWith("session-side-"), String(firstId));
	const published = ctx.sessionProjections?.stateOf?.(main.agent.session, "sideChatBinding");
	check("binding.published", published?.sideId === firstId, JSON.stringify(published ?? null));

	const closed1 = await run(`/side --close ${firstId}`);
	check("close.success", closed1?.kind === "success", JSON.stringify(closed1 ?? null));
	check("close.files.gone", dirOf(firstId).length === 0 && !existsSync(cacheOf(firstId)), `dirs=${dirOf(firstId).length}`);
	check("close.active.cleared", api.activeSideId(mainId) === void 0, String(api.activeSideId(mainId)));
	await new Promise((resolve) => setTimeout(resolve, 1500));
	check("close.stays.gone", dirOf(firstId).length === 0 && !existsSync(cacheOf(firstId)), "not re-materialized");
	const cleared = ctx.sessionProjections?.stateOf?.(main.agent.session, "sideChatBinding");
	check("binding.cleared", cleared?.sideId === null, JSON.stringify(cleared ?? null));

	const created2 = await run("/side SIDE-NEW");
	const secondId = api.activeSideId(mainId);
	check("close.new.id", created2?.kind === "success" && secondId !== firstId && typeof secondId === "string", `${String(firstId)} -> ${String(secondId)}`);
	const file = process.env.DSH_FAKE_LLM_LOG;
	const requests = file === void 0 ? [] : readRequests(file);
	const newest = requests.filter((request) => requestText(request.messages).includes("SIDE-NEW")).at(-1);
	const newestText = newest === void 0 ? "" : requestText(newest.messages);
	check("close.new.no.old.content", newest !== void 0 && !newestText.includes("SIDE-UNIQUE-A"), `len=${newestText.length}`);
	const newestSnapshotCount = (newestText.match(/## Referenced sessions/gu) ?? []).length;
	check("close.new.has.snapshot", newest !== void 0 && newestSnapshotCount === 1, `snapshot=${newestSnapshotCount}`);

	// A delayed close for the OLD id must not touch the new side chat.
	const delayed = await run(`/side --close ${firstId}`);
	check("close.delayed.old.safe", delayed?.kind === "error" && api.activeSideId(mainId) === secondId, JSON.stringify(delayed ?? null));

	// Close/reopen loop: every open is a new id.
	const closed2 = await run(`/side --close ${secondId}`);
	const reopened = await run("/side SIDE-THIRD-OPEN");
	const thirdId = api.activeSideId(mainId);
	check("close.loop.new.id", closed2?.kind === "success" && reopened?.kind === "success" && thirdId !== secondId, `${String(secondId)} -> ${String(thirdId)}`);
	await run(`/side --close ${thirdId}`);

	// Close while the side is still generating: its turn stops, records are
	// deleted, and the main Session keeps working.
	await ctx.commands.execute(main.agent, "/side SLOW-TURN", [], new AbortController().signal);
	const slowId = api.activeSideId(mainId);
	const closedDuring = await run(`/side --close ${slowId}`);
	check("close.during.turn", closedDuring?.kind === "success" && dirOf(slowId).length === 0, JSON.stringify(closedDuring ?? null));
	const afterSlow = await run("/side MAIN-CONTINUES");
	check("close.main.continues", afterSlow?.kind === "success", JSON.stringify(afterSlow ?? null));
	await run(`/side --close ${api.activeSideId(mainId)}`);

	// Injected deletion failure: error is reported, records remain, retry succeeds.
	const failFile = join(home, "side-chat", "fail-close");
	mkdirSync(join(home, "side-chat"), { recursive: true });
	writeFileSync(failFile, "1");
	await run("/side SIDE-FAIL-CASE");
	const failId = api.activeSideId(mainId);
	const failed = await run(`/side --close ${failId}`);
	check("close.failure.reported", failed?.kind === "error", JSON.stringify(failed ?? null));
	check("close.failure.kept", dirOf(failId).length > 0 && api.activeSideId(mainId) === failId, `dirs=${dirOf(failId).length}`);
	rmSync(failFile, { force: true });
	const retried = await run(`/side --close ${failId}`);
	check("close.retry.success", retried?.kind === "success" && dirOf(failId).length === 0, JSON.stringify(retried ?? null));

	// External lifecycle (session-controller restore): no host handle. The Host
	// waits for the external retain to release, then deletes successfully.
	await run("/side EXTERNAL-OWNER");
	const externalId = api.activeSideId(mainId);
	const externalHandle = api.takeHandle(externalId);
	setTimeout(() => { void externalHandle?.dispose(); }, 300);
	const externalClosed = await run(`/side --close ${externalId}`);
	check(
		"close.external.release",
		externalClosed?.kind === "success" && dirOf(externalId).length === 0,
		JSON.stringify(externalClosed ?? null),
	);

	// Still-held external Agent: deletion fails, but /side must not stay locked.
	await run("/side HELD-OWNER");
	const heldId = api.activeSideId(mainId);
	const heldHandle = api.takeHandle(heldId);
	const heldFailed = await run(`/side --close ${heldId}`);
	check(
		"close.held.refused",
		heldFailed?.kind === "error" && dirOf(heldId).length > 0,
		JSON.stringify(heldFailed ?? null),
	);
	const pendingFile = join(home, "side-chat", "pending-close.json");
	check(
		"pending.persisted",
		existsSync(pendingFile) && JSON.stringify(JSON.parse(readFileSync(pendingFile, "utf8"))).includes(heldId),
		existsSync(pendingFile) ? readFileSync(pendingFile, "utf8") : "missing",
	);
	const heldRetry = await run("/side RETRY-NEW");
	const retryId = api.activeSideId(mainId);
	check(
		"close.held.retry",
		heldRetry?.kind === "success" && retryId !== heldId,
		JSON.stringify({ result: heldRetry ?? null, retryId }),
	);
	check(
		"pending.kept.after.new.side",
		existsSync(pendingFile) && readFileSync(pendingFile, "utf8").includes(heldId),
		"pending retained",
	);
	await heldHandle?.dispose();
	await run("/side AFTER-CLEANUP");
	const cleanedId = api.activeSideId(mainId);
	check(
		"pending.retry.clears",
		dirOf(heldId).length === 0 && cleanedId !== heldId && !readFileSync(pendingFile, "utf8").includes(heldId),
		`dirs=${dirOf(heldId).length} active=${String(cleanedId)}`,
	);

	// Instance-scoped handshake and the real session-controller path.
	await run("/side ENSURE-CASE");
	const ensureId = api.activeSideId(mainId);
	const ensureHandle = api.takeHandle(ensureId);
	await ensureHandle?.dispose();
	const ensured = await run(`/side --ensure ${ensureId}`);
	check("ensure.adopts", ensured?.kind === "success" && api.hasHandle(ensureId) === true, JSON.stringify(ensured ?? null));
	const controllerService = ctx.get("sessionController");
	report({
		selftest: "ensure.controller.availability",
		detail: { found: controllerService !== undefined, resume: typeof controllerService?.resume },
	});
	await run(`/side --close ${ensureId}`);

	check("close.main.intact", ctx.agents.get(mainId) !== void 0 && main.agent.session.seq > 0, "main session intact");
}


/** Two/three-process verification driver (env-selected phase). */
