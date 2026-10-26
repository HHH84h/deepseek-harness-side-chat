/**
 * Test driver: mounts the production host implementation with test-only
 * callbacks, then runs the requested self test or multi-process phase.
 * This package is never installed into a user profile.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSideChatHost, inject, name, userMessage } from "../../plugin/lib/host.js";
import { runPhase } from "./phase.js";
import { runSelfTest } from "./selftest.js";
import { runStateTest, seedState } from "./state-test.js";

export { inject, name };

export function apply(ctx) {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const barrier = process.env.DSH_SIDE_CONTEXT_BARRIER;
	const stateMode = process.env.DSH_SIDE_STATE_TEST;
	const seed = stateMode === void 0 ? void 0 : seedState(stateMode);
	const host = createSideChatHost(ctx, {
		attachWorkspace: process.env.DSH_SIDE_NO_ATTACH !== "1",
		async beforeContextAppend({ agent, mainId, snapshot, signal }) {
			if (barrier === void 0 || barrier === "") return;
			mkdirSync(barrier, { recursive: true });
			writeFileSync(join(barrier, "snapshot.txt"), snapshot);
			writeFileSync(join(barrier, "paused.json"), JSON.stringify({ sideId: agent.session.id, mainId, at: Date.now() }));
			while (!existsSync(join(barrier, "release"))) {
				if (signal?.aborted === true) throw new Error("side-chat context barrier cancelled");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		},
		async closeFailure({ sideId }) {
			if (existsSync(join(home, "side-chat", "fail-close"))) throw new Error(`injected close failure (${sideId})`);
		},
		async beforeRefreshCapture({ sideId }) {
			if (existsSync(join(home, "side-chat", "fail-refresh"))) throw new Error(`injected refresh failure (${sideId})`);
		},
	});
	// Browser acceptance aids: test-only commands, never registered by the
	// production entry. They exercise the real command/host path.
	ctx.commands.register({
		name: "side-test-arm-send-failure",
		description: "test only: make the next side send fail once",
		recordInput: false,
		handler: async ({ agent }) => {
			const sideId = host.activeSideId(agent.session.header.id);
			const side = sideId === void 0 ? void 0 : ctx.agents.get(sideId);
			if (side === void 0) return { kind: "error", text: "no active side" };
			const original = side.followup.bind(side);
			side.followup = (message) => {
				side.followup = original;
				throw new Error("injected send failure");
			};
			return { kind: "success" };
		},
	});

	ctx.commands.register({
		name: "side-test-detach-main",
		description: "test only: move the current main conversation into ungrouped",
		recordInput: false,
		handler: async ({ agent }) => {
			const registry = ctx.get("workspaceRegistry");
			if (registry === void 0) return { kind: "error", text: "workspace registry unavailable" };
			const mainId = agent.session.header.id;
			for (const workspace of await registry.list()) {
				if (workspace.sessionIds?.includes(mainId)) await workspace.detachSession(mainId);
			}
			return { kind: "success" };
		},
	});

	ctx.effect(() => {
		if (process.env.DSH_SIDE_SEED_UNGROUPED === "1") {
			void (async () => {
				const created = await ctx.agents.create({ sessionId: `session-ungrouped-${Date.now()}`, meta: { cwd: "/tmp" } });
				await ctx.sessions.flush(created.agent.session);
				await host.dispose?.();
				process.exit(0);
			})().catch((error) => {
				console.log(JSON.stringify({ seedUngrouped: false, error: String(error?.message ?? error) }));
				process.exit(1);
			});
		} else if (stateMode !== void 0) {
			void runStateTest(ctx, host, stateMode, seed).catch((error) => {
				console.log(JSON.stringify({ stateTest: "crashed", error: String(error?.message ?? error) }));
				process.exit(1);
			});
		} else if (process.env.DSH_SIDE_PHASE !== void 0) {
			void runPhase(ctx, host).catch((error) => {
				writeFileSync(join(home, "side-chat", "test-driver-error.txt"), String(error?.stack ?? error));
				process.exit(1);
			});
		} else if (process.env.DSH_SIDE_SELFTEST === "1") {
			void runSelfTest(ctx, host);
		}
		return () => {
			void host.dispose?.();
		};
	}, "side-chat test driver");
}
