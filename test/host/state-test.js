/**
 * Durable-state acceptance: corruption quarantine, legacy migration, and a
 * write-failure path. Runs in its own fresh DSH_HOME; no production code.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RUN = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const MAIN_ID = `session-state-${RUN}`;
const SIDE_ID = `session-side-state-${RUN}`;
const OLD_SIDE_ID = `session-side-state-old-${RUN}`;

export function stateDir() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "side-chat");
}

/** Write the requested legacy/corrupt fixture before the host loads it. */
export function seedState(mode) {
	const dir = stateDir();
	mkdirSync(dir, { recursive: true });
	if (mode === "corrupt") {
		for (const [name, body] of Object.entries({
			"active.json": '{"broken":',
			"pending.json": "not-json",
			"pending-close.json": '["still", "broken"',
		})) writeFileSync(join(dir, name), body);
		return { mode, originals: { active: '{"broken":', pending: "not-json", pendingClose: '["still", "broken"' } };
	}
	if (mode === "migration") {
		writeFileSync(join(dir, "active.json"), JSON.stringify({ [MAIN_ID]: SIDE_ID }));
		writeFileSync(join(dir, "pending.json"), JSON.stringify({ [MAIN_ID]: { text: "MIGRATED-PENDING-QUESTION", requestId: randomUUID() } }));
		writeFileSync(join(dir, "pending-close.json"), JSON.stringify({ [MAIN_ID]: OLD_SIDE_ID }));
		return { mode };
	}
	return { mode };
}

export async function runStateTest(ctx, host, mode, seed) {
	let failed = 0;
	const check = (id, ok, detail) => {
		if (!ok) failed += 1;
		console.log(JSON.stringify({ stateTest: id, ok, detail }));
	};
	const dir = stateDir();
	if (mode === "corrupt") {
		const status = await host.statusReport(MAIN_ID, SIDE_ID);
		check("corrupt.active", status.persistence.active === "corrupt", JSON.stringify(status.persistence));
		check("corrupt.pending", status.persistence.pending === "corrupt", JSON.stringify(status.persistence));
		check("corrupt.close", status.persistence.pendingClose === "corrupt", JSON.stringify(status.persistence));
		check("corrupt.backup.flag", status.persistence.backup === true, JSON.stringify(status.persistence));
		const backups = readdirSync(dir).filter((name) => name.includes(".corrupt-"));
		check("corrupt.backup.files", backups.length >= 3, `backups=${backups.length}`);
		const backupText = backups.map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
		check("corrupt.backup.content", backupText.includes('{"broken":') && backupText.includes("not-json"), "originals preserved");
		check("corrupt.no.silent.bind", host.state.active.size === 0 && host.state.pending.size === 0, `active=${host.state.active.size} pending=${host.state.pending.size}`);
		const diagnostic = await host.diagnosticReport(MAIN_ID, SIDE_ID);
		check("corrupt.diagnostic", diagnostic.persistence.active === "corrupt" && diagnostic.persistence.backup === true, JSON.stringify(diagnostic.persistence));
	} else if (mode === "migration") {
		check("migration.active", host.state.active.get(MAIN_ID) === SIDE_ID, String(host.state.active.get(MAIN_ID)));
		const pending = host.state.pending.get(MAIN_ID);
		check("migration.pending", pending?.text === "MIGRATED-PENDING-QUESTION" && pending?.state === "pending" && pending?.sideId === null, JSON.stringify(pending));
		const closeTargets = host.state.pendingClose.get(MAIN_ID);
		check("migration.close", closeTargets?.size === 1 && closeTargets.has(OLD_SIDE_ID), JSON.stringify([...(closeTargets?.keys() ?? [])]));
		const main = await ctx.agents.create({ sessionId: MAIN_ID, meta: { cwd: process.cwd() }, agentOptions: ctx.get("agentDefaultModel")?.currentSelection() });
		const outcome = await ctx.commands.execute(main.agent, "/side", [], new AbortController().signal);
		const sideId = host.activeSideId(MAIN_ID);
		await (sideId === void 0 ? void 0 : ctx.agents.get(sideId)?.whenIdle());
		check("migration.command", outcome?.result?.kind === "success" && sideId === SIDE_ID, JSON.stringify({ result: outcome?.result, sideId }));
		const activeFile = JSON.parse(readFileSync(join(dir, "active.json"), "utf8"));
		check("migration.active.rewritten", activeFile[MAIN_ID] === SIDE_ID, JSON.stringify(activeFile));
		const pendingFile = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8"));
		check("migration.pending.rewritten", pendingFile[MAIN_ID]?.sideId === SIDE_ID, JSON.stringify(pendingFile));
		const closeFile = JSON.parse(readFileSync(join(dir, "pending-close.json"), "utf8"));
		check("migration.close.preserved", Array.isArray(closeFile[MAIN_ID]) && closeFile[MAIN_ID].some((row) => row.sideId === OLD_SIDE_ID), JSON.stringify(closeFile));
	} else if (mode === "writefail") {
		mkdirSync(dir, { recursive: true });
		const main = await ctx.agents.create({ sessionId: MAIN_ID, meta: { cwd: process.cwd() }, agentOptions: ctx.get("agentDefaultModel")?.currentSelection() });
		chmodSync(dir, 0o500);
		let outcome;
		try {
			outcome = await ctx.commands.execute(main.agent, "/side WRITE-FAIL-QUESTION", [], new AbortController().signal);
		} finally {
			chmodSync(dir, 0o700);
		}
		await ctx.agents.get(host.activeSideId(MAIN_ID))?.whenIdle();
		check("writefail.command", outcome?.result?.kind === "success", JSON.stringify(outcome?.result));
		check("writefail.memory", host.activeSideId(MAIN_ID) !== void 0, String(host.activeSideId(MAIN_ID)));
	}
	console.log(JSON.stringify({ stateTest: "summary", passed: failed === 0, failed, mode, seed: seed?.mode }));
	process.exit(failed === 0 ? 0 : 1);
}
