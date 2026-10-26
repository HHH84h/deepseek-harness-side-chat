/**
 * Host half of the `/side` companion-chat prototype.
 *
 * Owns the `/side` slash command and the per-main-session side Agent. The
 * command declares `input`, so `/side <question>` is claimed by the composer
 * instead of being submitted as a main-chat message; `recordInput: false`
 * keeps the question out of the main Session log.
 *
 * The side Session is a ROOT session with durable lineage:
 *   meta.parentSession = main Session id
 *   meta.agentPreset   = "side-chat"  (read-only preset from the profile patch)
 * so the association survives reload without any side table.
 *
 * Context: `/side <question>` carries the official `dsh-session:` mention and
 * the framework's session-reference resolver prepares the snapshot. A bare
 * `/side` followed by a composer question is covered by the pre-step fallback;
 * the two paths must never both inject a snapshot.
 *
 * Closing is explicit and host-owned: after lineage, preset and ownership
 * checks the host stops the Agent, flushes, and deletes the Session log plus
 * its projection cache. Collapsing the panel or switching main chats never
 * deletes anything.
 */
import { PLUGIN_VERSION, SUPPORTED_HARNESS } from "./metadata.js";
import { createUpdateChecker } from "./update.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Durable retry ledger (not the Session log; never model-visible). */
const STATE_DIR = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "side-chat");
const PENDING_FILE = join(STATE_DIR, "pending.json");
const ACTIVE_FILE = join(STATE_DIR, "active.json");
const PENDING_CLOSE_FILE = join(STATE_DIR, "pending-close.json");

/** Redacted health of the three durable ledgers; never contains file paths. */
const stateHealth = {
	active: { status: "missing" },
	pending: { status: "missing" },
	pendingClose: { status: "missing" },
};

/** Only the ids this plugin creates may enter the active/close ledgers. */
function isSideSessionId(value) {
	return typeof value === "string" && value.startsWith("session-side-");
}

/**
 * Read one JSON object. A damaged or non-object file is copied to a local,
 * owner-only recovery file before being treated as empty; the caller learns
 * only the redacted status, never the path.
 */
function loadStateFile(file, healthKey) {
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		stateHealth[healthKey] = { status: error?.code === "ENOENT" ? "missing" : "unreadable" };
		return {};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = void 0;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		let backup = false;
		try {
			const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
			writeFileSync(`${file}.corrupt-${stamp}`, raw, { mode: 0o600 });
			backup = true;
		} catch {
			/* the damaged original stays untouched if the copy cannot be made */
		}
		stateHealth[healthKey] = { status: "corrupt", backup };
		return {};
	}
	stateHealth[healthKey] = { status: "ok" };
	return parsed;
}

function loadPending() {
	const map = new Map();
	const raw = loadStateFile(PENDING_FILE, "pending");
	let migrated = false;
	for (const [mainId, value] of Object.entries(raw)) {
		if (mainId === "" || value === null || typeof value !== "object") continue;
		if (typeof value.text !== "string" || typeof value.requestId !== "string") continue;
		if (typeof value.state !== "string" || !Object.hasOwn(value, "sideId")) migrated = true;
		map.set(mainId, {
			text: value.text,
			requestId: value.requestId,
			sideId: isSideSessionId(value.sideId) ? value.sideId : null,
			state: typeof value.state === "string" ? value.state : "pending",
			createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
			errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
		});
	}
	if (migrated) savePending(map);
	return map;
}

function loadActiveFile() {
	const map = new Map();
	const raw = loadStateFile(ACTIVE_FILE, "active");
	for (const [mainId, sideId] of Object.entries(raw)) {
		if (mainId === "" || !isSideSessionId(sideId)) continue;
		map.set(mainId, sideId);
	}
	return map;
}

function loadPendingClose() {
	const map = new Map();
	const raw = loadStateFile(PENDING_CLOSE_FILE, "pendingClose");
	let migrated = false;
	for (const [mainId, value] of Object.entries(raw)) {
		if (mainId === "") continue;
		const targets = new Map();
		const rows = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
		if (typeof value === "string" || rows.some((row) => typeof row === "string" || !Object.hasOwn(row ?? {}, "reasonCode"))) migrated = true;
		for (const row of rows) {
			const sideId = typeof row === "string" ? row : row?.sideId;
			if (!isSideSessionId(sideId)) continue;
			targets.set(sideId, {
				reasonCode: typeof row?.reasonCode === "string" ? row.reasonCode : "unknown",
				at: typeof row?.at === "number" ? row.at : 0,
				validated: row?.validated === true,
			});
		}
		if (targets.size > 0) map.set(mainId, targets);
	}
	if (migrated) savePendingCloseFile(map);
	return map;
}

/** Serialize pending-close targets without exposing raw error text. */
function pendingCloseJson(map) {
	return Object.fromEntries([...map].map(([mainId, targets]) => [mainId, [...targets].map(([sideId, value]) => ({ sideId, reasonCode: value.reasonCode, at: value.at }))]));
}

/** Write a state file atomically so a crash never leaves half a ledger. */
function saveStateFile(file, value) {
	const healthKey = file === ACTIVE_FILE ? "active" : file === PENDING_FILE ? "pending" : file === PENDING_CLOSE_FILE ? "pendingClose" : void 0;
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(temp, JSON.stringify(value));
		renameSync(temp, file);
		if (healthKey !== void 0) stateHealth[healthKey] = { status: "ok" };
	} catch {
		if (healthKey !== void 0) stateHealth[healthKey] = { status: "unwritable" };
		/* best effort: in-memory state still works for this process */
		try {
			rmSync(temp, { force: true });
		} catch {
			/* ignore cleanup failure */
		}
	}
}

function savePendingCloseFile(map) {
	saveStateFile(PENDING_CLOSE_FILE, pendingCloseJson(map));
}

function saveActiveFile(map) {
	saveStateFile(ACTIVE_FILE, Object.fromEntries(map));
}

function savePending(map) {
	saveStateFile(PENDING_FILE, Object.fromEntries(map));
}

/** Cordis plugin name. */
export const name = "dsh-client-ui-side";

/** Services required before apply(). */
export const inject = ["commands", "agents", "sessions", "sessionProjections"];

/** Read-only preset mounted for side chats; declared by the profile patch. */
export const SIDE_PRESET = "side-chat";

/** Deterministic side Session id for one main Session. */
export function sideSessionIdFor() {
	return `session-side-${randomUUID()}`;
}

/** True when the side Session log already carries any user message. */
function sideHasUserMessage(session) {
	for (let seq = 0; seq < (session?.seq ?? 0); seq += 1) {
		if (session.eventAt(seq)?.type === "user/message") return true;
	}
	return false;
}

/** True when the side Session already logged the request with this rpcId. */
function sideHasRequest(session, requestId) {
	for (let seq = 0; seq < (session?.seq ?? 0); seq += 1) {
		const event = session.eventAt(seq);
		if (event?.type !== "user/message") continue;
		if (event.data?.source?.rpcId === requestId) return true;
	}
	return false;
}

/**
 * Official mention codec, when the runtime resolves the package; otherwise the
 * exact wire protocol (JSON.stringify → UTF-8 → base64url) implemented here.
 * Both paths are round-trip tested against the official parser.
 */
let appendPluginRecord = null;
try {
	const sessionModule = await import("@deepseek-ai/dsh-session");
	if (typeof sessionModule.appendPluginRecord === "function") appendPluginRecord = sessionModule.appendPluginRecord;
} catch {
	/* profile without the package: binding projection stays unavailable */
}

let referenceMention = null;
let parseReferenceText = null;

try {
	const official = await import("@deepseek-ai/dsh-session-reference");
	if (typeof official.formatSessionReferenceMention === "function") {
		referenceMention = (sessionId, label) => official.formatSessionReferenceMention({ sessionId, label });
	}
	if (typeof official.parseSessionReferenceText === "function") parseReferenceText = official.parseSessionReferenceText;
} catch {
	/* profile without the package: keep the local encoder below */
}

/** Escape a Markdown label exactly like the official formatter. */
function escapeReferenceLabel(label) {
	return String(label).replace(/[\\\]]/gu, (match) => `\\${match}`);
}

/**
 * Build `@[label](dsh-session:<base64url(JSON.stringify(id))>)` locally.
 * The protocol matches `encodeSessionReferenceUri()` byte for byte.
 */
function localSessionReferenceMention(sessionId, label) {
	const payload = Buffer.from(JSON.stringify(sessionId), "utf8").toString("base64url");
	return `@[${escapeReferenceLabel(label ?? sessionId)}](dsh-session:${payload})`;
}

/** Format one session-reference mention (official codec preferred). */
export function formatSessionMention(sessionId, label) {
	return referenceMention === null ? localSessionReferenceMention(sessionId, label) : referenceMention(sessionId, label);
}

/** Parse canonical `dsh-session:` mentions exactly like the official codec. */
function localSessionReferences(text) {
	const references = [];
	const pattern = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu;
	for (const match of String(text).matchAll(pattern)) {
		const uri = match[2] ?? match[3];
		if (uri === void 0) continue;
		const payload = uri.slice("dsh-session:".length);
		const sessionId = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (typeof sessionId !== "string" || sessionId === "") continue;
		references.push({ sessionId, label: sessionId });
	}
	return { references };
}

/** Structured references in one text value; malformed mentions are ignored. */
function referencesInText(text) {
	if (typeof text !== "string") return [];
	try {
		const parsed = parseReferenceText === null ? localSessionReferences(text) : parseReferenceText(text);
		return Array.isArray(parsed?.references) ? parsed.references : [];
	} catch {
		return [];
	}
}

/**
 * True when these direct messages cite `sessionId`. The official
 * session-reference pre-step turns such a mention into a snapshot itself, so
 * the side-chat pre-step must not add a second copy of the same context.
 */
function messagesCiteSession(messages, sessionId) {
	for (const message of messages ?? []) {
		if (message?.source?.kind === "session-reference") {
			if ((message.source.references ?? []).some((reference) => reference?.sessionId === sessionId)) return true;
			continue;
		}
		if (message?.source?.kind !== "user") continue;
		for (const block of message.content ?? []) {
			if (block?.type !== "text") continue;
			if (referencesInText(block.text).some((reference) => reference?.sessionId === sessionId)) return true;
		}
	}
	return false;
}

/** Build the plain user message the Agent inbox accepts (no external import). */
export function userMessage(text, requestId) {
	return {
		role: "user",
		id: randomUUID(),
		content: [{ type: "text", text }],
		source: requestId === void 0 ? { kind: "user" } : { kind: "user", rpcId: requestId },
	};
}

/** First-question text: the mention carries the main Session id. */
export function firstQuestionText(mainSessionId, question) {
	return `${formatSessionMention(mainSessionId, "主对话")}\n\n${question}`;
}

export function createSideChatHost(ctx, options = {}) {
	let disposed = false;
	const updateChecker = createUpdateChecker();
	/** main Session id -> { mainId, sideId, agent, firstSent } */
	const sides = new Map();
	/** main Session id -> the one active side Session id (in-memory; close clears it). */
	const active = loadActiveFile();
	/** side Session id -> its AgentHandle, for host-owned dispose on close. */
	const handles = new Map();
	/** side Session id -> in-flight boot adoption (resume so the Host owns the handle). */
	const adoptions = new Map();

	/** Read one persisted header through a caller-owned query lease. */
	async function readStoredHeader(sideId) {
		const query = ctx.get("sessionQuery");
		if (query === void 0) return void 0;
		const lease = await query.observeSession(sideId, { projectionMode: "none" });
		try {
			return lease.header;
		} finally {
			try {
				lease[Symbol.dispose]?.();
			} catch {
				/* already disposed */
			}
		}
	}

	/** Mutate and persist the active binding in one synchronous step. */
	function setActive(mainId, sideId) {
		if (isSideSessionId(sideId)) active.set(mainId, sideId);
		else active.delete(mainId);
		saveActiveFile(active);
	}

	/** Resume one active side Session at Host boot so the Host, not a client retain, owns its Agent. */
	async function adoptSide(mainId, sideId) {
		if (disposed) return;
		if (ctx.agents.get(sideId) !== void 0 || handles.has(sideId)) return;
		// The active ledger is a plain file and may be stale or edited. Never
		// resume an id before proving it is this main Session's side chat.
		let stored;
		try {
			stored = await readStoredHeader(sideId);
		} catch {
			/* no persisted header; resume below is authoritative */
		}
		if (stored !== void 0) assertReusable(mainId, stored, sideId);
		const presetSetup = async (agentCtx) => {
			const presets = ctx.get("agentPresets");
			if (presets === void 0) throw new Error("agent-presets service is unavailable");
			await presets.mount(agentCtx, SIDE_PRESET);
		};
		const fallback = ctx.get("agentDefaultModel")?.currentSelection();
		for (let attempt = 0; attempt < 400; attempt += 1) {
			if (disposed) return;
			try {
				return await adoptOnce(mainId, sideId, fallback, presetSetup);
			} catch (error) {
				if (!/no agent factory/.test(String(error?.message))) throw error;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
	}

	async function adoptOnce(mainId, sideId, fallback, presetSetup) {
		const resumed = await ctx.agents.resume({
			resumeSessionId: sideId,
			...(fallback === void 0 ? {} : { agentOptions: fallback }),
			setup: presetSetup,
		});
		if (disposed) { await resumed.dispose(); throw new Error("side-chat host disposed"); }
		assertReusable(mainId, resumed.agent.session.header, sideId);
		handles.set(sideId, resumed);
		publishAdopted(resumed.agent.session);
	}
	/** main Session id -> last question whose send has not completed. */
	const retryable = loadPending();
	/** main Session id -> side Sessions whose deletion failed; many may await cleanup. */
	const pendingClose = loadPendingClose();

	/** Update one send ledger entry, persist it, and mirror state onto its side Session. */
	function updateSend(mainId, patch) {
		const current = retryable.get(mainId);
		if (current === void 0) return;
		const next = { ...current, ...patch, updatedAt: Date.now() };
		retryable.set(mainId, next);
		savePending(retryable);
		const session = next.sideId === null ? void 0 : ctx.sessions.get(next.sideId);
		if (session !== void 0) {
			// updateSend may run inside a session/event observer; defer the record
			// append until the current publish completes.
			queueMicrotask(() => publishSendState(session, next));
		}
	}

	/** Remove one send entry after delivery or close. */
	function clearSend(mainId) {
		if (!retryable.delete(mainId)) return;
		savePending(retryable);
	}

	/** Add one cleanup target without replacing earlier targets for the same main. */
	function addPendingClose(mainId, sideId, reasonCode, validated = false) {
		let targets = pendingClose.get(mainId);
		if (targets === void 0) {
			targets = new Map();
			pendingClose.set(mainId, targets);
		}
		const previous = targets.get(sideId);
		targets.set(sideId, {
			reasonCode: reasonCode ?? "unknown",
			at: Date.now(),
			validated: validated === true || previous?.validated === true,
		});
		savePendingCloseFile(pendingClose);
		publishCleanup(mainId);
	}

	/** Drop exactly one cleanup target; other targets survive. */
	function removePendingClose(mainId, sideId) {
		const targets = pendingClose.get(mainId);
		if (targets === void 0) return;
		targets.delete(sideId);
		if (targets.size === 0) pendingClose.delete(mainId);
		savePendingCloseFile(pendingClose);
		publishCleanup(mainId);
	}

	/**
	 * Validate an existing side Session before reuse. Only a Session that
	 * belongs to this main Session and carries the read-only preset may be
	 * reused; anything else is an error, never silently adopted.
	 */
	function assertReusable(mainId, header, sideId) {
		if (header.parentSession !== mainId) {
			throw new Error(`side session ${sideId} belongs to ${String(header.parentSession)}, not ${mainId}`);
		}
		if (header.agentPreset !== SIDE_PRESET) {
			throw new Error(`side session ${sideId} runs preset ${String(header.agentPreset)}, expected ${SIDE_PRESET}`);
		}
	}

	/**
	 * Ensure one side Agent for a main Session.
	 * @param mainAgent - live main Agent (supplies id and cwd).
	 * @param presetId - override, self-test only.
	 */
	const creating = new Map();

	async function ensureSide(mainAgent, presetId = SIDE_PRESET) {
		if (disposed) throw new Error("side-chat host disposed");
		const mainId = mainAgent.session.header.id;
		const cached = sides.get(mainId);
		if (cached !== void 0 && cached.agent !== void 0) return cached;
		const known = active.get(mainId);
		if (known !== void 0) await adoptions.get(known)?.catch(() => void 0);
		const inFlight = creating.get(mainId);
		if (inFlight !== void 0) return inFlight;
		const creation = (async () => {
			let sideId = active.get(mainId);
			const fresh = sideId === void 0;
			if (fresh) {
				sideId = sideSessionIdFor();
				active.set(mainId, sideId);
			}
			try {
				return await createSide(mainAgent, presetId, sideId);
			} catch (error) {
				if (fresh && active.get(mainId) === sideId) setActive(mainId, null);
				throw error;
			}
		})().finally(() => {
			creating.delete(mainId);
		});
		creating.set(mainId, creation);
		return creation;
	}

	/**
	 * Side-chat model selection: the main Session's current route when it has
	 * logged one, otherwise the application default. Mirrors the production
	 * session-controller rule (request header first, default second) and keeps
	 * the adapter-default reasoning effort out of the explicit selection.
	 */
	function resolveAgentOptions(mainAgent) {
		const header = mainAgent.session.requestHeader();
		if (header !== void 0) {
			const config = header.config;
			const reasoningEffort =
				config.reasoningEffort === void 0 || header.adapterDefaults?.reasoningEffort === true
					? {}
					: { reasoningEffort: config.reasoningEffort };
			return { provider: config.provider, model: config.model, ...reasoningEffort };
		}
		const fallback = ctx.get("agentDefaultModel");
		return fallback === void 0 ? void 0 : fallback.currentSelection();
	}

	/** One-time creation/resume body guarded by ensureSide's single flight. */
	async function createSide(mainAgent, presetId, sideId) {
		if (disposed) throw new Error("side-chat host disposed");
		const mainId = mainAgent.session.header.id;

		const live = ctx.agents.get(sideId);
		if (live !== void 0) {
			assertReusable(mainId, live.session.header, sideId);
			setActive(mainId, sideId);
		publishBinding(mainAgent.session, sideId);
		publishAdopted(live.session);
		await attachWorkspace(mainId, sideId);
		if (disposed) throw new Error("side-chat host disposed");
		const entry = { mainId, sideId, agent: live, firstSent: sideHasUserMessage(live.session) };
			sides.set(mainId, entry);
			return entry;
		}
		let stored = ctx.sessions.get(sideId);
		if (stored === void 0) {
			try {
				const header = await readStoredHeader(sideId);
				if (header !== void 0) stored = { header };
			} catch {
				/* no persisted session under this id */
			}
		}
		if (stored !== void 0) {
			assertReusable(mainId, stored.header, sideId);
			const setup = async (agentCtx) => {
				const presets = ctx.get("agentPresets");
				if (presets === void 0) throw new Error("agent-presets service is unavailable");
				await presets.mount(agentCtx, SIDE_PRESET);
			};
			const agentOptions = resolveAgentOptions(mainAgent);
			const resumed = await ctx.agents.resume({
				resumeSessionId: sideId,
				...(agentOptions === void 0 ? {} : { agentOptions }),
				setup,
			});
			if (disposed) { await resumed.dispose(); throw new Error("side-chat host disposed"); }
			handles.set(sideId, resumed);
			setActive(mainId, sideId);
			publishBinding(mainAgent.session, sideId);
			publishAdopted(resumed.agent.session);
			await attachWorkspace(mainId, sideId);
			if (disposed) throw new Error("side-chat host disposed");
			const entry = { mainId, sideId, agent: resumed.agent, handle: resumed, firstSent: sideHasUserMessage(resumed.agent.session) };
			sides.set(mainId, entry);
			return entry;
		}

		const cwd = mainAgent.session.header.cwd ?? process.cwd();
		const agentOptions = resolveAgentOptions(mainAgent);
		const created = await ctx.agents.create({
			sessionId: sideId,
			...(agentOptions === void 0 ? {} : { agentOptions }),
			meta: {
				cwd,
				parentSession: mainId,
				isSeeded: false,
				delegationDepth: 0,
				agentPreset: presetId,
			},
			// meta.agentPreset is durable metadata only; the preset's plugins are
			// mounted into the Agent scope by this setup step (same contract the
			// subagent factory uses: presets.mount(agentCtx, id)).
			setup: async (agentCtx) => {
				const presets = ctx.get("agentPresets");
				if (presets === void 0) throw new Error("agent-presets service is unavailable");
				await presets.mount(agentCtx, presetId);
			},
		});
		if (disposed) { await created.dispose(); throw new Error("side-chat host disposed"); }
		handles.set(sideId, created);
		setActive(mainId, sideId);
		publishBinding(mainAgent.session, sideId);
		publishAdopted(created.agent.session);
		await attachWorkspace(mainId, sideId);
		if (disposed) throw new Error("side-chat host disposed");
		const entry = { mainId, sideId, agent: created.agent, handle: created, firstSent: sideHasUserMessage(created.agent.session) };
		sides.set(mainId, entry);
		return entry;
	}

	/**
	 * Send one question to the side Agent. The mention is attached only to the
	 * first question, so follow-ups never re-capture the main Session.
	 */
	function askSide(entry, question, requestId) {
		if (disposed) throw new Error("side-chat host disposed");
		const knownSend = requestId !== void 0 && retryable.get(entry.mainId)?.requestId === requestId;
		if (requestId !== void 0 && entry.sent !== void 0 && entry.sent.has(requestId)) {
			if (knownSend) updateSend(entry.mainId, { state: "accepted", sideId: entry.sideId, errorCode: null });
			return { text: void 0, duplicate: true };
		}
		if (requestId !== void 0 && sideHasRequest(entry.agent.session, requestId)) {
			if (knownSend) updateSend(entry.mainId, { state: "accepted", sideId: entry.sideId, errorCode: null });
			return { text: void 0, duplicate: true };
		}
		const text = entry.firstSent ? question : firstQuestionText(entry.mainId, question);
		if (requestId !== void 0) { entry.sent ??= new Set(); entry.sent.add(requestId); }
		try {
			entry.agent.followup(userMessage(text, requestId));
		} catch (error) {
			if (requestId !== void 0) entry.sent?.delete(requestId);
			if (knownSend) updateSend(entry.mainId, { state: "failed", sideId: entry.sideId, errorCode: "NOT_ENQUEUED", error: void 0 });
			throw error;
		}
		if (requestId !== void 0) {
			if (knownSend) updateSend(entry.mainId, { state: "queued", sideId: entry.sideId, errorCode: null });
		}
		entry.firstSent = true;
		return { text, duplicate: false };
	}

	ctx.sessionProjections?.register?.({
		key: "sideChatBinding",
		stateVersion: 1,
		stateSchema: { parse: (value) => value },
		init: () => ({ sideId: null }),
		apply: (state, event) => {
			if (event.type !== "plugin:side-chat/binding") return state;
			const sideId = event.data?.sideId;
			return { sideId: typeof sideId === "string" ? sideId : null };
		},
		wire: {
			viewSchema: { parse: (value) => value },
			view: (state) => ({ sideId: state.sideId }),
		},
	});

	ctx.sessionProjections?.register?.({
		key: "sideChatSend",
		stateVersion: 1,
		stateSchema: { parse: (value) => value },
		init: () => ({ state: null, requestId: null, errorCode: null, updatedAt: 0, retryable: false, text: "" }),
		apply: (state, event) => {
			if (event.type !== "plugin:side-chat/send") return state;
			const data = event.data ?? {};
			return {
				state: typeof data.state === "string" ? data.state : null,
				requestId: typeof data.requestId === "string" ? data.requestId : null,
				errorCode: typeof data.errorCode === "string" ? data.errorCode : null,
				updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
				retryable: data.retryable === true,
				text: typeof data.text === "string" ? data.text : "",
			};
		},
		wire: {
			viewSchema: { parse: (value) => value },
			view: (state) => state,
		},
	});

	ctx.sessionProjections?.register?.({
		key: "sideChatCleanup",
		stateVersion: 1,
		stateSchema: { parse: (value) => value },
		init: () => ({ count: 0, reasons: [], updatedAt: 0 }),
		apply: (state, event) => {
			if (event.type !== "plugin:side-chat/cleanup") return state;
			const targets = Array.isArray(event.data?.targets) ? event.data.targets : [];
			return {
				count: targets.length,
				reasons: [...new Set(targets.map((target) => (typeof target?.reasonCode === "string" ? target.reasonCode : "unknown")))],
				updatedAt: typeof event.data?.updatedAt === "number" ? event.data.updatedAt : 0,
			};
		},
		wire: {
			viewSchema: { parse: (value) => value },
			view: (state) => state,
		},
	});

	ctx.sessionProjections?.register?.({
		key: "sideChatAdopted",
		stateVersion: 1,
		stateSchema: { parse: (value) => value },
		init: () => ({ adopted: false }),
		apply: (state, event) => {
			if (event.type !== "plugin:side-chat/adopted") return state;
			return { adopted: event.data?.adopted === true };
		},
		wire: {
			viewSchema: { parse: (value) => value },
			view: (state) => ({ adopted: state.adopted }),
		},
	});

	ctx.sessionProjections?.register?.({
		key: "sideChatStatus",
		stateVersion: 1,
		stateSchema: { parse: (value) => value },
		init: () => null,
		apply: (state, event) => event.type === "plugin:side-chat/status" ? event.data : state,
		wire: { viewSchema: { parse: (value) => value }, view: (state) => state },
	});

	ctx.sessionProjections?.register?.({
		key: "sideChatUpdate",
		stateVersion: 1,
		stateSchema: { parse: (value) => value },
		init: () => null,
		apply: (state, event) => event.type === "plugin:side-chat/update" ? event.data : state,
		wire: { viewSchema: { parse: (value) => value }, view: (state) => state },
	});

	ctx.sessionProjections?.register?.({
		key: "sideChatDiagnostic",
		stateVersion: 1,
		stateSchema: { parse: (value) => value },
		init: () => null,
		apply: (state, event) => event.type === "plugin:side-chat/diagnostic" ? event.data : state,
		wire: { viewSchema: { parse: (value) => value }, view: (state) => state },
	});

	ctx.sessionProjections?.register?.({
		key: "sideChatContext",
		stateVersion: 1,
		stateSchema: { parse: (value) => value },
		init: () => ({
			status: "none",
			mainId: null,
			mainTitle: "主对话",
			capturedAt: null,
			snapshotSeq: null,
			truncated: false,
			omittedMessages: 0,
			omittedBytes: 0,
			errorCode: null,
			requestedAt: null,
		}),
		apply: (state, event) => {
			if (event.type === "plugin:side-chat/context") {
				const data = event.data ?? {};
				return {
					status: typeof data.snapshotSeq === "number" ? "ready" : "prepared",
					mainId: typeof data.mainId === "string" ? data.mainId : state.mainId,
					mainTitle: typeof data.mainTitle === "string" ? data.mainTitle : state.mainTitle,
					capturedAt: typeof data.capturedAt === "string" ? data.capturedAt : state.capturedAt,
					snapshotSeq: typeof data.snapshotSeq === "number" ? data.snapshotSeq : state.snapshotSeq,
					truncated: data.truncated === true,
					omittedMessages: typeof data.omittedMessages === "number" ? data.omittedMessages : 0,
					omittedBytes: typeof data.omittedBytes === "number" ? data.omittedBytes : 0,
					errorCode: null,
					requestedAt: null,
				};
			}
			if (event.type !== "plugin:side-chat/refresh") return state;
			const data = event.data ?? {};
			if (data.state === "preparing" || data.state === "pending") {
				return { ...state, status: data.state, requestedAt: typeof data.requestedAt === "number" ? data.requestedAt : null, errorCode: null };
			}
			if (data.state === "failed") {
				return { ...state, status: "failed", requestedAt: typeof data.requestedAt === "number" ? data.requestedAt : null, errorCode: typeof data.errorCode === "string" ? data.errorCode : "REFRESH_FAILED" };
			}
			if (data.state === "applied") return { ...state, status: "ready", requestedAt: null, errorCode: null };
			return state;
		},
		wire: {
			viewSchema: { parse: (value) => value },
			view: (state) => state,
		},
	});

	/** Mirror one send state onto its side Session for the retry banner. */
	function publishSendState(session, entry) {
		if (appendPluginRecord === null || session === void 0) return;
		try {
			appendPluginRecord(session, "plugin:side-chat/send", {
				state: entry.state,
				requestId: entry.requestId,
				errorCode: entry.errorCode ?? null,
				updatedAt: entry.updatedAt ?? 0,
				retryable: entry.state === "pending" || entry.state === "queued",
				text: entry.text,
			});
		} catch {
			/* the live banner is best effort */
		}
	}

	/** Publish only the count and reason codes of cleanup targets, never ids. */
	function publishCleanup(mainId) {
		const session = ctx.agents.get(mainId)?.session;
		if (appendPluginRecord === null || session === void 0) return;
		const targets = [...(pendingClose.get(mainId)?.values() ?? [])];
		try {
			appendPluginRecord(session, "plugin:side-chat/cleanup", {
				targets: targets.map((target) => ({ reasonCode: target.reasonCode, at: target.at })),
				updatedAt: Date.now(),
			});
		} catch {
			/* status check still reads the ledger */
		}
	}

	/** Tell the client the host owns the Agent handle, so it may retain the Session. */
	function publishAdopted(session) {
		if (appendPluginRecord === null || session === void 0) return;
		try {
			appendPluginRecord(session, "plugin:side-chat/adopted", { adopted: true });
		} catch {
			/* client waits with a timeout */
		}
	}

	/**
	 * Instance-scoped handshake: adopt this side Session in the CURRENT Host and
	 * report success only when this process holds a live AgentHandle for it.
	 * A persisted projection can never prove current ownership.
	 */
	async function ensureOwned(mainId, sideId) {
		if (disposed) throw new Error("side-chat host disposed");
		if (typeof sideId !== "string" || !sideId.startsWith("session-side-")) throw new Error("invalid side session id");
		// Native re-enable may restore a tab while this host is still adopting it.
		// Await that same adoption before testing ownership; never race a second resume.
		await adoptions.get(sideId);
		if (disposed) throw new Error("side-chat host disposed");
		if (handles.has(sideId)) {
			const owned = ctx.agents.get(sideId);
			if (owned === void 0 || owned.session.header.parentSession !== mainId || owned.session.header.agentPreset !== SIDE_PRESET) {
				throw new Error("side session ownership mismatch");
			}
			return;
		}
		let stored;
		try {
			stored = await readStoredHeader(sideId);
		} catch {
			/* fall through */
		}
		const live = ctx.agents.get(sideId);
		const header = live?.session.header ?? stored;
		if (header === void 0) throw new Error("side session not found");
		assertReusable(mainId, header, sideId);
		if (live !== void 0) throw new Error("Agent 已被其他生命周期持有，宿主无法取得 release handle");
		await adoptSide(mainId, sideId);
		if (!handles.has(sideId)) throw new Error("宿主收养未完成");
		await attachWorkspace(mainId, sideId);
	}

	// Delivery stages: queued once followup() accepts; accepted when the exact
	// rpcId enters the side log; completed/failed at turn end. Only states before
	// acceptance are retryable, so a retry can never duplicate an accepted user
	// message.
	ctx.on("session/event", (session, event) => {
		if (disposed) return;
		const header = session?.header;
		if (header?.agentPreset !== SIDE_PRESET || typeof header.parentSession !== "string") return;
		const mainId = header.parentSession;
		// Once durable, the Session log is the duplicate authority. Keep only
		// inbox requests here instead of every rpcId for the lifetime of a chat.
		if (event.type === "user/message" && event.data?.source?.rpcId !== void 0) {
			sides.get(mainId)?.sent?.delete(event.data.source.rpcId);
		}
		const entry = retryable.get(mainId);
		if (entry === void 0 || entry.sideId !== session.id) return;
		if (event.type === "user/message" && event.data?.source?.rpcId === entry.requestId) {
			if (entry.state === "queued" || entry.state === "pending") updateSend(mainId, { state: "accepted", errorCode: null });
			return;
		}
		if (event.type !== "turn/end") return;
		if (entry.state !== "queued" && entry.state !== "accepted") return;
		const reason = event.data?.reason;
		if (reason?.kind === "error" || reason?.kind === "aborted") {
			updateSend(mainId, { state: "failed", errorCode: reason.kind === "aborted" ? "TURN_ABORTED" : "TURN_FAILED" });
		} else {
			updateSend(mainId, { state: "completed", errorCode: null });
		}
	}, "side-chat send-stage tracker");

	/** Attach the side Session to the main Session's Workspace (cwd matches). */
	async function attachWorkspace(mainId, sideId, hintCwd) {
		if (options.attachWorkspace === false) return;
		try {
			const registry = ctx.get("workspaceRegistry");
			if (registry === void 0) return;
			const workspaces = await registry.list();
			const owner =
				workspaces.find((workspace) => workspace.sessionIds.includes(mainId)) ??
				workspaces.find((workspace) => {
					const cwd = hintCwd ?? ctx.agents.get(sideId)?.session.header.cwd;
					return cwd !== void 0 && workspace.path === cwd;
				});
			if (owner !== void 0 && !owner.sessionIds.includes(sideId)) await owner.attachSession(sideId);
		} catch (error) {
			ctx.logger?.warn?.(`side-chat workspace attach failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Publish the active binding on the main Session log for client/projection reads. */
	function publishBinding(mainSession, sideId) {
		if (appendPluginRecord === null) return;
		try {
			appendPluginRecord(mainSession, "plugin:side-chat/binding", { sideId });
		} catch {
			/* projection stays at its previous value; the command result is still authoritative for the running process */
		}
	}

	void (async () => {
		await Promise.all([...adoptions.values()].map((p) => p.catch(() => void 0)));
		// Legacy side Sessions: attach every persisted side Session to the Workspace
		// matching its inherited cwd so they never create an otherwise-empty
		// "ungrouped" navigation section.
		try {
			const query = ctx.get("sessionQuery");
			if (query !== void 0) {
				const records = await query.listSessions();
				for (const record of records) {
					if (disposed) return;
					const header = record.header;
					if (header?.agentPreset !== SIDE_PRESET || typeof header.parentSession !== "string") continue;
					await attachWorkspace(header.parentSession, header.id, header.cwd);
				}
			}
		} catch (error) {
			ctx.logger?.warn?.(`side-chat legacy workspace attach failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		for (const pendingMain of [...pendingClose.keys()]) {
			try {
				await retryCleanupTargets(pendingMain);
			} catch {
				/* keep every target for the next /side or boot */
			}
		}
		for (const [pendingMain, entry] of retryable) {
			if (entry.sideId === null) continue;
			const sideAgent = ctx.agents.get(entry.sideId);
			if (sideAgent !== void 0 && sideHasRequest(sideAgent.session, entry.requestId)) {
				updateSend(pendingMain, { state: "accepted", errorCode: null });
			}
		}
	})();

	for (const [mainId, sideId] of active) {
		const adoption = adoptSide(mainId, sideId)
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				ctx.logger?.warn?.(`side-chat adopt ${sideId} failed: ${message}`);
				// A ledger entry that fails lineage/preset validation is unusable;
				// drop it so it cannot block a fresh /side forever.
				if (/belongs to|runs preset/u.test(message)) {
					setActive(mainId, null);
				}
			})
			.finally(() => adoptions.delete(sideId));
		adoptions.set(sideId, adoption);
	}

	// Restore context bookkeeping and pending refreshes after adoption.
	void (async () => {
		await Promise.all([...adoptions.values()].map((promise) => promise.catch(() => void 0)));
		for (const [mainId, sideId] of active) {
			const agent = ctx.agents.get(sideId);
			if (agent === void 0) continue;
			reconcileContext(agent.session, mainId);
			const refresh = readRefreshRecord(agent.session);
			if (refresh?.state === "pending" || refresh?.state === "preparing") {
				void scheduleRefresh(mainId, sideId, agent, typeof refresh.requestedAt === "number" ? refresh.requestedAt : Date.now());
			}
		}
	})();


	// Side context: one durable snapshot node is maintained in the session
	// surface. `/side <question>` is handled by the official resolver; a bare
	// `/side` followed by a composer question is handled here. Refresh replaces
	// the current surface node, so the model never receives old+new snapshots
	// as two long-lived blocks while the event log keeps the original history.
	const contextSnapshots = new Map();
	const contextBuilds = new Map();
	const recordedSnapshots = new Set();
	const refreshing = new Map();
	const refreshControllers = new Map();
	const closedSides = new Set();
	const closedOrder = [];

	/** Bound the closed-id guard so repeated open/close cannot grow forever. */
	function markClosed(sideId) {
		if (!closedSides.has(sideId)) {
			closedSides.add(sideId);
			closedOrder.push(sideId);
		}
		while (closedOrder.length > 64) {
			const oldest = closedOrder.shift();
			if (oldest !== void 0) closedSides.delete(oldest);
		}
	}

	/** Drop per-side context caches after its Session was actually deleted. */
	function clearSideCaches(sideId) {
		contextSnapshots.delete(sideId);
		contextBuilds.delete(sideId);
		for (const key of [...recordedSnapshots]) if (key.startsWith(`${sideId}:`)) recordedSnapshots.delete(key);
		refreshing.delete(sideId);
		refreshControllers.delete(sideId);
	}

	/** Append one plugin record, returning its sequence or undefined when unavailable. */
	function appendRecord(session, type, data) {
		if (appendPluginRecord === null || session === void 0) return void 0;
		try {
			return appendPluginRecord(session, type, data);
		} catch {
			return void 0;
		}
	}

	/** Main-chat display name; never falls back to an id in user-facing UI. */
	function mainTitleOf(mainId) {
		const session = ctx.agents.get(mainId)?.session ?? ctx.sessions.get(mainId);
		const projected = session === void 0 ? void 0 : ctx.sessionProjections?.stateOf?.(session, "title");
		return typeof projected === "string" && projected !== "" ? projected
			: session?.header.title ?? "主对话";
	}

	/** Latest context record for one main Session (records are log-only, not surface). */
	function readContextRecord(session, mainId) {
		let found;
		for (let seq = 0; seq < (session?.seq ?? 0); seq += 1) {
			const event = session.eventAt(seq);
			if (event?.type !== "plugin:side-chat/context") continue;
			if (event.data?.mainId === mainId && typeof event.data?.snapshot === "string") {
				found = { ...event.data, recordSeq: event.seq };
			}
		}
		return found;
	}

	/** Latest refresh request record. */
	function readRefreshRecord(session) {
		let found;
		for (let seq = 0; seq < (session?.seq ?? 0); seq += 1) {
			const event = session.eventAt(seq);
			if (event?.type === "plugin:side-chat/refresh") found = { ...event.data, recordSeq: event.seq };
		}
		return found;
	}

	/** Current current-surface snapshot node for this main Session, if any. */
	function surfaceSnapshotSeq(session, mainId) {
		let found;
		for (const seq of session?.surface?.nodes ?? []) {
			const event = session.eventAt(seq);
			if (event?.type !== "user/message" || event.data?.source?.kind !== "session-reference") continue;
			const references = event.data.source.references ?? [];
			if (references.some((reference) => reference?.sessionId === mainId)) found = seq;
		}
		return found;
	}

	/** Public context status derived from records + the current surface. */
	function contextStateOf(session, mainId = session?.header?.parentSession) {
		const record = session === void 0 ? void 0 : readContextRecord(session, mainId);
		const refresh = session === void 0 ? void 0 : readRefreshRecord(session);
		const snapshotSeq = session === void 0 ? void 0 : surfaceSnapshotSeq(session, mainId) ?? record?.snapshotSeq;
		let status = record === void 0 ? "none" : typeof snapshotSeq === "number" ? "ready" : "prepared";
		if (refresh?.state === "preparing") status = "preparing";
		else if (refresh?.state === "pending") status = "pending";
		else if (refresh?.state === "failed") status = "failed";
		return {
			status,
			mainId,
			mainTitle: record?.mainTitle ?? "主对话",
			capturedAt: record?.capturedAt ?? null,
			snapshotSeq: typeof snapshotSeq === "number" ? snapshotSeq : null,
			truncated: record?.truncated === true,
			omittedMessages: typeof record?.omittedMessages === "number" ? record.omittedMessages : 0,
			omittedBytes: typeof record?.omittedBytes === "number" ? record.omittedBytes : 0,
			errorCode: status === "failed" ? (refresh?.errorCode ?? "REFRESH_FAILED") : null,
			requestedAt: refresh?.requestedAt ?? null,
		};
	}

	/** Capture a fresh snapshot of the main Session through the official resolver. */
	async function captureSnapshot(agent, mainId, signal) {
		const resolver = ctx.get("sessionReferenceResolver");
		if (resolver === void 0 || typeof resolver.prepare !== "function") throw new Error("session-reference resolver is unavailable");
		const mod = await import("@deepseek-ai/dsh-session-reference");
		const parsed = mod.parseSessionReferenceText(firstQuestionText(mainId, ""));
		const prepared = await resolver.prepare(agent, [{ type: "text", text: "" }], parsed.references, signal);
		const message = prepared.additionalContext;
		if (message === void 0) throw new Error("session-reference preparation produced no context");
		const text = (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
		if (text === "") throw new Error("session-reference snapshot is empty");
		const reference = message.source?.references?.[0] ?? {};
		return {
			text,
			meta: {
				mainTitle: mainTitleOf(mainId),
				capturedAt: new Date().toISOString(),
				capturedFormatVersion: reference.capturedFormatVersion ?? null,
				capturedThroughSeq: reference.capturedThroughSeq ?? null,
				truncated: reference.truncated === true || (reference.omittedMessages ?? 0) > 0,
				omittedMessages: reference.omittedMessages ?? 0,
				omittedBytes: reference.omittedBytes ?? 0,
			},
		};
	}

	/** Cached snapshot for the pre-step fallback. */
	async function mainSnapshot(agent, mainId, signal) {
		const sideId = agent.session.id;
		if (disposed || closedSides.has(sideId)) throw new Error("side-chat context cancelled");
		const cached = contextSnapshots.get(sideId);
		if (cached !== void 0) return cached;
		const record = readContextRecord(agent.session, mainId);
		if (record !== void 0) {
			const value = { text: record.snapshot, meta: record };
			contextSnapshots.set(sideId, value);
			return value;
		}
		let build = contextBuilds.get(sideId);
		if (build === void 0) {
			build = captureSnapshot(agent, mainId, signal)
				.then((value) => {
					if (disposed || closedSides.has(sideId) || ctx.sessions.get(sideId) !== agent.session) throw new Error("side-chat context cancelled");
					contextSnapshots.set(sideId, value);
					// Persist the prepared snapshot before the framework accepts it:
					// a cancelled first turn can then reuse it instead of re-capturing.
					appendRecord(agent.session, "plugin:side-chat/context", {
						mainId,
						...value.meta,
						snapshot: value.text,
						snapshotSeq: null,
					});
					return value;
				})
				.finally(() => contextBuilds.delete(sideId));
			contextBuilds.set(sideId, build);
		}
		return await build;
	}

	/** Record the snapshot node that actually entered the surface. */
	function recordSnapshotEvent(session, event, mainId) {
		const key = `${session.id}:${event.seq}`;
		if (recordedSnapshots.has(key)) return;
		const text = (event.data?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
		if (text === "") return;
		const reference = event.data?.source?.references?.[0] ?? {};
		queueMicrotask(() => {
			if (disposed || closedSides.has(session.id) || ctx.sessions.get(session.id) !== session) return;
			if (recordedSnapshots.has(key)) return;
			recordedSnapshots.add(key);
			const meta = {
				mainId,
				mainTitle: mainTitleOf(mainId),
				capturedAt: new Date(event.time ?? Date.now()).toISOString(),
				capturedFormatVersion: reference.capturedFormatVersion ?? null,
				capturedThroughSeq: reference.capturedThroughSeq ?? null,
				truncated: reference.truncated === true || (reference.omittedMessages ?? 0) > 0,
				omittedMessages: reference.omittedMessages ?? 0,
				omittedBytes: reference.omittedBytes ?? 0,
				snapshotSeq: event.seq,
			};
			contextSnapshots.set(session.id, { text, meta });
			appendRecord(session, "plugin:side-chat/context", { ...meta, snapshot: text });
		});
	}

	// Observe the snapshot that either path admits. A microtask avoids reentrant
	// append while the session is publishing the user message.
	ctx.on("session/event", (session, event) => {
		const header = session?.header;
		if (header?.agentPreset !== SIDE_PRESET || typeof header.parentSession !== "string") return;
		if (event.type !== "user/message" || event.data?.source?.kind !== "session-reference") return;
		const references = event.data.source.references ?? [];
		if (!references.some((reference) => reference?.sessionId === header.parentSession)) return;
		recordSnapshotEvent(session, event, header.parentSession);
	}, "side-chat snapshot observer");

	/** Append a refresh-state record visible to the projection and UI. */
	function publishRefresh(session, state, extra = {}) {
		appendRecord(session, "plugin:side-chat/refresh", {
			state,
			requestedAt: extra.requestedAt ?? Date.now(),
			...(extra.errorCode === void 0 ? {} : { errorCode: extra.errorCode }),
		});
	}

	/** Capture and replace (or append) the one live snapshot node. */
	async function applyRefresh(mainId, sideId, agent, requestedAt, signal) {
		const session = agent.session;
		publishRefresh(session, "preparing", { requestedAt });
		await options.beforeRefreshCapture?.({ mainId, sideId });
		const captured = await captureSnapshot(agent, mainId, signal);
		if (signal?.aborted === true || disposed || closedSides.has(sideId)) throw new Error("refresh cancelled");
		const currentSeq = surfaceSnapshotSeq(session, mainId);
		const message = {
			role: "user",
			id: randomUUID(),
			content: [{ type: "text", text: captured.text }],
			source: {
				kind: "session-reference",
				form: "recall",
				version: 1,
				references: [{ sessionId: mainId, label: "主对话" }],
			},
		};
		const node = currentSeq === void 0
			? session.append("user/message", message, { surfaceOp: "append" })
			: session.append("user/message", message, {
				surfaceOp: { op: "replace", startSeq: currentSeq, endSeq: currentSeq },
				sourceEventSeqs: [currentSeq],
			});
		recordedSnapshots.add(`${session.id}:${node.seq}`);
		contextSnapshots.set(sideId, captured);
		const meta = {
			mainId,
			...captured.meta,
			snapshotSeq: node.seq,
		};
		appendRecord(session, "plugin:side-chat/context", { ...meta, snapshot: captured.text });
		publishRefresh(session, "applied", { requestedAt });
		return { pending: false };
	}

	/** Queue a refresh until the current turn finishes, without capturing twice. */
	function scheduleRefresh(mainId, sideId, agent, requestedAt) {
		const existing = refreshing.get(sideId);
		if (existing !== void 0) return existing;
		const controller = new AbortController();
		refreshControllers.set(sideId, controller);
		const task = agent.whenIdle()
			.then(() => {
				if (disposed || closedSides.has(sideId) || controller.signal.aborted) return { pending: false, cancelled: true };
				return applyRefresh(mainId, sideId, agent, requestedAt, controller.signal);
			})
			.catch((error) => {
				if (!disposed && !closedSides.has(sideId)) {
					publishRefresh(agent.session, "failed", { requestedAt, errorCode: errorCodeOf(error) });
				}
				return { pending: false, error: safeErrorText(error) };
			})
			.finally(() => {
				refreshing.delete(sideId);
				refreshControllers.delete(sideId);
			});
		refreshing.set(sideId, task);
		return task;
	}

	/** User-triggered refresh; ordinary follow-ups never call this. */
	async function requestRefresh(mainId, sideId) {
		if (disposed) throw new Error("side-chat host disposed");
		if (!isSideSessionId(sideId) || active.get(mainId) !== sideId) throw new Error("side session is not active");
		const agent = ctx.agents.get(sideId);
		if (agent === void 0) throw new Error("side session not found");
		assertReusable(mainId, agent.session.header, sideId);
		const state = contextStateOf(agent.session, mainId);
		if (state.snapshotSeq === null) throw new Error("context is not ready");
		if (refreshing.has(sideId)) return { pending: true };
		const requestedAt = Date.now();
		if (agent.status === "running") {
			publishRefresh(agent.session, "pending", { requestedAt });
			void scheduleRefresh(mainId, sideId, agent, requestedAt);
			return { pending: true };
		}
		const controller = new AbortController();
		refreshControllers.set(sideId, controller);
		const task = (async () => {
			try {
				return await applyRefresh(mainId, sideId, agent, requestedAt, controller.signal);
			} catch (error) {
				if (!controller.signal.aborted) publishRefresh(agent.session, "failed", { requestedAt, errorCode: errorCodeOf(error) });
				throw error;
			} finally {
				refreshing.delete(sideId);
				refreshControllers.delete(sideId);
			}
		})();
		refreshing.set(sideId, task);
		return await task;
	}

	/** Rebuild a missing context record after a crash or a legacy side Session. */
	function reconcileContext(session, mainId) {
		const seq = surfaceSnapshotSeq(session, mainId);
		if (seq === void 0) return;
		const existing = readContextRecord(session, mainId);
		if (existing?.snapshotSeq === seq) return;
		const event = session.eventAt(seq);
		if (event !== undefined) recordSnapshotEvent(session, event, mainId);
	}

	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		const decision = await next();
		if (disposed || decision.kind === "reject") return decision;
		const header = agent?.session?.header;
		if (header?.agentPreset !== SIDE_PRESET || typeof header.parentSession !== "string") return decision;
		const mainId = header.parentSession;
		if (!decision.messages.some((message) => message.source?.kind === "user")) return decision;
		const already = decision.messages.some((message) => {
			if (message.source?.kind !== "session-reference") return false;
			return JSON.stringify(message.source.references ?? []).includes(mainId);
		});
		if (already) return decision;
		// `/side <question>` carries the official `dsh-session:` mention. The
		// built-in session-reference pre-step (prepended by the framework) turns
		// that mention into the snapshot itself; adding our own copy here would
		// put the same context in front of the model twice and persist both.
		if (ctx.get("sessionReferenceResolver") !== void 0 && messagesCiteSession(decision.messages, mainId)) return decision;
		// A snapshot already in the log/surface is never re-captured by a follow-up.
		if (surfaceSnapshotSeq(agent.session, mainId) !== void 0) return decision;
		let prepared;
		try {
			prepared = await mainSnapshot(agent, mainId, signal);
			await options.beforeContextAppend?.({ agent, mainId, snapshot: prepared.text, signal });
		} catch (error) {
			ctx.logger?.warn?.(`side-chat context unavailable: ${errorCodeOf(error)}`);
			return decision;
		}
		if (disposed || closedSides.has(agent.session.id)) return decision;
		const meta = prepared.meta ?? {};
		const context = {
			role: "user",
			id: randomUUID(),
			content: [{ type: "text", text: prepared.text }],
			source: {
				kind: "session-reference",
				form: "recall",
				version: 1,
				references: [{
					sessionId: mainId,
					label: "主对话",
					...(meta.capturedFormatVersion === null || meta.capturedFormatVersion === void 0 ? {} : { capturedFormatVersion: meta.capturedFormatVersion }),
					...(meta.capturedThroughSeq === null || meta.capturedThroughSeq === void 0 ? {} : { capturedThroughSeq: meta.capturedThroughSeq }),
					truncated: meta.truncated === true,
					omittedMessages: meta.omittedMessages ?? 0,
					omittedBytes: meta.omittedBytes ?? 0,
				}],
			},
		};
		return { ...decision, messages: [...decision.messages, context] };
	});

	ctx.commands.register({
		name: "side",
		description: "打开临时侧聊：只解释和讨论，不打断主任务",
		input: { hint: "可选：直接提问" },
		recordInput: false,
		handler: async ({ agent, rawInput }) => {
			const mainId = agent.session.header.id;
			const typed = typeof rawInput === "string" ? rawInput.trim() : "";
			if (typed.startsWith("--ensure ")) {
				const ensureId = typed.slice("--ensure ".length).trim();
				try {
					await ensureOwned(mainId, ensureId);
					return { kind: "success", text: "ensured" };
				} catch (error) {
					return { kind: "error", text: safeErrorText(error) };
				}
			}
			if (typed.startsWith("--close ")) {
				const closingId = typed.slice("--close ".length).trim();
				const result = await closeSide(mainId, closingId);
				if (result.ok) {
					removePendingClose(mainId, closingId);
					return { kind: "success", text: "closed" };
				}
				addPendingClose(mainId, closingId, result.code ?? "DELETE_FAILED", result.validated === true);
				return { kind: "error", text: result.error };
			}
			if (typed.startsWith("--refresh ")) {
				const refreshId = typed.slice("--refresh ".length).trim();
				try {
					const result = await requestRefresh(mainId, refreshId);
					return { kind: "success", text: result.pending ? "refresh-pending" : "refresh-ready" };
				} catch (error) {
					return { kind: "error", text: safeErrorText(error) };
				}
			}
			if (typed.startsWith("--retry-send ")) {
				const retryId = typed.slice("--retry-send ".length).trim();
				try {
					const result = await retrySend(mainId, retryId);
					return { kind: "success", text: result.sent ? "send-retried" : "send-already-accepted" };
				} catch (error) {
					return { kind: "error", text: safeErrorText(error) };
				}
			}
			if (typed === "--retry-close") {
				const cleaned = await retryCleanupTargets(mainId);
				return cleaned > 0 ? { kind: "success", text: "cleanup-retried" } : { kind: "error", text: "待清理的侧聊仍未删除" };
			}
			if (typed.startsWith("--check-update ")) {
				const [target, requestId] = typed.slice("--check-update ".length).trim().split(/\s+/u);
				try {
					const header = ctx.agents.get(target)?.session.header ?? await readStoredHeader(target);
					if (!header) throw new Error("side session unavailable");
					assertReusable(mainId, header, target);
					const report = { ...(await updateChecker.check()), requestId: requestId ?? null };
					if (disposed) return { kind: "error", text: "更新检查已取消" };
					appendRecord(ctx.agents.get(target)?.session ?? agent.session, "plugin:side-chat/update", report);
					return { kind: "success", text: "update-ready" };
				} catch { return { kind: "error", text: "无法检查插件更新" }; }
			}
			if (typed.startsWith("--status ")) {
				const [target, requestId] = typed.slice("--status ".length).trim().split(/\s+/u);
				try {
					const report = { ...(await statusReport(mainId, target)), requestId: requestId ?? null };
					const session = ctx.agents.get(target)?.session ?? agent.session;
					appendRecord(session, "plugin:side-chat/status", report);
					return { kind: "success", text: "status-ready" };
				} catch (error) {
					return { kind: "error", text: safeErrorText(error) };
				}
			}
			if (typed.startsWith("--diagnose ")) {
				const [target, requestId] = typed.slice("--diagnose ".length).trim().split(/\s+/u);
				try {
					const report = { ...(await diagnosticReport(mainId, target)), requestId: requestId ?? null };
					const session = ctx.agents.get(target)?.session ?? agent.session;
					appendRecord(session, "plugin:side-chat/diagnostic", report);
					return { kind: "success", text: "diagnostic-ready" };
				} catch (error) {
					return { kind: "error", text: safeErrorText(error) };
				}
			}

			await retryCleanupTargets(mainId);
			let pending = typed === "" ? retryable.get(mainId) : void 0;
			if (pending !== void 0 && (pending.state === "accepted" || pending.state === "completed")) {
				// An accepted or finished question is never replayed merely because
				// the user typed a bare /side again.
				clearSend(mainId);
				pending = void 0;
			}
			if (typed !== "") pending = {
				text: typed,
				requestId: randomUUID(),
				sideId: null,
				state: "pending",
				createdAt: Date.now(),
				errorCode: null,
				updatedAt: Date.now(),
			};
			if (typed !== "") {
				retryable.set(mainId, pending);
				savePending(retryable);
			}
			try {
				const entry = await ensureSide(agent);
				if (pending !== void 0) {
					const next = { ...pending, sideId: entry.sideId };
					retryable.set(mainId, next);
					savePending(retryable);
					publishSendState(entry.agent.session, next);
					const asked = askSide(entry, next.text, next.requestId);
					if (asked.duplicate === false) {
						// State is queued now; acceptance/completion arrive through session/event.
					}
				}
				return { kind: "success" };
			} catch (error) {
				if (pending !== void 0) {
					updateSend(mainId, { state: "failed", errorCode: "NOT_ENQUEUED" });
				}
				return { kind: "error", text: `旁支对话未发送：${safeErrorText(error)}` };
			}
		},
	});

	/** The active side Session id for one main Session, if any. */
	function activeSideId(mainId) {
		return active.get(mainId);
	}

	/** Map a host error to a stable, non-sensitive diagnostic code. */
	function errorCodeOf(error) {
		const message = String(error?.message ?? error);
		if (/no agent factory/u.test(message)) return "FACTORY_UNAVAILABLE";
		if (/not found/u.test(message)) return "NOT_FOUND";
		if (/belongs to/u.test(message)) return "OWNERSHIP_MISMATCH";
		if (/runs preset/u.test(message)) return "PRESET_MISMATCH";
		if (/no context|snapshot is empty|session-reference/u.test(message)) return "CONTEXT_UNAVAILABLE";
		if (/cancel/u.test(message)) return "CANCELLED";
		if (/held|生命周期/u.test(message)) return "AGENT_HELD";
		if (/release could not be confirmed/u.test(message)) return "RELEASE_UNCONFIRMED";
		if (/injected/u.test(message)) return "INJECTED_FAILURE";
		return "OPERATION_FAILED";
	}

	/** User-facing error text with ids, paths, and provider text removed. */
	function safeErrorText(error) {
		const code = errorCodeOf(error);
		switch (code) {
			case "FACTORY_UNAVAILABLE": return "宿主尚未就绪，请稍后重试";
			case "NOT_FOUND": return "侧聊记录不存在";
			case "OWNERSHIP_MISMATCH": return "侧聊归属校验失败";
			case "PRESET_MISMATCH": return "侧聊预设校验失败";
			case "CONTEXT_UNAVAILABLE": return "主对话上下文暂不可用";
			case "CANCELLED": return "操作已取消";
			case "AGENT_HELD": return "侧聊仍被其他生命周期持有";
			case "RELEASE_UNCONFIRMED": return "无法确认侧聊已释放";
			default: return `操作失败（${code}）`;
		}
	}

	/** Map one cleanup failure to the reason code shown in the pending banner. */
	function closeReasonCode(error) {
		const code = errorCodeOf(error);
		if (code === "AGENT_HELD" || code === "RELEASE_UNCONFIRMED") return "AGENT_HELD";
		if (code === "NOT_FOUND") return "NOT_FOUND";
		if (code === "OWNERSHIP_MISMATCH" || code === "PRESET_MISMATCH") return "VALIDATION_FAILED";
		if (code === "INJECTED_FAILURE") return "INJECTED_FAILURE";
		return "DELETE_FAILED";
	}

	/** Retry every cleanup target without dropping the others; returns how many succeeded. */
	async function retryCleanupTargets(mainId) {
		const targets = pendingClose.get(mainId);
		if (targets === void 0) return 0;
		let cleaned = 0;
		for (const sideId of [...targets.keys()]) {
			const result = await closeSide(mainId, sideId);
			if (result.ok) {
				removePendingClose(mainId, sideId);
				cleaned += 1;
				continue;
			}
			ctx.logger?.warn?.(`side-chat cleanup ${sideId} failed: ${result.code ?? "DELETE_FAILED"}`);
			if (active.get(mainId) === sideId) {
				setActive(mainId, null);
				publishBinding(ctx.agents.get(mainId)?.session, null);
			}
		}
		return cleaned;
	}

	/** Host-side service checks used by the user-triggered status panel. */
	function serviceChecks() {
		const names = ["commands", "agents", "sessions", "sessionProjections", "agentPresets", "sessionQuery", "sessionReferenceResolver", "workspaceRegistry", "agentDefaultModel"];
		return names.map((name) => ({ code: `service.${name}`, ok: ctx.get(name) !== void 0 }));
	}

	/** Redacted correlation id: stable for one main/side pair, not reversible. */
	function correlationId(mainId, sideId) {
		return createHash("sha256").update(`${mainId}\u0000${sideId}`).digest("hex").slice(0, 12);
	}

	/** User-triggered, redacted status shared by the panel and diagnostic export. */
	async function statusReport(mainId, sideId) {
		const agent = isSideSessionId(sideId) ? ctx.agents.get(sideId) : void 0;
		const header = agent?.session.header;
		const context = agent === void 0 ? { status: "unavailable" } : contextStateOf(agent.session, mainId);
		const checks = serviceChecks();
		checks.push({ code: "side.found", ok: header !== void 0 });
		checks.push({ code: "side.parent", ok: header?.parentSession === mainId });
		checks.push({ code: "side.preset", ok: header?.agentPreset === SIDE_PRESET });
		checks.push({ code: "side.owned", ok: handles.has(sideId) });
		checks.push({ code: "side.live", ok: agent !== void 0 });
		const targets = pendingClose.get(mainId);
		const send = retryable.get(mainId);
		return {
			schema: "sidestatus/1",
			generatedAt: new Date().toISOString(),
			correlationId: correlationId(mainId, sideId),
			checks,
			binding: {
				active: active.get(mainId) === sideId,
				owned: handles.has(sideId),
				live: agent !== void 0,
			},
			context,
			pending: {
				send: send?.sideId === sideId ? { state: send.state, errorCode: send.errorCode ?? null, retryable: send.state === "pending" || send.state === "queued" || send.errorCode === "NOT_ENQUEUED" } : null,
				cleanup: targets?.size ?? 0,
			},
			persistence: {
				active: stateHealth.active.status,
				pending: stateHealth.pending.status,
				pendingClose: stateHealth.pendingClose.status,
				backup: stateHealth.active.backup === true || stateHealth.pending.backup === true || stateHealth.pendingClose.backup === true,
			},
		};
	}

	/** Whitelisted diagnostic payload; no titles, ids, paths, text, or raw errors. */
	async function diagnosticReport(mainId, sideId) {
		const status = await statusReport(mainId, sideId);
		return {
			schema: "sidechat-diagnostic/1",
			pluginVersion: PLUGIN_VERSION,
			supportedHarness: SUPPORTED_HARNESS,
			generatedAt: status.generatedAt,
			correlationId: status.correlationId,
			checks: status.checks.map((check) => ({ code: check.code, ok: check.ok === true })),
			binding: { active: status.binding.active === true, owned: status.binding.owned === true, live: status.binding.live === true },
			context: {
				status: typeof status.context?.status === "string" ? status.context.status : "unknown",
				capturedAt: typeof status.context?.capturedAt === "string" ? status.context.capturedAt : null,
				truncated: status.context?.truncated === true,
				omittedMessages: typeof status.context?.omittedMessages === "number" ? status.context.omittedMessages : 0,
				omittedBytes: typeof status.context?.omittedBytes === "number" ? status.context.omittedBytes : 0,
				errorCode: typeof status.context?.errorCode === "string" ? status.context.errorCode : null,
			},
			pending: {
				send: status.pending.send === null ? null : { state: status.pending.send.state, errorCode: status.pending.send.errorCode, retryable: status.pending.send.retryable },
				cleanup: status.pending.cleanup,
			},
			persistence: status.persistence,
			failures: status.checks.filter((check) => !check.ok).map((check) => check.code),
		};
	}

	/** Re-enqueue one not-yet-accepted question with its original rpcId. */
	async function retrySend(mainId, sideId) {
		const pending = retryable.get(mainId);
		if (pending === void 0 || pending.sideId !== sideId) throw new Error("no pending send for this side session");
		const agent = ctx.agents.get(sideId);
		if (agent === void 0) throw new Error("side session not found");
		if (sideHasRequest(agent.session, pending.requestId)) {
			updateSend(mainId, { state: "accepted", errorCode: null });
			return { sent: false };
		}
		const cached = sides.get(mainId);
		const entry = cached?.sideId === sideId
			? cached
			: { mainId, sideId, agent, firstSent: sideHasUserMessage(agent.session) };
		const asked = askSide(entry, pending.text, pending.requestId);
		return { sent: asked.duplicate === false };
	}

	/**
	 * End and DELETE one side Session. Host-owned: validates lineage, stops the
	 * Agent, flushes, removes the log + projection cache, then verifies removal.
	 * The binding, retry ledger and first-sent state die with it.
	 */
	async function closeSide(mainId, sideId) {
		if (!isSideSessionId(sideId)) {
			return { ok: false, error: "invalid side session id", code: "INVALID_ID" };
		}
		await adoptions.get(sideId)?.catch(() => void 0);
		const live = ctx.agents.get(sideId);
		let stored;
		try {
			stored = await readStoredHeader(sideId);
		} catch {
			/* not persisted */
		}
		const header = live?.session.header ?? stored;
		let validated = false;
		if (header === void 0) {
			// A failed delete may have removed the log before the directory/cache
			// pass. Only a target this Host already validated for this main Session
			// may continue as a storage-only cleanup.
			if (pendingClose.get(mainId)?.get(sideId)?.validated !== true) {
				return { ok: false, error: "side session not found", code: "NOT_FOUND", validated: false };
			}
		} else {
			if (header.parentSession !== mainId) {
				return { ok: false, error: "side session belongs to a different main conversation", code: "OWNERSHIP_MISMATCH", validated: false };
			}
			if (header.agentPreset !== SIDE_PRESET) {
				return { ok: false, error: "side session preset does not match", code: "PRESET_MISMATCH", validated: false };
			}
			validated = true;
		}
		// Stop accepting new work for this very session before touching storage.
		markClosed(sideId);
		refreshControllers.get(sideId)?.abort();
		if (active.get(mainId) === sideId) {
			setActive(mainId, null);
			publishBinding(ctx.agents.get(mainId)?.session, null);
		}
		const cached = sides.get(mainId);
		if (cached !== void 0 && cached.sideId === sideId) sides.delete(mainId);
		if (retryable.get(mainId)?.sideId === sideId) clearSend(mainId);

		try {
			await options.closeFailure?.({ mainId, sideId });
			const session = live?.session;
			const handle = handles.get(sideId);
			if (live !== void 0 && handle === void 0) {
				// The Agent is owned by another lifecycle holder (the client's Session
				// retain, restored by the session-controller after a reload). The tab
				// closes first, which releases that retain and disposes the Agent;
				// wait for the registry to drop it instead of deleting under a writer.
				for (let attempt = 0; attempt < 80 && ctx.agents.get(sideId) !== void 0; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				if (ctx.agents.get(sideId) !== void 0) {
					throw new Error("侧聊 Agent 仍被其他生命周期持有，无法安全释放");
				}
			} else {
				if (live !== void 0) live.cancel("side-chat closed");
				if (handle !== void 0) await handle.dispose();
				handles.delete(sideId);
				if (live !== void 0 && (ctx.agents.get(sideId) !== void 0 || ctx.sessions.get(sideId) !== void 0)) {
					throw new Error("agent release could not be confirmed; refusing to delete");
				}
			}
			if (session !== void 0) {
				try {
					await ctx.sessions.flush(session);
				} catch {
					/* already detached */
				}
			}
			const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
			const root = join(home, "sessions");
			const cacheFile = join(home, "storages", "session_projcache", "sessions", `${sideId}.json`);
			// Let the cancelled turn's closing events settle before the first pass,
			// then re-delete anything that a late writer re-materialized.
			await new Promise((resolve) => setTimeout(resolve, 150));
			for (let pass = 0; pass < 6; pass += 1) {
				const buckets = existsSync(root) ? readdirSync(root) : [];
				for (const bucket of buckets) {
					const dir = join(root, bucket, sideId);
					if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
				}
				if (existsSync(cacheFile)) rmSync(cacheFile, { force: true });
				const remaining = buckets.filter((bucket) => existsSync(join(root, bucket, sideId)));
				if (remaining.length === 0 && !existsSync(cacheFile)) {
					await new Promise((resolve) => setTimeout(resolve, 200));
					const again = existsSync(root)
						? readdirSync(root).filter((bucket) => existsSync(join(root, bucket, sideId)))
						: [];
					if (again.length === 0 && !existsSync(cacheFile)) break;
				}
			}
			const buckets = existsSync(root) ? readdirSync(root) : [];

			// Index cleanup: drop this id from any workspace membership list.
			try {
				const registry = ctx.get("workspaceRegistry");
				const workspaces = registry === void 0 ? [] : await registry.list();
				for (const workspace of workspaces) {
					if (workspace.sessionIds?.includes(sideId)) await workspace.detachSession(sideId);
				}
			} catch {
				/* membership is index-only; deletion above is authoritative */
			}

			const leftovers = buckets.filter((bucket) => existsSync(join(root, bucket, sideId)));
			if (leftovers.length > 0 || existsSync(cacheFile)) {
				return { ok: false, error: "delete incomplete", code: "DELETE_INCOMPLETE", validated };
			}
			removePendingClose(mainId, sideId);
			clearSideCaches(sideId);
			return { ok: true };
		} catch (error) {
			// Keep the binding so a later close attempt can retry the cleanup.
			closedSides.delete(sideId);
			if (!active.has(mainId)) setActive(mainId, sideId);
			return { ok: false, error: safeErrorText(error), code: closeReasonCode(error), validated };
		}
	}

	/** Dispose the live side Agent (support/test); persistence keeps the Session. */
	async function releaseSide(mainId) {
		const entry = sides.get(mainId);
		if (entry === void 0) return false;
		sides.delete(mainId);
		handles.delete(entry.sideId);
		if (entry.handle !== void 0) await entry.handle.dispose();
		return true;
	}

	/** Cancel only the side Agent's active turn; the main Agent is untouched. */
	function cancelSide(mainId) {
		const entry = sides.get(mainId);
		if (entry === void 0 || entry.agent === void 0) return false;
		entry.agent.cancel("side-chat cancelled");
		return true;
	}

	/** Release host-owned handles and cancel any queued refresh work. */
	async function dispose() {
		disposed = true;
		await updateChecker.dispose();
		for (const controller of refreshControllers.values()) controller.abort();
		for (const handle of handles.values()) {
			try {
				await handle.dispose();
			} catch {
				/* already disposed */
			}
		}
		handles.clear();
		sides.clear();
		refreshing.clear();
		refreshControllers.clear();
		contextSnapshots.clear(); contextBuilds.clear(); recordedSnapshots.clear();
		closedSides.clear(); closedOrder.length = 0;
		creating.clear(); adoptions.clear();
		// Durable ledgers stay on disk for a subsequent host. Drop this disposed
		// instance's in-memory copies, including retained retry question text.
		active.clear(); retryable.clear(); pendingClose.clear();
	}

	return {
		ensureSide,
		askSide,
		cancelSide,
		assertReusable,
		releaseSide,
		closeSide,
		activeSideId,
		requestRefresh,
		retrySend,
		retryCleanupTargets,
		statusReport,
		diagnosticReport,
		contextStateOf,
		dispose,
		hasHandle: (id) => handles.has(id),
		takeHandle: (id) => {
			const handle = handles.get(id);
			handles.delete(id);
			return handle;
		},
		forgetHandle: (id) => handles.delete(id),
		awaitAdoptions: () => Promise.all([...adoptions.values()].map((promise) => promise.catch(() => void 0))),
		state: { active, pending: retryable, pendingClose, sides, handles, adoptions },
	};

}
