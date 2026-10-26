window.__ModuleLoader__.load({
	id: "dsh-client-ui-side",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		let clientCtx = null;

		const PLUGIN_ID = "dsh-client-ui-side";
		/** Right-Sidebar tab kind registered by this plugin. */
		const KIND = "sidechat";
		const SIDE_PRESET = "side-chat";
		/** Resource protocol for a side conversation. */
		const PROTOCOL = "sidechat";
		const ADDRESS_PREFIX = `dsh-resource://${PROTOCOL}/session/`;
		const FALLBACK_TITLE = "侧边聊天";
		/** Normalize the public Session list; older clients expose the manager's items form. */
		function sessionRows(snapshot) {
			if (snapshot?.byId !== null && typeof snapshot?.byId === "object") {
				return Object.entries(snapshot.byId).filter(([, row]) => row !== null && typeof row === "object").map(([id, row]) => ({
					...row,
					sessionId: row.id ?? id,
					parentSessionId: row.parentId ?? row.parentSessionId
				}));
			}
			return Array.isArray(snapshot?.items) ? snapshot.items : [];
		}

		/**
		 * Side Sessions stay unarchived so their turns run (an archived Session
		 * rejects every turn), yet their rows must not appear in the left
		 * sidebar. The row carries `data-row-key="session:<id>"`, so one style
		 * rule per hidden Session removes it without touching host state.
		 */
		const hiddenSideSessions = new Set();
		let hiddenStyleTag = null;

		/** Re-render the hidden-row stylesheet from the current set. */
		function refreshHiddenRows() {
			if (hiddenStyleTag === null) return;
			hiddenStyleTag.textContent = [...hiddenSideSessions]
				.map((id) => `[data-row-key="session:${id}"]{display:none!important}`)
				.join("\n");
		}

		/** Stop hiding a row whose Session is gone or closed. */
		function unhideSideRow(sessionId) {
			if (hiddenSideSessions.delete(sessionId)) refreshHiddenRows();
		}

		/** Hide one side Session's sidebar row. */
		function hideSideRow(sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") return;
			if (hiddenSideSessions.has(sessionId)) return;
			hiddenSideSessions.add(sessionId);
			refreshHiddenRows();
		}
		/**
		 * Side Session id → the main Session it was opened from.
		 *
		 * The composer dock attributes a side Session's tokens to the main
		 * conversation that spawned it. `undefined` means "not known yet"; the
		 * Session list entry's `parentSessionId` supplies it then.
		 */
		const sideParents = new Map();
		/** React subscribers of the side-usage aggregate. */
		const sideUsageListeners = new Set();

		/** Notify dock components that the aggregate may have changed. */
		function notifySideUsage() {
			for (const listener of sideUsageListeners) listener();
		}

		/**
		 * Record (or keep) a side Session's parent without losing a known one.
		 * @param childId - side Session id.
		 * @param parentId - main Session it was opened from, when known.
		 */
		function rememberSideSession(childId, parentId) {
			if (typeof childId !== "string" || childId === "") return;
			if (!sideParents.has(childId)) {
				sideParents.set(childId, parentId);
				notifySideUsage();
				return;
			}
			const previous = sideParents.get(childId);
			if (previous === parentId || parentId === void 0) return;
			sideParents.set(childId, parentId);
			notifySideUsage();
		}

		/** Drop a side Session's accounting entry. */
		function forgetSideSession(childId) {
			if (sideParents.delete(childId)) notifySideUsage();
		}

		/** Live Session instances of open side tabs, for direct projection reads. */
		const sideRuntimes = new Map();
		/** Per-side projection subscriptions that re-notify the aggregate. */
		const runtimeSubscriptions = new Map();

		/**
		 * Adopt a side Session instance: read its `tokenUsage` projection directly and
		 * re-notify whenever that projection changes.
		 * @param childId - side Session id.
		 * @param session - its client Session instance.
		 */
		function rememberSideRuntime(childId, session) {
			if (typeof childId !== "string" || session === void 0 || session === null) return;
			if (sideRuntimes.has(childId)) return;
			sideRuntimes.set(childId, session);
			try {
				const face = session.projections?.faceOf?.("tokenUsage");
				if (face !== void 0) {
					const unsubscribe = face.subscribe(() => notifySideUsage());
					runtimeSubscriptions.set(childId, unsubscribe);
				}
			} catch {
				/* projection store absent: the list fallback still applies */
			}
			notifySideUsage();
		}

		/** Drop a side Session instance and its projection subscription. */
		function forgetSideRuntime(childId) {
			if (!sideRuntimes.has(childId)) return;
			const unsubscribe = runtimeSubscriptions.get(childId);
			if (typeof unsubscribe === "function") unsubscribe();
			runtimeSubscriptions.delete(childId);
			sideRuntimes.delete(childId);
			notifySideUsage();
		}

		/** Compact token figure, matching the official pill: 950, 12.3k, 135k, 1.2M. */
		function formatTokenFigure(value) {
			const scaled = (candidate) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
			if (value < 1e3) return String(value);
			if (value < 1e6) return `${scaled(value / 1e3)}k`;
			return `${scaled(value / 1e6)}M`;
		}

		/**
		 * Sum the `tokenUsage` projections of every side Session owned by one main
		 * Session. Cache-hit and throughput stay local to each Session; only the
		 * total is aggregated here.
		 * @param snapshot - current `ctx.sessions.list` snapshot.
		 * @param sessionId - the main Session whose dock asks.
		 * @returns summed buckets and how many side Sessions contributed.
		 */
		function readSideUsage(snapshot, sessionId) {
			const empty = { total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, count: 0 };
			if (sessionId === void 0) return empty;
			const projections = snapshot?.projectionsBySession ?? {};
			const bySession = new Map();
			for (const entry of sessionRows(snapshot)) bySession.set(entry.sessionId, entry);
			let input = 0;
			let cacheRead = 0;
			let cacheWrite = 0;
			let output = 0;
			let count = 0;
			for (const [childId, knownParent] of sideParents) {
				const parent = knownParent ?? bySession.get(childId)?.parentSessionId;
				if (parent !== sessionId) continue;
				const runtime = sideRuntimes.get(childId);
				const usage = (runtime === void 0 ? void 0 : runtime.projections?.get?.("tokenUsage")) ?? projections[childId]?.values?.tokenUsage;
				if (usage === void 0) continue;
				input += usage.uncachedInputTokens ?? 0;
				cacheRead += usage.cacheReadTokens ?? 0;
				cacheWrite += usage.cacheWriteTokens ?? 0;
				output += usage.outputTokens ?? 0;
				count += 1;
			}
			return {
				total: input + cacheRead + cacheWrite + output,
				input,
				cacheRead,
				cacheWrite,
				output,
				count
			};
		}

		//#region 地址
		/** Build a side-chat address carrying the owning main Session. */
		function sideAddress(mainSessionId, sideId) {
			return `${ADDRESS_PREFIX}${encodeURIComponent(sideId)}?main=${encodeURIComponent(mainSessionId)}`;
		}

		/** Parse both identities from a side-chat address. */
		function parseAddress(address) {
			if (typeof address !== "string" || !address.startsWith(ADDRESS_PREFIX)) return void 0;
			const rest = address.slice(ADDRESS_PREFIX.length);
			const [path, query = ""] = rest.split("?");
			if (path === void 0 || path === "") return void 0;
			const params = new URLSearchParams(query.split("#")[0]);
			const mainId = params.get("main") ?? void 0;
			try {
				return { sideId: decodeURIComponent(path), mainId };
			} catch {
				return { sideId: path, mainId };
			}
		}

		function parseSessionId(address) {
			if (typeof address !== "string") return void 0;
			if (!address.startsWith(ADDRESS_PREFIX)) return void 0;
			const rest = address.slice(ADDRESS_PREFIX.length).split(/[?#]/u)[0] ?? "";
			if (rest === "") return void 0;
			try {
				return decodeURIComponent(rest);
			} catch {
				return rest;
			}
		}
		//#endregion

		//#region 资源提供者
		/**
		 * Retain one side Session for as long as its tab body is mounted.
		 * @param sessions - the client Session model.
		 * @returns a resource provider for the `sidechat` protocol.
		 */
		function sideChatResourceProvider(ctx) {
			const sessions = ctx.sessions;
			/**
			 * Instance-scoped handshake: ask THIS Host process to adopt the side
			 * Session and report whether it now holds a live AgentHandle. A durable
			 * projection claim is deliberately not trusted.
			 */
			async function ensureOwned(mainId, sideId, signal) {
				if (mainId === undefined) return; // legacy tab without the owning id
				for (let attempt = 0; attempt < 80; attempt++) {
					if (signal.aborted) return;
					const outcome = await ctx.remote.commands.execute(mainId, `/side --ensure ${sideId}`, [], signal);
					if (signal.aborted) return;
					if (outcome.ok && outcome.value?.result?.kind === "success") return;
					if (outcome.ok && outcome.value?.result?.kind === "error") throw new Error(outcome.value.result.text ?? "宿主未确认侧聊所有权");
					if (!outcome.ok && outcome.error?.code !== "OPERATION_FAILED" && outcome.error?.code !== "gateway/internal") throw new Error(outcome.error?.message ?? "ensure RPC failed");
					// On native enable the provider can arrive just before its host command.
					// Retry only availability failures; never retain before ownership succeeds.
					await new Promise((resolve) => {
						let timer;
						const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
						timer = setTimeout(done, 100);
						signal.addEventListener("abort", done, { once: true });
						if (signal.aborted) done();
					});
				}
				throw new Error("侧聊服务暂不可用，请重新启用插件或按提示重启 Harness。");
			}

			return {
				protocol: PROTOCOL,
				async *open(address, { signal }) {
					const parsed = parseAddress(address);
					const sessionId = parsed?.sideId;
					if (sessionId === void 0) throw new Error(`${PLUGIN_ID}: invalid address "${address}"`);
					if (signal.aborted) return;
					try {
						await ensureOwned(parsed.mainId, sessionId, signal);
					} catch (error) {
						if (!signal.aborted) yield { ok: false, error: { code: "SIDE_UNAVAILABLE", message: error instanceof Error ? error.message : "侧聊服务不可用" } };
						return;
					}
					if (signal.aborted) return;
					const reference = sessions.retain(sessionId, {
						source: "sideChat",
						signal
					});
					let onAbort;
					try {
						rememberSideRuntime(sessionId, reference.binding?.session);
						yield {
							ok: true,
							value: {
								sessionId,
								reference
							}
						};
						await new Promise((resolve) => {
							if (signal.aborted) return resolve();
							onAbort = resolve;
							signal.addEventListener("abort", onAbort, { once: true });
						});
					} finally {
						if (onAbort !== void 0) signal.removeEventListener("abort", onAbort);
						try { reference.release(); } finally { forgetSideRuntime(sessionId); }
					}
				}
			};
		}
		//#endregion

		/** Main Session id for a side tab, if the public list knows it. */
		function mainIdFor(sideId) {
			const snapshot = clientCtx?.sessions.list.getSnapshot();
			const row = snapshot === void 0 ? void 0 : sessionRows(snapshot).find((item) => item.sessionId === sideId);
			return row?.parentSessionId;
		}

		/** Run one internal /side flag through the same host command path. */
		async function runSideFlag(sideId, flag, nonce) {
			const mainId = mainIdFor(sideId);
			if (mainId === void 0) throw new Error("主对话关联缺失");
			const line = `/side ${flag} ${sideId}${nonce === void 0 ? "" : ` ${nonce}`}`;
			const outcome = await clientCtx.remote.commands.execute(mainId, line, []);
			if (!outcome.ok) throw new Error(outcome.error?.message ?? "宿主 RPC 失败");
			const result = outcome.value?.result;
			if (result?.kind !== "success") throw new Error(result?.text ?? "宿主返回失败");
			return result;
		}

		/** Retry every cleanup target for one main conversation. */
		async function retryCleanup(mainId) {
			const outcome = await clientCtx.remote.commands.execute(mainId, "/side --retry-close", []);
			if (!outcome.ok) throw new Error(outcome.error?.message ?? "宿主 RPC 失败");
			const result = outcome.value?.result;
			if (result?.kind !== "success") throw new Error(result?.text ?? "清理仍未完成");
			return result;
		}

		/** Wait for one host status/diagnostic projection matching this request. */
		async function readProjection(sideId, key, nonce) {
			const mainId = mainIdFor(sideId);
			for (let attempt = 0; attempt < 60; attempt += 1) {
				const snapshot = clientCtx.sessions.list.getSnapshot();
				for (const id of [sideId, mainId]) {
					if (id === void 0) continue;
					const value = snapshot.projectionsBySession?.[id]?.values?.[key];
					if (value !== void 0 && value !== null && value.requestId === nonce) return value;
				}
				try {
					await clientCtx.sessions.refreshProjections?.(sideId);
					if (mainId !== void 0) await clientCtx.sessions.refreshProjections?.(mainId);
				} catch {
					/* keep polling */
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error("宿主未返回检查结果");
		}

		function nonce() {
			try {
				return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
			} catch {
				return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
			}
		}

		function formatCaptured(value) {
			if (typeof value !== "string" || value === "") return "未捕获";
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return "时间未知";
			const pad = (part) => String(part).padStart(2, "0");
			return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}

		function contextStatusLabel(status) {
			switch (status) {
				case "preparing": return "准备中";
				case "pending": return "刷新待生效";
				case "ready": return "已就绪";
				case "prepared": return "已准备，待发送";
				case "failed": return "刷新失败";
				default: return "尚未捕获";
			}
		}

		function usageTotal(usage) {
			if (usage === void 0 || usage === null) return void 0;
			return (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0);
		}

		/** Download the host-built diagnostic payload; no client data is added. */
		function downloadDiagnostic(payload) {
			if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") return;
			const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
			const link = document.createElement("a");
			link.href = URL.createObjectURL(blob);
			link.download = `sidechat-diagnostic-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`;
			link.click();
			setTimeout(() => URL.revokeObjectURL(link.href), 1000);
		}

		//#region 视图
		/** Centered empty state used until the side Session has its first turn. */
		function SideEmptyState() {
			return React.createElement("div", {
				"data-side-empty": "",
				style: {
					flex: "1 1 auto",
					minHeight: 0,
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					gap: "10px",
					padding: "0 20px",
					textAlign: "center",
					color: "var(--dsw-alias-label-tertiary)",
					boxSizing: "border-box",
					maxWidth: "100%",
					overflow: "hidden"
				}
			},
				React.createElement("svg", {
					width: 30,
					height: 30,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.6,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
					React.createElement("path", { d: "M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" }),
					React.createElement("path", { d: "M8.5 11h7M8.5 14.5h4.5" })
				),
				React.createElement("div", {
					style: { fontSize: "16px", fontWeight: 500, lineHeight: "24px", color: "var(--dsw-alias-label-primary)" }
				}, "侧边聊天"),
				React.createElement("div", {
					style: { fontSize: "13px", lineHeight: "20px", maxWidth: "240px", wordBreak: "break-word" }
				}, "针对主对话继续提问，结束侧聊后删除内容。")
			);
		}

		/**
		 * Views implementation for the side Session. It is a real flex child of
		 * the conversation scroll body: it grows when the Session is empty (so the
		 * composer sits at the panel bottom) and grows with content otherwise (so
		 * the scroll body scrolls). The empty state is hidden once a turn exists.
		 */
		function SideChatView(props) {
			return React.createElement("div", {
				"data-side-view": "",
				style: {
					flex: "1 0 auto",
					minHeight: 0,
					display: "flex",
					flexDirection: "column",
					width: "100%"
				}
			},
				React.createElement("div", {
					"data-side-view-content": "",
					style: { flex: "1 0 auto", minHeight: 0, display: "flex", flexDirection: "column", width: "100%" }
				}, props.renderSlot("conversation.session", { view: "chat" })),
				React.createElement(SideEmptyState)
			);
		}

		/** Context/status bar: snapshot provenance, explicit refresh, and diagnostics. */
		function SideContextBar({ sessionId, useProjection }) {
			const context = useProjection === void 0 ? void 0 : useProjection("sideChatContext");
			const send = useProjection === void 0 ? void 0 : useProjection("sideChatSend");
			const pressure = useProjection === void 0 ? void 0 : useProjection("contextPressure");
			const usage = useProjection === void 0 ? void 0 : useProjection("tokenUsage");
			const [busy, setBusy] = React.useState(false);
			const [panel, setPanel] = React.useState(null);
			const [error, setError] = React.useState(null);
			const run = async (task) => {
				setBusy(true);
				setError(null);
				try {
					return await task();
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
					return void 0;
				} finally {
					setBusy(false);
				}
			};
			const refresh = () => run(async () => {
				await runSideFlag(sessionId, "--refresh");
			});
			const check = () => run(async () => {
				const request = nonce();
				await runSideFlag(sessionId, "--status", request);
				const data = await readProjection(sessionId, "sideChatStatus", request);
				setPanel({ kind: "status", data });
			});
			const checkUpdate = () => run(async () => {
				const request = nonce();
				await runSideFlag(sessionId, "--check-update", request);
				setPanel({ kind: "update", data: await readProjection(sessionId, "sideChatUpdate", request) });
			});
			const diagnose = () => run(async () => {
				const request = nonce();
				await runSideFlag(sessionId, "--diagnose", request);
				const data = await readProjection(sessionId, "sideChatDiagnostic", request);
				setPanel({ kind: "diagnostic", data });
			});
			const retrySend = () => run(async () => {
				await runSideFlag(sessionId, "--retry-send");
			});
			const total = usageTotal(usage);
			const windowSize = pressure?.contextWindow;
			const pressureTokens = pressure?.pressureTokens ?? pressure?.projectedTokens;
			const percent = typeof windowSize === "number" && windowSize > 0 && typeof pressureTokens === "number"
				? Math.round((pressureTokens / windowSize) * 100)
				: void 0;
			const status = context?.status ?? "none";
			const sendVisible = send !== void 0 && send !== null && ["pending", "queued", "failed"].includes(send.state);
			const sendLabel = send?.state === "queued" ? "已入队" : send?.state === "failed" ? "发送失败" : "尚未送达";
			const canRetrySend = send?.state === "pending" || send?.state === "queued" || send?.errorCode === "NOT_ENQUEUED";
			const truncation = context?.truncated === true
				? `快照已截断${context.omittedMessages > 0 ? `，省略 ${context.omittedMessages} 条` : ""}${context.omittedBytes > 0 ? ` / ${context.omittedBytes} 字节` : ""}`
				: "";
			const refreshable = status === "ready" || status === "failed";
			const button = (label, action, disabled = false) => h("button", {
				type: "button",
				disabled: busy || disabled,
				onClick: action,
				style: {
					font: "inherit",
					fontSize: "11px",
					lineHeight: "18px",
					padding: "1px 7px",
					borderRadius: "5px",
					border: "0.5px solid var(--dsw-alias-border-l3)",
					background: "transparent",
					color: "var(--dsw-alias-label-secondary)",
					cursor: busy || disabled ? "default" : "pointer",
					whiteSpace: "nowrap",
				},
			}, label);
			const row = (children) => h("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px", minWidth: 0 } }, children);
			return h("div", {
				"data-side-context": "",
				style: {
					flex: "none",
					display: "flex",
					flexDirection: "column",
					gap: "4px",
					padding: "6px 16px",
					fontSize: "12px",
					lineHeight: "18px",
					color: "var(--dsw-alias-label-tertiary)",
					borderBottom: "0.5px solid var(--dsw-alias-border-l3)",
					minWidth: 0,
				},
			},
				row([
					h("span", { key: "title", style: { color: "var(--dsw-alias-label-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "180px" }, title: "只读快照；不会随主聊自动更新" }, `主对话：${context?.mainTitle ?? "主对话"}`),
					h("span", { key: "status", "data-side-context-status": status, style: status === "failed" ? { color: "var(--dsw-alias-label-warning, #b45309)" } : void 0 }, contextStatusLabel(status)),
					h("span", { key: "time" }, `捕获 ${formatCaptured(context?.capturedAt)}`),
				]),
				row([
					h("span", { key: "pressure" }, `上下文 ${percent === void 0 ? "—" : `${percent}%`}`),
					h("span", { key: "usage" }, `侧聊累计 ${total === void 0 ? "—" : formatTokenFigure(total)}`),
					button("刷新上下文", refresh, !refreshable),
					button("检查状态", check),
					button("检查更新", checkUpdate),
					button("诊断导出", diagnose),
				]),
				truncation === "" ? null : h("div", { style: { color: "var(--dsw-alias-label-warning, #b45309)" } }, truncation),
				status === "failed" ? h("div", { style: { color: "var(--dsw-alias-label-warning, #b45309)" } }, `刷新失败（${context?.errorCode ?? "REFRESH_FAILED"}）；当前仍使用上一次有效快照。`) : null,
				status === "pending" ? h("div", { style: { color: "var(--dsw-alias-label-secondary)" } }, "刷新已排队，将在当前回答结束后生效。") : null,
				error === null ? null : h("div", { style: { color: "var(--dsw-alias-label-warning, #b45309)" } }, error),
				sendVisible ? h("div", {
					"data-side-send": send.state,
					style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px", padding: "2px 8px", borderRadius: "6px", background: "var(--dsw-alias-interactive-bg-hover)" },
				},
					h("span", { key: "label" }, `${sendLabel}：${send.text.length > 60 ? `${send.text.slice(0, 60)}…` : send.text}`),
					canRetrySend ? button("重试发送", retrySend) : h("span", { key: "hint" }, "已接纳；本轮失败可在对话中重试"),
					send.errorCode === null || send.errorCode === void 0 ? null : h("span", { key: "code" }, `（${send.errorCode}）`),
				) : null,
				panel === null ? null : h(SideDiagnosticPanel, {
					panel,
					onClose: () => setPanel(null),
					onDownload: () => {
						const { requestId: _requestId, ...payload } = panel.data;
						downloadDiagnostic(payload);
					},
				}),
			);
		}

		function SideUpdatePanel({ data }) {
			const labels = { disabled: "更新服务未启用：尚未配置公开发布地址；本次没有联网。", "up-to-date": "当前已是适用于此 Harness 版本的最新版。", "no-compatible": "暂未找到兼容当前 Harness 的发布版本。", cancelled: "更新检查已取消。", error: "更新检查失败，可稍后重试。", available: `发现兼容新版 ${data.latest ?? ""}` };
			return h("div", { "data-side-update": data.status },
				h("div", null, `插件版本 ${data.version ?? "—"}${data.harness ? ` · Harness ${data.harness}` : ""}`),
				h("div", null, `${labels[data.status] ?? labels.error}${data.code ? `（${data.code}）` : ""}`),
				data.status === "available" ? h("div", null,
					h("a", { href: data.downloadUrl, target: "_blank", rel: "noopener noreferrer" }, "下载新版插件包"),
					h("div", null, `SHA-256：${data.sha256}`),
					h("div", null, "下载后，在 Harness「插件 → 添加插件」输入本地 .tgz 路径安装。若提示已安装，先停用并卸载旧插件再导入；按提示重启。未结束的侧聊会保留。"),
				) : null,
			);
		}

		/** Render the status/diagnostic panel; categories are shown before export. */
		function SideDiagnosticPanel({ panel, onClose, onDownload }) {
			const data = panel.data;
			const checks = Array.isArray(data.checks) ? data.checks : [];
			const list = (items) => h("ul", { style: { margin: "4px 0", paddingLeft: "18px" } }, items.map((item, index) => h("li", { key: index }, item)));
			return h("div", {
				"data-side-diagnostic": panel.kind,
				style: { marginTop: "4px", padding: "8px 10px", border: "0.5px solid var(--dsw-alias-border-l3)", borderRadius: "6px", background: "var(--dsw-alias-bg-l1, transparent)", maxHeight: "320px", overflow: "auto" },
			},
				panel.kind === "update"
					? h(SideUpdatePanel, { data })
					: panel.kind === "status"
					? h("div", null,
						h("div", { style: { fontWeight: 500, color: "var(--dsw-alias-label-secondary)" } }, `检查时间 ${formatCaptured(data.generatedAt)} · 关联 ${data.correlationId ?? "—"}`),
						list(checks.map((check) => `${check.ok === true ? "✓" : "✗"} ${check.code}`)),
						h("div", null, `上下文：${contextStatusLabel(data.context?.status)} · 捕获 ${formatCaptured(data.context?.capturedAt)}`),
						h("div", null, `待发送：${data.pending?.send === null ? "无" : data.pending.send.state} · 待清理：${data.pending?.cleanup ?? 0}`),
						h("div", null, `持久化：active=${data.persistence?.active ?? "?"} pending=${data.persistence?.pending ?? "?"} close=${data.persistence?.pendingClose ?? "?"}`),
					)
					: h("div", null,
						h("div", { style: { fontWeight: 500, color: "var(--dsw-alias-label-secondary)" } }, "诊断导出信息类别"),
						list([
							"插件版本、支持的宿主版本",
							"检查结果与错误代码",
							"生成时间、脱敏关联编号",
							"上下文/待发送/待清理的数量与状态",
						]),
						h("div", { style: { marginTop: "2px" } }, "不会包含：密钥、token、Cookie、认证 URL、环境变量、配置、对话或快照正文、文件内容、个人目录、会话标题、原始堆栈。"),
						h("button", { type: "button", onClick: onDownload, style: { marginTop: "6px", font: "inherit", fontSize: "11px", padding: "2px 8px", borderRadius: "5px", border: "0.5px solid var(--dsw-alias-border-l3)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer" } }, "保存诊断 JSON"),
					),
				h("button", { type: "button", onClick: onClose, style: { marginTop: "6px", font: "inherit", fontSize: "11px", padding: "1px 7px", borderRadius: "5px", border: "none", background: "transparent", color: "var(--dsw-alias-label-tertiary)", cursor: "pointer" } }, "收起"),
			);
		}

		/**
		 * Render the shared Conversation content for the side Session of this tab.
		 * Mirrors the embedded presentation used by the subagent chat tab: the
		 * phase comes from the side Session itself, never from the main view.
		 */
		function SideConversation({ sessionId, useSession, useConversation, useSessions, useProjection, renderFactorySlot }) {
			const session = useSession((value) => value);
			const shellPhase = useConversation((value) => value).activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running ? "active" : session.promptAttempted ? "engaging" : "blank";
			const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank);
			const settling = shellPhase === "blank" && session.openState === "loading" && summaryBlank !== true;
			const blank = shellPhase === "blank";
			// A side chat is never a new project: skip the project hero (which would
			// demand a workspace pick) and keep the composer usable immediately.
			const content = renderFactorySlot("conversation.content", {
				variant: "embedded",
				phase: settling ? "settling" : "active",
				hero: false
			}, { slots: { views: SideChatView } });
			return React.createElement("div", {
				"data-side-chat-pane": "",
				style: { position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, width: "100%", overflowX: "hidden" }
			}, h(SideContextBar, { sessionId, useProjection }), React.createElement("div", {
				"data-side-content": "",
				style: { flex: 1, minHeight: 0, display: "flex", width: "100%", minWidth: 0, overflow: "hidden" }
			}, content));
		}

		function SideChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
			const { tab } = useTabInfo();
			const resource = useResource(tab.contentId);
			const sessionId = resource.value === void 0 ? void 0 : resource.value.sessionId;
			React.useEffect(() => {
				if (sessionId === void 0) return;
				hideSideRow(sessionId);
				rememberSideSession(sessionId, void 0);
			}, [sessionId]);
			if (resource.value === void 0) {
				const code = resource.failure?.code;
				const label = resource.status === "failed"
					? `侧聊面板不可用${typeof code === "string" ? `（${code}）` : "（资源加载失败）"}`
					: resource.status === "none" ? "侧聊资源不可用（组件契约不匹配）" : "正在打开侧聊…";
				return h("div", {
					"data-side-resource-state": resource.status ?? "loading",
					style: { padding: "16px", fontSize: "13px", color: "var(--dsw-alias-label-tertiary)" },
				}, label);
			}
			return React.createElement("div", {
				style: {
					width: "100%",
					minWidth: 0,
					height: "100%",
					minHeight: 0,
					display: "flex"
				},
				"data-side-chat": ""
			}, React.createElement(SessionProvider, {
				session: resource.value.reference
			}, renderSlot(`${PROTOCOL}.conversation`, {})));
		}
		//#endregion

		/**
		 * Composer-dock pill: side Sessions' tokens attributed to this main Session.
		 * The built-in usage pill keeps counting only the main Session; this one is
		 * additive, and it disappears inside a side pane and before any usage exists.
		 */
		function SideUsagePill({ useSideUsage }) {
			const usage = useSideUsage((value) => value);
			if (usage === void 0 || usage.total <= 0) return null;
			const detail = `本主对话下所有侧聊的累计用量（非本轮、非主聊）：输入 ${usage.input} · 缓存读 ${usage.cacheRead} · 缓存写 ${usage.cacheWrite} · 输出 ${usage.output}（${usage.count} 条）`;
			return React.createElement("span", {
				"data-side-usage": usage.total,
				title: detail,
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: "6px",
					padding: "2px 8px",
					borderRadius: "6px",
					font: "inherit",
					lineHeight: "inherit",
					color: "var(--dsw-alias-label-tertiary)",
					whiteSpace: "nowrap"
				}
			}, `侧聊累计 +${formatTokenFigure(usage.total)} tok`);
		}

		/** Explicit retry entry for side Sessions whose deletion failed. */
		function SideCleanupPill({ sessionId, useProjection }) {
			const cleanup = useProjection === void 0 ? void 0 : useProjection("sideChatCleanup");
			const [busy, setBusy] = React.useState(false);
			if (cleanup === void 0 || cleanup.count <= 0) return null;
			const retry = async () => {
				setBusy(true);
				try {
					await retryCleanup(sessionId);
				} catch (error) {
					if (typeof window !== "undefined" && typeof window.alert === "function") {
						window.alert(`待清理侧聊仍未删除：${error instanceof Error ? error.message : String(error)}`);
					}
				} finally {
					setBusy(false);
				}
			};
			return h("button", {
				type: "button",
				"data-side-cleanup": cleanup.count,
				disabled: busy,
				title: `待清理原因代码：${(cleanup.reasons ?? []).join(", ") || "unknown"}`,
				onClick: () => { void retry(); },
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: "6px",
					padding: "2px 8px",
					borderRadius: "6px",
					border: "0.5px solid var(--dsw-alias-border-l3)",
					background: "transparent",
					font: "inherit",
					lineHeight: "inherit",
					color: "var(--dsw-alias-label-warning, #b45309)",
					cursor: busy ? "default" : "pointer",
					whiteSpace: "nowrap",
				},
			}, busy ? "清理中…" : `待清理 ${cleanup.count} 条 · 重试`);
		}

		//#region 插件
		function apply(ctx) {
			clientCtx = ctx;
			let disposed = false;
			const closeTimers = new Set();
			const bindingTasks = new Map();
			const usageDisposers = new Set();
			ctx.effect(() => {
				if (typeof document === "undefined") return;
				const scoped = document.createElement("style");
				scoped.dataset.plugin = PLUGIN_ID;
				scoped.dataset.pluginCss = `${PLUGIN_ID}/side-pane`;
				scoped.textContent = [
					"[data-side-chat-pane] [data-side-content]{flex:1 1 auto;min-width:0;min-height:0;display:flex}",
					"[data-side-chat-pane] [data-conversation-content]{flex:1 1 auto;width:100%;height:100%!important;min-width:0;min-height:0;display:flex;flex-direction:column}",
					"[data-side-chat-pane] [data-conversation-scroll]{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow-x:hidden}",
					"[data-side-chat-pane] [data-side-view]{flex:1 0 auto;min-width:0;min-height:0;display:flex;flex-direction:column}",
					"[data-side-chat-pane] [data-side-view]:has([data-chat-turn]) [data-side-empty]{display:none!important}",
					"[data-side-chat-pane] [data-side-view]:not(:has([data-chat-turn])) [data-side-view-content]{display:none!important}",
					"[data-side-chat-pane] [data-side-empty]{max-width:100%}",
					"[data-side-chat-pane] pre,[data-side-chat-pane] table{max-width:100%}"
				].join("\n");
				document.head.appendChild(scoped);
				return () => scoped.remove();
			}, `${PLUGIN_ID}: side pane styles`);

			ctx.effect(() => {
				if (typeof document === "undefined") return;
				const tag = document.createElement("style");
				tag.dataset.plugin = PLUGIN_ID;
				tag.dataset.pluginCss = `${PLUGIN_ID}/hidden-rows`;
				document.head.appendChild(tag);
				hiddenStyleTag = tag;
				refreshHiddenRows();
				return () => {
					if (hiddenStyleTag === tag) hiddenStyleTag = null;
					tag.remove();
				};
			}, `${PLUGIN_ID}: hidden sidebar rows`);

			ctx.effect(() => ctx.resources.register(sideChatResourceProvider(ctx)), `${PLUGIN_ID}: side chat resources`);

			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: PLUGIN_ID,
				kind: KIND,
				patterns: [`${ADDRESS_PREFIX}**`],
				priority: "builtin",
				canOpen: (address) => parseSessionId(address) !== void 0,
				title: () => FALLBACK_TITLE
			}), `${PLUGIN_ID}: side chat tab type`);

			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: PLUGIN_ID,
				children: {
					[`${PROTOCOL}.conversation`]: {
						kind: "single",
						scope: "session"
					}
				}
			}, SideChatTab)), `${PLUGIN_ID}: side chat tab body`);

			// Display-only adaptation over the complete grouping data: when the only
			// ungrouped Sessions are temporary side chats, hide the empty "ungrouped"
			// group container. Ordinary ungrouped Sessions (or unconfirmed identities)
			// keep it visible. This does not alter global Session data, search results,
			// or navigation counts.
			ctx.effect(() => {
				if (typeof document === "undefined" || ctx.workspaces?.list === void 0) return;
				const hiddenSections = new Set();
				let frame = 0;
				let dataDirty = true;
				let onlySide = false;
				let ready = false;
				let signature = "";
				let sidebarRoot;
				const restore = () => {
					for (const section of hiddenSections) {
						section.style.removeProperty("display");
						delete section.dataset.sideUngroupedHidden;
					}
					hiddenSections.clear();
				};
				const hideHeaders = () => {
					// React can replace a group without changing the catalog signature.
					// Never retain the detached group's full DOM subtree in this Set.
					for (const section of hiddenSections) {
						if (section.isConnected !== false) continue;
						section.style.removeProperty("display");
						delete section.dataset.sideUngroupedHidden;
						hiddenSections.delete(section);
					}
					if (!ready || !onlySide) return;
					for (const header of document.querySelectorAll('[data-row-key="workspace:"]')) {
						const section = header.parentElement;
						if (section === null || hiddenSections.has(section)) continue;
						if (section === document.body || section.querySelector("[role=tree]") !== null) continue;
						if (section.querySelectorAll('[data-row-key="workspace:"]').length !== 1) continue;
						section.dataset.sideUngroupedHidden = "";
						section.style.setProperty("display", "none", "important");
						hiddenSections.add(section);
					}
				};
				const evaluate = () => {
					const list = ctx.sessions.list.getSnapshot();
					const workspaceState = ctx.workspaces.list.getSnapshot();
					const accounted = new Set((workspaceState.items ?? []).flatMap((workspace) => workspace.sessionIds ?? []));
					const ungrouped = (list.ids ?? []).map((id) => list.byId[id]).filter((session) => session !== void 0 && !accounted.has(session.id));
					const nextSignature = JSON.stringify([
						workspaceState.phase,
						list.ids ?? [],
						[...accounted].sort(),
						ungrouped.map((session) => [session.id, session.projectionValues?.agentPreset ?? session.agentPreset ?? null]),
					]);
					if (nextSignature === signature) return;
					signature = nextSignature;
					ready = workspaceState.phase === "ready";
					onlySide = ready && ungrouped.length > 0 && ungrouped.every((session) => (session.projectionValues?.agentPreset ?? session.agentPreset) === SIDE_PRESET);
					restore();
				};
				const flush = () => {
					frame = 0;
					ensureObserver();
					if (dataDirty) {
						dataDirty = false;
						evaluate();
					}
					hideHeaders();
				};
				const schedule = (dirty) => {
					if (dirty) dataDirty = true;
					if (frame !== 0) return;
					frame = requestAnimationFrame(flush);
				};
				const observer = typeof MutationObserver === "undefined" ? void 0 : new MutationObserver(() => schedule(false));
				const ensureObserver = () => {
					if (observer === void 0) return;
					if (sidebarRoot?.isConnected === true) return;
					observer.disconnect();
					sidebarRoot = document.querySelector('[data-side=left]') ?? document.querySelector('[data-side=sidebar]');
					if (sidebarRoot !== null && sidebarRoot !== void 0) observer.observe(sidebarRoot, { childList: true, subtree: true });
					else observer.observe(document.body, { childList: true, subtree: true });
				};
				ensureObserver();
				const offSessions = ctx.sessions.list.subscribe(() => schedule(true));
				const offWorkspaces = ctx.workspaces.list.subscribe(() => schedule(true));
				schedule(true);
				return () => {
					offSessions?.();
					offWorkspaces?.();
					observer?.disconnect();
					if (frame !== 0) cancelAnimationFrame(frame);
					restore();
				};
			}, `${PLUGIN_ID}: hide empty ungrouped side-only group`);

			// Hide every persisted side Session row from ordinary navigation, including
			// ones never opened in this client process. Identity comes from the agentPreset
			// projection, not from in-memory tab state.
			ctx.effect(() => {
				let signature = "";
				const sync = () => {
					const snapshot = ctx.sessions.list.getSnapshot();
					const rows = Object.values(snapshot.byId ?? {});
					const sideIds = rows
						.filter((row) => (row.projectionValues?.agentPreset ?? row.agentPreset) === SIDE_PRESET)
						.map((row) => row.id ?? row.sessionId)
						.filter((id) => typeof id === "string");
					const nextSignature = sideIds.join("\u0000");
					if (nextSignature === signature) return;
					signature = nextSignature;
					const current = new Set(sideIds);
					for (const id of hiddenSideSessions) if (!current.has(id)) unhideSideRow(id);
					for (const id of sideIds) hideSideRow(id);
				};
				sync();
				const unsubscribe = ctx.sessions.list.subscribe(sync);
				return () => unsubscribe?.();
			}, `${PLUGIN_ID}: hide side sessions in navigation`);

			ctx.effect(() => ctx.slots.inject(`${PROTOCOL}.conversation`, () => ctx.slots.register({ name: `${PROTOCOL}.conversation` }, SideConversation)), `${PLUGIN_ID}: side chat conversation`);

			/** Observable sources, one per Session, handed to the slot injector. */
			const sideUsageSources = new Map();

			const stableSideUsage = (sessionId, source) => {
				const next = readSideUsage(ctx.sessions.list.getSnapshot(), sessionId);
				const previous = source.snapshot;
				if (previous !== void 0 && previous.total === next.total && previous.input === next.input && previous.cacheRead === next.cacheRead && previous.cacheWrite === next.cacheWrite && previous.output === next.output && previous.count === next.count) return previous;
				source.snapshot = next;
				return next;
			};

			const sideUsageSource = (sessionId) => {
				let source = sideUsageSources.get(sessionId);
				if (source === void 0) {
					let subscribers = 0;
					source = {
						getSnapshot: () => stableSideUsage(sessionId, source),
						subscribe: (listener) => {
							const unsubscribeList = ctx.sessions.list.subscribe(listener);
							subscribers += 1;
							sideUsageListeners.add(listener);
							let released = false;
							const release = () => {
								if (released) return;
								released = true;
								if (typeof unsubscribeList === "function") unsubscribeList();
								sideUsageListeners.delete(listener);
								subscribers -= 1;
								usageDisposers.delete(release);
								if (subscribers === 0 && sideUsageSources.get(sessionId) === source) sideUsageSources.delete(sessionId);
							};
							usageDisposers.add(release);
							return release;
						}
					};
					sideUsageSources.set(sessionId, source);
				}
				return source;
			};

			ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "side-usage",
				order: 2,
				inject: (sessionId) => ({
					hooks: {
						sideUsage: sideUsageSource(sessionId)
					}
				})
			}, SideUsagePill)), `${PLUGIN_ID}: side usage pill`);

			ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "side-cleanup",
				order: 3
			}, SideCleanupPill)), `${PLUGIN_ID}: pending cleanup pill`);

			/** Tab ids already deleting; a second click must not send a second request. */
			const deletingTabs = new Set();
			ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (sessionId, tab) => {
				const childId = parseAddress(tab?.contentId)?.sideId;
				if (childId === void 0) return;
				const tabKey = tab?.id ?? childId;
				if (deletingTabs.has(tabKey)) return;
				const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
					? true
					: window.confirm("结束并删除这次侧聊？\n\n会话记录会被删除且无法恢复；主对话不受影响。");
				if (!confirmed) throw new Error(`${PLUGIN_ID}: close cancelled`);
				deletingTabs.add(tabKey);
				// The tab must close first: its Session retain is what keeps the side
				// Agent alive after a reload. Releasing it lets the Host dispose the
				// Agent before it deletes storage. The RPC therefore runs after this
				// handler returns and the tab has unmounted.
				const timer = setTimeout(() => {
					closeTimers.delete(timer);
					if (disposed) return;
					void (async () => {
						try {
							const outcome = await ctx.remote.commands.execute(sessionId, `/side --close ${childId}`, []);
							if (!outcome.ok) throw new Error(outcome.error?.message ?? `RPC 失败（${outcome.error?.code ?? "unknown"}）`);
							const result = outcome.value?.result;
							if (result?.kind !== "success") throw new Error(result?.text ?? "宿主返回失败");
							if (disposed) return;
							forgetSideSession(childId);
							forgetSideRuntime(childId);
							unhideSideRow(childId);
							sideUsageSources.delete(childId);
						} catch (error) {
							if (disposed) return;
							const message = error instanceof Error ? error.message : String(error);
							console.warn(`[${PLUGIN_ID}] 关闭侧聊失败:`, error);
							if (typeof window !== "undefined" && typeof window.alert === "function") {
								window.alert(`侧聊删除失败：${message}\n\n记录已保留；可在主输入区的“待清理”处重试，或再次输入 /side。`);
							}
						} finally {
							deletingTabs.delete(tabKey);
						}
					})();
				}, 80);
				closeTimers.add(timer);
				return;
			}), `${PLUGIN_ID}: side chat close handler`);

			/**
			 * One dispatch acknowledgement for every entry point (bare, args,
			 * menu): `/side` is a HOST command, so the client cannot own it. The
			 * commands service emits `command/executed` locally after the Remote
			 * settles; a successful run names the deterministic side Session, which
			 * the client opens in the right dock. Background updates never trigger
			 * this event, so a hidden panel stays hidden.
			 */
			/**
			 * Resolve the Host-declared active binding from the main Session's
			 * `sideChatBinding` projection. The id comes from the Host; the child row
			 * is only used to validate lineage and preset, never to choose an id.
			 */
			const bindingOf = (mainId) => {
				const snapshot = ctx.sessions.list.getSnapshot();
				const value = snapshot.projectionsBySession?.[mainId]?.values?.sideChatBinding;
				const sideId = value !== null && typeof value === "object" ? value.sideId : void 0;
				if (typeof sideId !== "string" || sideId === "") return void 0;
				const row = sessionRows(snapshot).find((item) => item.sessionId === sideId);
				if (row === void 0 || row.parentSessionId !== mainId) return void 0;
				const preset = snapshot.projectionsBySession?.[sideId]?.values?.agentPreset;
				if (preset !== void 0 && preset !== SIDE_PRESET) return void 0;
				return sideId;
			};

			ctx.effect(() => ctx.on("command/executed", (sessionId, commandName, result) => {
				if (commandName !== "side") return;
				if (result === null || typeof result !== "object" || result.kind !== "success") return;
				// Maintenance invocations (close/ensure/refresh/retry/status) must not
				// steal focus or re-open the side tab.
				const text = typeof result.text === "string" ? result.text : "";
				if (text === "update-ready" || text === "closed" || text === "ensured" || text === "cleanup-retried" || text === "send-retried" || text === "send-already-accepted" || text === "refresh-pending" || text === "refresh-ready" || text === "status-ready" || text === "diagnostic-ready") return;
				if (disposed || bindingTasks.has(sessionId)) return;
				const task = (async () => {
					for (let attempt = 0; attempt < 40; attempt += 1) {
						if (disposed) return;
						const sideId = bindingOf(sessionId);
						if (sideId !== void 0) {
							hideSideRow(sideId);
							ctx.sidebarRight.openResource(sideAddress(sessionId, sideId), { kind: KIND });
							return;
						}
						// A present {sideId:null} may be the pre-command baseline too.
						try {
							await ctx.sessions.refreshProjections(sessionId);
						} catch {
							/* retry */
						}
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					console.warn(`[${PLUGIN_ID}] 宿主未返回 ${sessionId} 的活动侧聊绑定`);
				})().finally(() => bindingTasks.delete(sessionId));
				bindingTasks.set(sessionId, task);
			}), `${PLUGIN_ID}: /side executed listener`);

			ctx.effect(() => () => {
				disposed = true;
				for (const timer of closeTimers) clearTimeout(timer);
				closeTimers.clear(); deletingTabs.clear(); bindingTasks.clear();
				for (const release of [...usageDisposers]) release();
				for (const unsubscribe of runtimeSubscriptions.values()) unsubscribe?.();
				runtimeSubscriptions.clear(); sideRuntimes.clear(); sideParents.clear();
				sideUsageSources.clear(); sideUsageListeners.clear(); hiddenSideSessions.clear();
				if (clientCtx === ctx) clientCtx = void 0;
			}, `${PLUGIN_ID}: release client resources`);
		}

		exports.apply = apply;
		exports.inject = ["commandUi", "resources", "sessions", "workspaces", "slots", "uiWorkspace", "sidebarRightTabs", "sidebarRight", "remote", "remote.commands"];

		return module.exports;
	}
});
