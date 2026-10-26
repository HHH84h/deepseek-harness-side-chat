import { readFileSync } from "node:fs";
import { PLUGIN_VERSION } from "./metadata.js";

const PRODUCT = "deepseek-harness-side-chat";
const FEED = "side-chat-plugin-update.json";
const HOSTS = new Set(["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const semver = (s) => typeof s === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(s) && s.split(".").every((x) => Number.isSafeInteger(Number(x)));
const compare = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1; return 0; };
const reject = (code) => { const e = new Error(code); e.updateCode = code; throw e; };

function allowed(value, repository) {
  let u; try { u = new URL(value); } catch { reject("INVALID_RESPONSE"); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || !HOSTS.has(u.hostname)) reject("INVALID_RESPONSE");
  if (u.hostname === "api.github.com" && u.pathname !== `/repos/${repository}/releases`) reject("INVALID_RESPONSE");
  if (u.hostname === "github.com" && !u.pathname.startsWith(`/${repository}/releases/download/`)) reject("INVALID_RESPONSE");
  return u;
}

async function jsonRequest(url, { repository, fetchImpl, signal, limit }) {
  for (let redirect = 0; redirect < 5; redirect++) {
    const u = allowed(url, repository);
    const response = await fetchImpl(u.href, { method: "GET", redirect: "manual", credentials: "omit", signal,
      headers: { Accept: "application/json", "User-Agent": "side-chat-plugin-updater" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location"); await response.body?.cancel();
      if (!location) reject("INVALID_RESPONSE"); url = new URL(location, u).href; continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); reject(response.status === 403 || response.status === 429 ? "RATE_LIMIT" : "NETWORK"); }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) { await response.body?.cancel(); reject("INVALID_RESPONSE"); }
    if (!response.body) reject("INVALID_RESPONSE");
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > limit) reject("INVALID_RESPONSE"); chunks.push(Buffer.from(value));
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (e) { await reader.cancel().catch(() => {}); if (e.updateCode) throw e; if (signal.aborted) throw e; reject("INVALID_RESPONSE"); }
    finally { reader.releaseLock(); }
  }
  reject("INVALID_RESPONSE");
}

/** Read-only public release lookup. No installer, credentials, telemetry or timers. */
export function createUpdateChecker(options = {}) {
  let active, controller, disposed = false;
  const version = options.version ?? PLUGIN_VERSION;
  let source = options.source;
  if (source === undefined) { try { source = JSON.parse(readFileSync(new URL("../update-source.json", import.meta.url), "utf8")); } catch { source = null; } }
  const runtime = options.runtime ?? (async () => (await import("@deepseek-ai/dsh-app-boot")).getDshRuntimeVersion());
  const fetchImpl = options.fetchImpl ?? fetch;
  async function perform() {
    if (disposed) return { status: "cancelled", version };
    if (source?.schema !== 1 || typeof source.enabled !== "boolean") return { status: "error", code: "SOURCE", version };
    if (!source.enabled) return { status: "disabled", version };
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(source.repository ?? "")) return { status: "error", code: "SOURCE", version };
    controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller?.abort(); }, options.timeoutMs ?? 15000);
    timer.unref?.();
    try {
      const harness = await runtime();
      if (typeof harness !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(harness)) reject("RUNTIME");
      const signal = controller.signal, repository = source.repository;
      const request = (url, limit) => jsonRequest(url, { repository, fetchImpl, signal, limit });
      const releases = await request(`https://api.github.com/repos/${repository}/releases?per_page=20`, 1024 * 1024);
      if (!Array.isArray(releases) || releases.length > 20) reject("INVALID_RESPONSE");
      let compatibleSeen = false;
      const candidates = releases.filter((r) => r?.draft === false && r.prerelease === false && typeof r.tag_name === "string" && semver(r.tag_name.slice(1)) && r.tag_name.startsWith("v"));
      candidates.sort((a, b) => compare(b.tag_name.slice(1), a.tag_name.slice(1)));
      for (const release of candidates) {
        const tag = release.tag_name, next = tag.slice(1);
        const asset = (name) => {
          const rows = (release.assets ?? []).filter((a) => a.name === name);
          if (rows.length !== 1 || rows[0].browser_download_url !== `https://github.com/${repository}/releases/download/${tag}/${name}`) reject("INVALID_RESPONSE");
          return rows[0].browser_download_url;
        };
        if (!Array.isArray(release.assets)) reject("INVALID_RESPONSE");
        if (!release.assets.some((a) => a.name === FEED)) continue;
        const feed = await request(asset(FEED), 64 * 1024);
        if (feed?.schema !== 1 || feed.product !== PRODUCT || feed.format !== "harness-bundle" || feed.version !== next || feed.packageName !== "dsh-client-ui-side" || feed.platform !== "darwin" || !Array.isArray(feed.supportedHarness) || feed.supportedHarness.length > 20 || !feed.supportedHarness.length || !feed.supportedHarness.every((v) => typeof v === "string" && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(v))) reject("INVALID_RESPONSE");
        const a = feed.artifact;
        if (a?.name !== `dsh-client-ui-side-${next}.tgz` || !/^[a-f0-9]{64}$/u.test(a.sha256 ?? "") || !Number.isSafeInteger(a.bytes) || a.bytes < 1 || a.bytes > 16 * 1024 * 1024) reject("INVALID_RESPONSE");
        if (!feed.supportedHarness.includes(harness)) continue;
        compatibleSeen = true;
        if (compare(next, version) <= 0) continue;
        return { status: "available", version, harness, latest: next, downloadUrl: asset(a.name), sha256: a.sha256, bytes: a.bytes };
      }
      return { status: compatibleSeen ? "up-to-date" : "no-compatible", version, harness };
    } catch (e) {
      return { status: disposed ? "cancelled" : "error", version, code: disposed ? "CANCELLED" : timedOut ? "TIMEOUT" : e.updateCode ?? "NETWORK" };
    } finally { clearTimeout(timer); controller = undefined; }
  }
  return {
    check() { if (active) return active; active = perform().finally(() => { active = undefined; }); return active; },
    async dispose() { disposed = true; controller?.abort(); if (active) await active; },
  };
}
