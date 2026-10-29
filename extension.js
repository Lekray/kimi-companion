const vscode = require("vscode");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { randomUUID } = require("crypto");
const { PatchDistManager } = require("./lib/patch-dist");
const { OpenChatsController } = require("./lib/open-chats");
const { WindowLease } = require("./lib/window-lease");
const { fetchWithTimeout, cancelPendingRequests } = require("./lib/http");
const { usageFreshness, FiveHourSourceTracker } = require("./lib/usage-state");

const KIMI_EXT_ID = "moonshot-ai.kimi-code";
const ENTRIES_KEY = "kimiTabEntries";
const SIDEBAR_KEY = "kimiSidebarSession";
const CLOSED_KEY = "kimiClosedHistory";
const LEGACY_NAMES_KEY = "kimiTabNames";
const CLOSED_MAX = 5;
const DEFAULT_TITLE = "Kimi Code";
const POLL_MS = 2000;

// --- Patches applied to the Kimi extension dist (self-healing) ---
// Order matters: later anchors may depend on text inserted by earlier units.
const EXT_UNITS = [
	{
		marker: "__kimiCompanionNextTitle",
		old: 'vscode.window.createWebviewPanel("kimiPanel", "Kimi Code", vscode.ViewColumn.One, {',
		repl: 'vscode.window.createWebviewPanel("kimiPanel", globalThis.__kimiCompanionNextTitle || "Kimi Code", vscode.ViewColumn.One, {'
	},
	{
		marker: "/*__kimiCompanion__*/",
		old: "this.setupWebview(webviewId, panel.webview);",
		repl: "(globalThis.__kimiCompanionPanels = globalThis.__kimiCompanionPanels || []).push(panel), " +
			"panel.onDidDispose(() => { const a = globalThis.__kimiCompanionPanels; const i = a.indexOf(panel); if (i >= 0) a.splice(i, 1); }), " +
			"/*__kimiCompanion__*/ this.setupWebview(webviewId, panel.webview);"
	},
	{
		marker: "__kimiCompanionNextColumn",
		old: 'globalThis.__kimiCompanionNextTitle || "Kimi Code", vscode.ViewColumn.One, {',
		repl: 'globalThis.__kimiCompanionNextTitle || "Kimi Code", globalThis.__kimiCompanionNextColumn || vscode.ViewColumn.One, {'
	},
	{
		marker: "/*__kimiCompanion2__*/",
		old: "\t\tthis.bridgeHandler = new BridgeHandler(this.broadcastInternal.bind(this), context.workspaceState, context.globalStorageUri.fsPath, this.reloadWebview.bind(this), showLogs, writeLog);",
		repl: "\t\tthis.bridgeHandler = new BridgeHandler(this.broadcastInternal.bind(this), context.workspaceState, context.globalStorageUri.fsPath, this.reloadWebview.bind(this), showLogs, writeLog);\n" +
			"\t\t/*__kimiCompanion2__*/ if (!globalThis.__kimiCompanionGetSessionId) {\n" +
			"\t\t\tglobalThis.__kimiCompanionGetSessionId = (webviewId) => this.bridgeHandler.fileManager.getSessionId(webviewId);\n" +
			"\t\t\tglobalThis.__kimiCompanionGetWebviewId = (panel) => {\n" +
			"\t\t\t\tfor (const [id, webview] of this.webviews) if (webview === (panel && panel.webview)) return id;\n" +
			"\t\t\t\treturn null;\n" +
			"\t\t\t};\n" +
			"\t\t\tglobalThis.__kimiCompanionLoadSession = (webviewId, sessionId) => this.broadcastInternal(\"__kimiCompanionLoadSession\", { sessionId }, webviewId);\n" +
			"\t\t}"
	},
	{
		marker: "__kimiCompanionGetSidebarId",
		old: "\t\t\tglobalThis.__kimiCompanionLoadSession = (webviewId, sessionId) => this.broadcastInternal(\"__kimiCompanionLoadSession\", { sessionId }, webviewId);",
		repl: "\t\t\tglobalThis.__kimiCompanionLoadSession = (webviewId, sessionId) => this.broadcastInternal(\"__kimiCompanionLoadSession\", { sessionId }, webviewId);\n" +
			"\t\t\tglobalThis.__kimiCompanionGetSidebarId = () => { for (const id of this.webviews.keys()) if (typeof id === \"string\" && id.startsWith(\"sidebar_\")) return id; return null; };"
	},
	{
		marker: "__kimiCompanionGetUsage",
		old: "\t\t\tglobalThis.__kimiCompanionGetSidebarId = () => { for (const id of this.webviews.keys()) if (typeof id === \"string\" && id.startsWith(\"sidebar_\")) return id; return null; };",
		repl: "\t\t\tglobalThis.__kimiCompanionGetSidebarId = () => { for (const id of this.webviews.keys()) if (typeof id === \"string\" && id.startsWith(\"sidebar_\")) return id; return null; };\n" +
			"\t\t/*__kimiCompanion3__*/ if (!globalThis.__kimiCompanionGetUsage) {\n" +
			"\t\t\tglobalThis.__kimiCompanionGetUsage = (providerName = \"managed:kimi-code\") => this.bridgeHandler.runtime.harness.auth.getManagedUsage(providerName);\n" +
			"\t\t}"
	},
	{
		marker: "/*__kimiCompanionTurnSettled__*/",
		old: "this.terminalKeys.add(terminal.key);",
		repl: "this.terminalKeys.add(terminal.key); /*__kimiCompanionTurnSettled__*/ try { " +
			"if (globalThis.__kimiCompanionTurnSettled) globalThis.__kimiCompanionTurnSettled({ " +
			"key: terminal.key, sessionId: terminal.sessionId, agentId: terminal.agentId, turnId: terminal.turnId, " +
			"reason: terminal.reason, error: terminal.error, promptActive: this.activePrompt !== void 0, " +
			"webviewIds: [...this.webviewIds] }); } catch {}"
	},
	{
		marker: "__kimiCompanionTurnStarted",
		old: "this.activePrompt = active;",
		repl: "this.activePrompt = active; /*__kimiCompanionTurnStarted__*/ try { " +
			"if (globalThis.__kimiCompanionTurnStarted) globalThis.__kimiCompanionTurnStarted({ " +
			"sessionId: this.id, webviewIds: [...this.webviewIds] }); } catch {}"
	},
	{
		marker: "/*__kimiCompanionWaitA__*/",
		old: "this.session.setApprovalHandler((request) => this.reverseRpc.requestApproval(request));",
		repl: "this.session.setApprovalHandler((request) => { /*__kimiCompanionWaitA__*/ " +
			"const __kcW = (waiting) => { try { if (globalThis.__kimiCompanionWaiting) " +
			"globalThis.__kimiCompanionWaiting({ waiting, sessionId: this.id, webviewIds: [...this.webviewIds] }); } catch {} }; " +
			"__kcW(true); return this.reverseRpc.requestApproval(request).finally(() => __kcW(false)); });"
	},
	{
		marker: "/*__kimiCompanionWaitQ__*/",
		old: "this.session.setQuestionHandler((request) => this.reverseRpc.requestQuestion(request));",
		repl: "this.session.setQuestionHandler((request) => { /*__kimiCompanionWaitQ__*/ " +
			"const __kcW = (waiting) => { try { if (globalThis.__kimiCompanionWaiting) " +
			"globalThis.__kimiCompanionWaiting({ waiting, sessionId: this.id, webviewIds: [...this.webviewIds] }); } catch {} }; " +
			"__kcW(true); return this.reverseRpc.requestQuestion(request).finally(() => __kcW(false)); });"
	},
	{
		// settlePrompt runs on every prompt end, including paths that never reach emitTerminal
		// (preflight failure, error before turn.started, session close) — clears a stuck [~].
		marker: "/*__kimiCompanionPromptSettled__*/",
		old: "\t\tactive.settled = true;\n\t\tthis.activePrompt = void 0;\n\t\tactive.resolve(result);",
		repl: "\t\tactive.settled = true;\n\t\tthis.activePrompt = void 0;\n\t\tactive.resolve(result);\n" +
			"\t\t/*__kimiCompanionPromptSettled__*/ try { if (globalThis.__kimiCompanionPromptSettled) " +
			"globalThis.__kimiCompanionPromptSettled({ status: result && result.status, sessionId: this.id, " +
			"webviewIds: [...this.webviewIds] }); } catch {}"
	}
];
// The webview unit names the session-history store of the bundle it is spliced into, so
// each bundle shape gets its own variant: 0.8.2/0.8.3 call it Qe, 0.8.4 renamed it to Ve.
const WV_UNITS = [
	{
		marker: "__kimiCompanionLoadSessionInUi",
		old: "const Qe=new zie,IC=[",
		repl: "const Qe=new zie;" +
			"window.__kimiCompanionLoadSessionInUi=async(sessionId)=>{const e=await Qe.loadSessionHistory(sessionId);await J0.getState().loadSession(sessionId,e);return e};" +
			"window.addEventListener(\"message\",(m)=>{const d=m&&m.data;if(d&&d.event===\"__kimiCompanionLoadSession\"&&d.data&&d.data.sessionId)window.__kimiCompanionLoadSessionInUi(d.data.sessionId).catch(()=>{})});" +
			"const IC=["
	}
];
const WV_UNITS_084 = [
	{
		marker: "__kimiCompanionLoadSessionInUi",
		old: "const Ve=new zie,IC=[",
		repl: "const Ve=new zie;" +
			"window.__kimiCompanionLoadSessionInUi=async(sessionId)=>{const e=await Ve.loadSessionHistory(sessionId);await J0.getState().loadSession(sessionId,e);return e};" +
			"window.addEventListener(\"message\",(m)=>{const d=m&&m.data;if(d&&d.event===\"__kimiCompanionLoadSession\"&&d.data&&d.data.sessionId)window.__kimiCompanionLoadSessionInUi(d.data.sessionId).catch(()=>{})});" +
			"const IC=["
	}
];
const WV_UNITS_BY_VERSION = { "0.8.4": WV_UNITS_084 };

// A version without a variant of its own keeps the original anchor set.
function wvUnitsFor(version) {
	return WV_UNITS_BY_VERSION[String(version)] || WV_UNITS;
}

let log;
let lastPersisted = "[]";
let lastSidebarSession = null;
let startupDone = false;
let activationDisposed = false;
let restoringWindows = false;
let restoringSidebar = false;
let restoreHadFailure = false;
let restoreEnabledForSession = false;
let windowLease = null;
let openChats = null;
let patchManager = null;
let lastPatchReport = null;
const pendingDelays = new Set();
const fiveHourSource = new FiveHourSourceTracker();

function delay(ms) {
	if (activationDisposed) return Promise.resolve(false);
	return new Promise((resolve) => {
		const pending = { timer: null, resolve };
		pending.timer = setTimeout(() => {
			pendingDelays.delete(pending);
			resolve(!activationDisposed);
		}, ms);
		pendingDelays.add(pending);
	});
}

function cancelPendingDelays() {
	for (const pending of pendingDelays) {
		clearTimeout(pending.timer);
		pending.resolve(false);
	}
	pendingDelays.clear();
}

function hooksAvailable() {
	const hooks = getHooks();
	return !!(hooks.getWebviewId && hooks.getSessionId && hooks.loadSession);
}

function isRestoring() {
	return restoringWindows || restoringSidebar;
}

function canPersistState() {
	return restoreEnabledForSession && startupDone && !isRestoring() && !restoreHadFailure && hooksAvailable() && !!windowLease && windowLease.isOwner;
}

const safe = (fn) => {
	try {
		return fn();
	} catch {
		return undefined;
	}
};

function getHooks() {
	return {
		getWebviewId: globalThis.__kimiCompanionGetWebviewId,
		getSessionId: globalThis.__kimiCompanionGetSessionId,
		loadSession: globalThis.__kimiCompanionLoadSession,
		getSidebarId: globalThis.__kimiCompanionGetSidebarId
	};
}

// --- Subscription usage (quotas) -------------------------------------

const USAGE_PROVIDER = "managed:kimi-code";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const USAGE_CACHE_MS = 60000;
const ALERT_LATCH_KEY = "kimiQuotaAlertLatch";

let appContext = null;
let workingQuotaUrl = null;
let lastUsageDebug = "-";

function usageDebug(msg) {
	lastUsageDebug = msg;
	if (log) log.appendLine(`[usage] ${msg}`);
}

function quotaUrlCandidates() {
	const urls = [];
	const push = (u) => {
		if (!u) return;
		try {
			const parsed = new URL(u);
			if (parsed.protocol !== "https:") {
				usageDebug(`direct: rejected non-HTTPS endpoint ${parsed.origin}`);
				return;
			}
			if (!urls.includes(u)) urls.push(u);
		} catch {
			usageDebug("direct: rejected malformed endpoint");
		}
	};
	const env = process.env.KIMI_CODE_BASE_URL;
	if (env) push(env.replace(/\/+$/, "") + "/usages");
	const cfgBase = safe(() => {
		const cfg = fs.readFileSync(path.join(kimiHome, "config.toml"), "utf8");
		const m = cfg.match(/\[providers\."managed:kimi-code"\][^[]*?base_url\s*=\s*"([^"]+)"/);
		return m ? m[1] : null;
	});
	if (cfgBase) push(cfgBase.replace(/\/+$/, "") + "/usages");
	push(KIMI_USAGE_URL);
	push("https://api.kimi.ai/coding/v1/usages");
	return urls;
}
const USAGE_REFRESH_MS = 5 * 60 * 1000;
const USAGE_URI = "kimi-companion://report/Kimi Code Usage.txt";
const DIAG_URI = "kimi-companion://report/Diagnostics.txt";
const STATUS_TEXT = "$(kimi-companion-k) Kimi Code";
const BAR_WIDTH = 16;
const LIMITS = [
	{ key: "limit5h", label: "5-hour limit", short: "5h", durationMinutes: 300 },
	{ key: "limit7d", label: "7-day limit", short: "7d", durationMinutes: 7 * 1440 },
	{ key: "monthTotal", label: "Monthly total", short: "month", durationMinutes: 43829 },
	{ key: "monthCode", label: "Monthly (code)", short: "month code", durationMinutes: 43829 }
];

let statusItem = null;
let reportProvider = null;
let usageCache = { data: null, at: 0 };

function kimiCredentialsFile() {
	try {
		const dir = path.join(kimiHome, "credentials");
		const files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
			.sort((a, b) => b.m - a.m);
		return files.length > 0 ? path.join(dir, files[0].f) : null;
	} catch {
		return null;
	}
}

const USAGE_KEY_MAP = {
	limit_5h: "limit5h",
	limit_7d: "limit7d",
	limit_month_total: "monthTotal",
	limit_month_code: "monthCode"
};

// Server strings end up in a trusted MarkdownString tooltip — keep only plain characters
// so a response can never inject markdown links, command URIs or HTML.
function plainText(value, max = 40) {
	return String(value == null ? "" : value).replace(/[^\p{L}\p{N} ._:%-]/gu, "").slice(0, max);
}

function currencyCode(value) {
	return typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : "USD";
}

function quotaWindowLabel(duration, timeUnit) {
	const n = Number(duration) || 0;
	const minutes =
		timeUnit === "TIME_UNIT_MINUTE" ? n :
		timeUnit === "TIME_UNIT_HOUR" ? n * 60 :
		timeUnit === "TIME_UNIT_DAY" ? n * 1440 : 0;
	if (minutes === 0) return plainText(`${duration} ${timeUnit || "window"}`) || "window";
	if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
	if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
	return `${minutes}-minute window`;
}

function parseDirectQuota(d) {
	// Prefer the official usages.* fields; fall back to the wire limits[] rate-window
	// counters for windows the usages object no longer carries — limit_5h has appeared
	// and disappeared from both sources across API revisions (see CHANGELOG 1.3.0/1.6.1).
	const usages = {};
	const wire = d.usages || {};
	for (const key of Object.keys(USAGE_KEY_MAP)) {
		const u = wire[key];
		if (u && typeof u.used_ratio === "number") {
			usages[USAGE_KEY_MAP[key]] = { usedRatio: u.used_ratio, resetAt: u.reset_time || undefined };
		}
	}
	const windows = [];
	for (const entry of d.limits || []) {
		const detail = entry && entry.detail ? entry.detail : {};
		const win = entry && entry.window ? entry.window : {};
		const limit = Number(detail.limit);
		const used = Number(detail.used);
		if (!isFinite(limit) || limit <= 0 || !isFinite(used)) continue;
		const durationMinutes =
			win.timeUnit === "TIME_UNIT_MINUTE" ? Number(win.duration) :
			win.timeUnit === "TIME_UNIT_HOUR" ? Number(win.duration) * 60 :
			win.timeUnit === "TIME_UNIT_DAY" ? Number(win.duration) * 1440 : 0;
		windows.push({
			label: quotaWindowLabel(win.duration, win.timeUnit),
			short: durationMinutes === 300 ? "5h" : durationMinutes > 0 ? `${durationMinutes}m` : "win",
			ratio: used / limit,
			used,
			limit,
			resetAt: detail.resetTime || null,
			durationMinutes
		});
	}
	let extraUsage = null;
	const bw = d.booster_wallet || d.boosterWallet;
	if (bw && bw.balance) {
		const cents8 = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) / 1e6);
		const monthlyLimitCents = bw.monthlyChargeLimit ? Number(bw.monthlyChargeLimit.priceInCents) || 0 : 0;
		extraUsage = {
			balanceCents: cents8(bw.balance.amountLeft),
			totalCents: cents8(bw.balance.amount),
			monthlyChargeLimitEnabled: monthlyLimitCents > 0,
			monthlyChargeLimitCents: monthlyLimitCents,
			monthlyUsedCents: bw.monthlyUsed ? Number(bw.monthlyUsed.priceInCents) || 0 : 0,
			currency: currencyCode(
				(bw.monthlyChargeLimit && bw.monthlyChargeLimit.currency) ||
				(bw.topupLimit && bw.topupLimit.currency)
			)
		};
	}
	return { kind: "ok", source: "direct", windows, quota: { usages, extraUsage } };
}

async function fetchKimiQuotaDirect() {
	const file = kimiCredentialsFile();
	if (!file) {
		usageDebug("direct: no credentials file");
		return null;
	}
	let tok;
	try {
		tok = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		usageDebug("direct: credentials file unreadable");
		return null;
	}
	if (!tok || !tok.access_token) {
		usageDebug("direct: no access_token in credentials");
		return null;
	}
	if (typeof tok.expires_at === "number" && tok.expires_at - Date.now() / 1000 < 60) {
		// Let the Kimi extension refresh the token; the next poll reads the fresh file.
		usageDebug(`direct: token expires in ${Math.round(tok.expires_at - Date.now() / 1000)}s (<60) — skipped`);
		return null;
	}
	const urls = workingQuotaUrl
		? [workingQuotaUrl, ...quotaUrlCandidates().filter((u) => u !== workingQuotaUrl)]
		: quotaUrlCandidates();
	for (const url of urls) {
		try {
			const resp = await fetchWithTimeout(url, {
				headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" }
			});
			if (!resp.ok) {
				usageDebug(`${url} -> HTTP ${resp.status}`);
				continue;
			}
			const payload = await resp.json();
			const parsed = parseDirectQuota(payload);
			const slotCount = parsed.windows.length + Object.keys(parsed.quota.usages).length;
			const topKeys = payload && typeof payload === "object" ? Object.keys(payload) : [];
			const winDbg = parsed.windows.map((w) => `${w.durationMinutes}m:${w.used}/${w.limit}`).join(" ");
			const uDbg = Object.entries(parsed.quota.usages).map(([k, v]) => `${k}=${Math.round(v.usedRatio * 100)}%`).join(",");
			usageDebug(`${url} -> keys: ${topKeys.join(",") || "(none)"}; slots: ${slotCount}; windows: ${winDbg || "-"}; usages: ${uDbg || "-"}`);
			if (slotCount === 0) continue; // endpoint answered but carries no usable data — try the next candidate
			workingQuotaUrl = url;
			return parsed;
		} catch (err) {
			usageDebug(`${url} -> ${err}`);
		}
	}
	usageDebug("direct: no candidate endpoint returned usable quota data");
	return null;
}

function deepseekApiKey() {
	try {
		const cfg = fs.readFileSync(path.join(kimiHome, "config.toml"), "utf8");
		const m = cfg.match(/\[providers\.deepseek\][^[]*?api_key\s*=\s*"([^"]+)"/);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

async function fetchDeepseekBalance() {
	if (vscode.workspace.getConfiguration("kimiCompanion").get("deepseekBalance", true) === false) return null;
	const key = deepseekApiKey();
	if (!key) return null;
	const resp = await fetchWithTimeout(DEEPSEEK_BALANCE_URL, {
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }
	});
	if (!resp.ok) return null;
	const d = await resp.json();
	const b = d && Array.isArray(d.balance_infos) ? d.balance_infos[0] : null;
	if (!b) return null;
	return {
		available: d.is_available !== false,
		currency: currencyCode(b.currency),
		total: Number(b.total_balance) || 0,
		granted: Number(b.granted_balance) || 0,
		toppedUp: Number(b.topped_up_balance) || 0
	};
}

async function getUsage(force) {
	if (!force && usageCache.data && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.data;
	let res = null;
	const fn = globalThis.__kimiCompanionGetUsage;
	if (typeof fn === "function") {
		try {
			res = await fn(USAGE_PROVIDER);
			if (res && res.kind === "ok") {
				const uk = res.quota && res.quota.usages ? Object.keys(res.quota.usages) : [];
				usageDebug(`hook -> usages keys: ${uk.join(",") || "(none)"}`);
			}
		} catch (err) {
			usageDebug(`hook threw: ${err}`);
			res = null;
		}
	}
	if (!res || res.kind !== "ok") {
		try {
			res = await fetchKimiQuotaDirect();
		} catch (err) {
			usageDebug(`direct quota fetch failed: ${err}`);
		}
	}
	if (res && res.kind === "ok") {
		try {
			res.deepseek = await fetchDeepseekBalance();
		} catch (err) {
			usageDebug(`deepseek balance failed: ${err}`);
			res.deepseek = null;
		}
		res.updatedAt = Date.now();
		const preferOfficial = fiveHourSource.track(res);
		res.preferOfficial5h = preferOfficial;
		if (!preferOfficial && res.quota && res.quota.usages && res.quota.usages.limit5h) {
			usageDebug("5h: official value is stale or frozen; using the live wire counter");
		}
		usageCache = { data: res, at: res.updatedAt };
	}
	return res;
}

function usageSlots(res) {
	const slots = [];
	const windows = res && Array.isArray(res.windows) ? res.windows : [];
	const usages = res && res.quota && res.quota.usages ? res.quota.usages : {};
	const official5h = usages.limit5h && typeof usages.limit5h.usedRatio === "number" ? usages.limit5h : null;
	// The tracker detects a frozen official value by comparing successive responses.
	const useOfficial5h = !!official5h && (typeof res.preferOfficial5h === "boolean"
		? res.preferOfficial5h
		: official5h.usedRatio > 0);
	let has5hWindow = false;
	for (const w of windows) {
		if (w.durationMinutes === 300 && useOfficial5h) continue; // official field supersedes the wire counter
		if (w.durationMinutes === 300) has5hWindow = true;
		slots.push({
			id: `win${w.durationMinutes || 0}`,
			label: w.label,
			short: w.short,
			ratio: w.ratio,
			resetAt: w.resetAt,
			counter: `${w.used}/${w.limit}`,
			durationMinutes: w.durationMinutes
		});
	}
	for (const def of LIMITS) {
		if (def.key === "limit5h" && has5hWindow) continue; // live wire counter supersedes a missing/stale-zero official field
		const u = usages[def.key];
		if (!u || typeof u.usedRatio !== "number") continue;
		slots.push({
			id: def.key,
			label: def.label,
			short: def.short,
			ratio: u.usedRatio,
			resetAt: u.resetAt || null,
			durationMinutes: def.durationMinutes
		});
	}
	return slots;
}

// --- Pace, forecast, alerts -------------------------------------------

function formatDuration(ms) {
	if (!isFinite(ms) || ms < 0) return null;
	const m = Math.round(ms / 60000);
	if (m < 60) return `${m}m`;
	if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
	return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

function paceInfo(slot, nowMs) {
	if (!slot.resetAt || !slot.durationMinutes) return null;
	const resetMs = new Date(slot.resetAt).getTime();
	if (isNaN(resetMs)) return null;
	const windowMs = slot.durationMinutes * 60000;
	const elapsedMs = nowMs - (resetMs - windowMs);
	if (elapsedMs <= 0 || elapsedMs >= windowMs) return null;
	const pace = slot.ratio / (elapsedMs / windowMs); // 1.0 = exactly on track
	let depletesInMs = null;
	if (slot.ratio > 0 && slot.ratio < 1) {
		const t = (1 - slot.ratio) / (slot.ratio / elapsedMs);
		if (nowMs + t < resetMs) depletesInMs = t;
	}
	return { pace, depletesInMs, resetInMs: resetMs - nowMs };
}

// Thresholds are fractions 0..1; a percent typed by hand (80) is read as 0.8 instead of
// silently disabling the alert and the red highlight.
function fractionSetting(cfg, key, fallback) {
	let n = Number(cfg.get(key, fallback));
	if (!isFinite(n) || n < 0) return fallback;
	if (n > 1) n = n <= 100 ? n / 100 : 1;
	return n;
}

function paceLabel(pace) {
	return pace >= 1.25 ? "fast" : pace >= 0.8 ? "normal" : pace > 0.01 ? "slow" : "idle";
}

function paceSummary(slot, nowMs) {
	const info = paceInfo(slot, nowMs);
	if (!info) return null;
	const parts = [`pace ${paceLabel(info.pace)}`];
	if (info.depletesInMs != null) parts.push(`depletes in ~${formatDuration(info.depletesInMs)}`);
	else parts.push(`on track (~${Math.min(999, Math.round(info.pace * 100))}% by reset)`);
	parts.push(`resets in ${formatDuration(info.resetInMs)}`);
	// Status-bar highlight follows the configured 5h threshold (default 80% of the window):
	// the depletion forecast stays as tooltip text, only the raw ratio paints the bar,
	// so a fast pace does not flip the color early.
	const t5h = fractionSetting(vscode.workspace.getConfiguration("kimiCompanion"), "alertThreshold5h", 0.8);
	return { text: parts.join(" · "), hot: slot.durationMinutes <= 1440 && slot.ratio >= t5h };
}

async function checkQuotaAlerts(res) {
	if (!appContext) return;
	const cfg = vscode.workspace.getConfiguration("kimiCompanion");
	if (cfg.get("alerts", true) === false) return;
	const t5h = fractionSetting(cfg, "alertThreshold5h", 0.8);
	const tMonth = fractionSetting(cfg, "alertThresholdMonth", 0.9);
	const dsBelow = Number(cfg.get("alertDeepseekBelowUsd", 1));
	const latched = appContext.globalState.get(ALERT_LATCH_KEY, {});
	const now = Date.now();
	let dirty = false;
	const fire = (key, windowId, text) => {
		if (latched[key] === windowId) return;
		latched[key] = windowId;
		dirty = true;
		log.appendLine(`[alert] ${text}`);
		vscode.window.showWarningMessage(text, "Open usage").then((c) => {
			if (c) vscode.commands.executeCommand("kimiCompanion.usage");
		});
	};
	for (const s of usageSlots(res)) {
		const pi = paceInfo(s, now);
		if (s.id === "win300" || s.id === "limit5h") {
			if (s.ratio >= t5h) {
				const eta = pi && pi.depletesInMs != null ? ` — depletes in ~${formatDuration(pi.depletesInMs)}` : "";
				const left = pi ? `, resets in ${formatDuration(pi.resetInMs)}` : "";
				fire("5h", s.resetAt || "?", `Kimi quota: 5-hour window is ${Math.round(s.ratio * 100)}% used${eta}${left}.`);
			} else if (latched["5h"] && s.ratio < t5h * 0.9) {
				delete latched["5h"];
				dirty = true;
			}
		}
		if (s.id === "monthTotal") {
			if (s.ratio >= tMonth) {
				fire("month", s.resetAt || "?", `Kimi quota: monthly limit is ${Math.round(s.ratio * 100)}% used (resets ${resetStamp(s.resetAt, true) || "?"}).`);
			} else if (latched.month && s.ratio < tMonth * 0.9) {
				delete latched.month;
				dirty = true;
			}
		}
	}
	const ds = res.deepseek;
	if (ds && ds.available && ds.total < dsBelow) {
		fire("deepseek", "low", `DeepSeek balance is low: ${money(ds.total * 100, ds.currency)}.`);
	} else if (latched.deepseek && ds && ds.total >= dsBelow * 1.5) {
		delete latched.deepseek;
		dirty = true;
	}
	if (dirty) await appContext.globalState.update(ALERT_LATCH_KEY, latched);
}

function pad2(n) {
	return String(n).padStart(2, "0");
}

function localStamp(d) {
	return (
		`${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ` +
		`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
	);
}

function resetStamp(iso, withDate) {
	if (!iso) return null;
	const d = new Date(iso);
	if (isNaN(d.getTime())) return null;
	const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	return withDate ? `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${time}` : time;
}

function usageBar(ratio) {
	const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(ratio * BAR_WIDTH)));
	return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function money(cents, currency) {
	const value = (Number(cents) || 0) / 100;
	const code = currencyCode(currency);
	const sym = code === "USD" ? "$" : code === "RUB" ? "₽" : `${code} `;
	return `${sym}${value.toFixed(2)}`;
}

// --- Rich tooltip with progress bars -------------------------------------

let crcTable = null;
function crc32(buf) {
	if (typeof zlib.crc32 === "function") return Number(zlib.crc32(buf) >>> 0);
	if (!crcTable) {
		crcTable = new Int32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c;
		}
	}
	let c = ~0;
	for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 255];
	return (~c) >>> 0;
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}

function barPngDataUri(ratio, hot) {
	const W = 260;
	const H = 8;
	const r = Math.max(0, Math.min(1, ratio));
	const fg = hot ? [0xe5, 0x4a, 0x4a] : [0x2f, 0x81, 0xd6];
	const bg = [0x42, 0x45, 0x4a];
	const fillPx = Math.round(W * r);
	const raw = Buffer.alloc(H * (1 + W * 4));
	for (let y = 0; y < H; y++) {
		const ro = y * (1 + W * 4);
		for (let x = 0; x < W; x++) {
			const c = x < fillPx ? fg : bg;
			const o = ro + 1 + x * 4;
			raw[o] = c[0];
			raw[o + 1] = c[1];
			raw[o + 2] = c[2];
			raw[o + 3] = 255;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0);
	ihdr.writeUInt32BE(H, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib.deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0))
	]);
	return "data:image/png;base64," + png.toString("base64");
}

function usageTooltip(res, slots, nowMs) {
	const md = new vscode.MarkdownString(undefined, true);
	md.isTrusted = { enabledCommands: ["kimiCompanion.usage", "kimiCompanion.open"] };
	md.appendMarkdown(`**Kimi Code**\n\n---\n\n`);
	const freshness = usageFreshness(res, slots, nowMs);
	if (freshness === "stale") md.appendMarkdown(`${T.stale}\n\n---\n\n`);
	else if (freshness === "refresh-needed") md.appendMarkdown(`${T.refreshNeeded}\n\n---\n\n`);
	const order = (s) =>
		s.id === "monthTotal" ? 0 :
		s.id === "win300" || s.id === "limit5h" ? 1 :
		s.id === "limit7d" ? 2 : 3;
	for (const s of slots.slice().sort((a, b) => order(a) - order(b))) {
		const ps = paceSummary(s, nowMs);
		const reset = resetStamp(s.resetAt, true);
		md.appendMarkdown(`**${slotTitle(s)}**${reset ? ` — ${T.resetShort} ${reset}` : ""}\n\n`);
		md.appendMarkdown(`### **${Math.round(s.ratio * 100)}%** _${T.used}_${s.counter ? ` (${s.counter})` : ""}\n\n`);
		md.appendMarkdown(`![${Math.round(s.ratio * 100)}%](${barPngDataUri(s.ratio, freshness === "fresh" && !!(ps && ps.hot))})\n\n`);
		if (ps) md.appendMarkdown(`${ps.text}\n\n`);
		md.appendMarkdown(`---\n\n`);
	}
	const extra = res.quota && res.quota.extraUsage ? res.quota.extraUsage : null;
	const bits = [];
	if (extra && typeof extra.balanceCents === "number") {
		bits.push(`**${T.booster}:** ${T.leftFmt(money(extra.balanceCents, extra.currency), money(extra.totalCents, extra.currency))}`);
	}
	const ds = res.deepseek;
	if (ds) {
		bits.push(`**${T.deepseek}:** ${money(ds.total * 100, ds.currency)}${ds.available ? "" : ` — ${T.unavailable}`}`);
	}
	if (bits.length > 0) md.appendMarkdown(bits.join(" · ") + "\n\n---\n\n");
	md.appendMarkdown(
		`[$(graph) ${T.usageReport}](command:kimiCompanion.usage "Usage")  ·  [$(add) ${T.newWindow}](command:kimiCompanion.open "Open")`
	);
	return md;
}

function extraUsageLines(res) {
	const extra = res && res.quota ? res.quota.extraUsage : null;
	if (!extra || typeof extra.balanceCents !== "number") return [];
	const cur = extra.currency;
	const left = money(extra.balanceCents, cur);
	const total = money(extra.totalCents, cur);
	const used = money(extra.monthlyUsedCents, cur);
	const tail = extra.monthlyChargeLimitEnabled
		? `(monthly used ${used} of ${money(extra.monthlyChargeLimitCents, cur)} limit)`
		: `(monthly used ${used}, no monthly limit)`;
	return [`Booster wallet: ${left} left of ${total} ${tail}`];
}

function usageReport(res) {
	const slots = usageSlots(res);
	const freshness = usageFreshness(res, slots);
	const lines = [
		"Kimi Code subscription usage (api.kimi.com)",
		`Updated: ${localStamp(new Date(res.updatedAt || Date.now()))}`,
		`Freshness: ${freshness}`,
		""
	];
	if (slots.length === 0) lines.push("The response contains no limit data.");
	for (const s of slots) {
		const reset = resetStamp(s.resetAt, true);
		let line = `${s.label.padEnd(15)}[${usageBar(s.ratio)}]  ${Math.round(s.ratio * 100)}%`;
		if (s.counter) line += reset ? `   (${s.counter}, resets ${reset})` : `   (${s.counter})`;
		else if (reset) line += `   resets ${reset}`;
		lines.push(line);
		const ps = paceSummary(s, Date.now());
		if (ps) lines.push(`${"".padEnd(17)}${ps.text}`);
	}
	const extra = extraUsageLines(res);
	if (extra.length > 0) lines.push("", ...extra);
	const ds = res.deepseek;
	if (ds) {
		const total = money(ds.total * 100, ds.currency);
		const detail = `granted ${money(ds.granted * 100, ds.currency)}, topped up ${money(ds.toppedUp * 100, ds.currency)}`;
		lines.push(
			"",
			ds.available
				? `DeepSeek balance: ${total} (${detail})`
				: `DeepSeek balance: ${total} — unavailable, top-up needed (${detail})`
		);
	}
	lines.push("", `Debug: ${lastUsageDebug}`);
	return lines.join("\n") + "\n";
}

function usageErrorReport(res) {
	const lines = ["Kimi Code subscription usage (api.kimi.com)", `Updated: ${localStamp(new Date())}`, ""];
	if (!res) {
		lines.push("Usage is unavailable: no readable Kimi credentials and no __kimiCompanionGetUsage hook.");
		lines.push("Sign in to Kimi Code and reload the window so the extension gets activated and patched.");
	} else {
		const msg = res.error || res.message || res.reason;
		lines.push(`Usage request failed: ${typeof msg === "string" ? msg : JSON.stringify(res)}`);
	}
	lines.push("", `Debug: ${lastUsageDebug}`);
	return lines.join("\n") + "\n";
}

// At most one request is in flight; triggers during it coalesce into one reread.
let usageRefreshPromise = null;
let usageRefreshQueued = false;
function refreshUsageStatus() {
	if (usageRefreshPromise) {
		usageRefreshQueued = true;
		return usageRefreshPromise;
	}
	usageRefreshPromise = (async () => {
		do {
			usageRefreshQueued = false;
			await doRefreshUsageStatus();
		} while (usageRefreshQueued && !activationDisposed);
	})().finally(() => {
		usageRefreshPromise = null;
	});
	return usageRefreshPromise;
}

async function doRefreshUsageStatus() {
	const item = statusItem;
	if (!item || activationDisposed) return;
	const previous = usageCache.data;
	try {
		const fresh = await getUsage(false);
		const res = fresh && fresh.kind === "ok" ? fresh : previous;
		const now = Date.now();
		if (fresh && fresh.kind === "ok" && usageFreshness(fresh, usageSlots(fresh), now) === "fresh") {
			await checkQuotaAlerts(fresh).catch((err) => log.appendLine(`[alert] check failed: ${err}`));
		}
		const enabled = vscode.workspace.getConfiguration("kimiCompanion").get("usageInStatusBar", true) !== false;
		if (!enabled || !res || res.kind !== "ok") {
			item.text = STATUS_TEXT;
			item.tooltip = "Kimi Code";
			item.backgroundColor = undefined;
			return;
		}
		const slots = usageSlots(res);
		const freshness = usageFreshness(res, slots, now);
		const monthSlot = slots.find((s) => s.id === "monthTotal");
		const h5Slot = slots.find((s) => s.id === "win300" || s.id === "limit5h");
		const parts = [];
		if (monthSlot) parts.push(`M ${Math.round(monthSlot.ratio * 100)}%`);
		if (h5Slot) parts.push(`5h ${Math.round(h5Slot.ratio * 100)}%`);
		const extra = res.quota ? res.quota.extraUsage : null;
		if (extra && typeof extra.balanceCents === "number") parts.push(`$(credit-card) ${money(extra.balanceCents, extra.currency)}`);
		if (freshness === "stale") parts.push(T.stale);
		else if (freshness === "refresh-needed") parts.push(T.refreshNeeded);
		item.text = parts.length > 0 ? `$(kimi-companion-k) ${parts.join(" · ")}` : STATUS_TEXT;
		let hot = false;
		if (freshness === "fresh") {
			for (const s of slots) {
				const ps = paceSummary(s, now);
				if (ps && ps.hot) hot = true;
			}
		}
		item.tooltip = usageTooltip(res, slots, now);
		item.backgroundColor = hot ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
	} catch (err) {
		log.appendLine(`[usage] status refresh failed: ${err}`);
		item.text = STATUS_TEXT;
		item.tooltip = "Kimi Code";
		item.backgroundColor = undefined;
	}
}

// --- Virtual report documents ----------------------------------------

class ReportProvider {
	constructor() {
		this.emitter = new vscode.EventEmitter();
		this.onDidChange = this.emitter.event;
		this.docs = new Map();
	}
	provideTextDocumentContent(uri) {
		return this.docs.get(uri.toString()) || "";
	}
	show(uri, text) {
		const target = typeof uri === "string" ? vscode.Uri.parse(uri) : uri;
		this.docs.set(target.toString(), text);
		this.emitter.fire(target);
		return vscode.window.showTextDocument(target, {
			preview: false,
			viewColumn: vscode.ViewColumn.Beside
		});
	}
	dispose() {
		this.emitter.dispose();
	}
}

function showReport(uri, text) {
	if (!reportProvider) return Promise.resolve(undefined);
	return reportProvider.show(uri, text).then(
		() => undefined,
		(err) => {
			log.appendLine(`[report] cannot open ${uri}: ${err}`);
			return undefined;
		}
	);
}

async function showUsage() {
	const res = await getUsage(true);
	return showReport(USAGE_URI, res && res.kind === "ok" ? usageReport(res) : usageErrorReport(res));
}

// --- Diagnostics ------------------------------------------------------

function distDir() {
	const ext = vscode.extensions.getExtension(KIMI_EXT_ID);
	return ext ? path.join(ext.extensionUri.fsPath, "dist") : null;
}

function unitStatusLines(file, units) {
	const src = safe(() => fs.readFileSync(file, "utf8"));
	return units.map((unit) =>
		src === undefined
			? `MISSING ${unit.marker} (cannot read ${path.basename(file)})`
			: src.includes(unit.marker)
				? `OK      ${unit.marker}`
				: `MISSING ${unit.marker}`
	);
}

function pinnedStatus() {
	try {
		const file = path.join(os.homedir(), ".vscode", "extensions", "extensions.json");
		if (!fs.existsSync(file)) return "extensions.json not found";
		const list = JSON.parse(fs.readFileSync(file, "utf8"));
		const rec = Array.isArray(list)
			? list.find((e) => e && e.identifier && e.identifier.id === KIMI_EXT_ID)
			: null;
		if (!rec) return `no record for ${KIMI_EXT_ID}`;
		const pinned = rec.metadata ? rec.metadata.pinned : undefined;
		return pinned ? "yes" : "no";
	} catch (err) {
		return `unknown (${err})`;
	}
}

function hookStatus() {
	const names = [
		"__kimiCompanionPanels",
		"__kimiCompanionGetSessionId",
		"__kimiCompanionGetWebviewId",
		"__kimiCompanionLoadSession",
		"__kimiCompanionGetSidebarId",
		"__kimiCompanionGetUsage"
	];
	// __kimiCompanionTurnSettled / TurnStarted / Waiting / PromptSettled are defined by the
	// companion itself, so they are always functions — the patch units above are what matter.
	return names.map((n) => `${n}: ${typeof globalThis[n]}`);
}

function diagnosticsReport(context) {
	const kimiExt = vscode.extensions.getExtension(KIMI_EXT_ID);
	const dir = distDir();
	const lines = [
		"Kimi Code Companion — diagnostics",
		`Updated: ${localStamp(new Date())}`,
		"",
		"Versions",
		`  companion:            ${context.extension.packageJSON.version}`,
		`  moonshot-ai.kimi-code: ${kimiExt ? kimiExt.packageJSON.version : "not installed"}`,
		`  pinned in extensions.json: ${pinnedStatus()}`,
		"",
		"Patch units"
	];
	if (!dir) {
		lines.push("  the Kimi extension is not installed — dist not checked");
	} else {
		const wvUnits = wvUnitsFor(kimiExt.packageJSON.version);
		lines.push(`  webview unit set: ${wvUnits === WV_UNITS_084 ? "0.8.4 (Ve)" : "0.8.2–0.8.3 (Qe)"}`);
		for (const line of unitStatusLines(path.join(dir, "extension.js"), EXT_UNITS)) lines.push(`  ${line}`);
		for (const line of unitStatusLines(path.join(dir, "webview.js"), wvUnits)) lines.push(`  ${line}`);
	}
	if (lastPatchReport) {
		lines.push("", "Patch operation", `  state: ${lastPatchReport.state}`);
		for (const issue of lastPatchReport.issues || []) lines.push(`  ${issue}`);
		if (lastPatchReport.backup) lines.push(`  backup: ${JSON.stringify(lastPatchReport.backup)}`);
	}
	lines.push("", "Hooks in globalThis");
	for (const line of hookStatus()) lines.push(`  ${line}`);
	lines.push("", "Tracked windows");
	const entries = currentEntries();
	if (entries.length === 0) {
		lines.push("  none");
	} else {
		entries.forEach((e, i) => {
			lines.push(
				`  #${i + 1} "${e.title}" session=${e.sessionId || "-"} column=${e.column === null ? "-" : e.column}`
			);
		});
	}
	const sidebar = context.workspaceState.get(SIDEBAR_KEY, null);
	lines.push("", `Saved sidebar session: ${sidebar || "-"}`);
	const closed = context.workspaceState.get(CLOSED_KEY, []);
	lines.push(`Closed history (${closed.length}):`);
	for (const e of closed) lines.push(`  "${e.title}" session=${e.sessionId || "-"}`);
	lines.push("", `Kimi home: ${kimiHome}`);
	const index = path.join(kimiHome, "session_index.jsonl");
	lines.push(`session_index.jsonl: ${fs.existsSync(index) ? "found" : "missing"}`);
	return lines.join("\n") + "\n";
}

function showDiagnostics(context) {
	return showReport(DIAG_URI, diagnosticsReport(context));
}

// --- Menu ---------------------------------------------------------------

const STR = {
	en: {
		monthly: "Monthly total", monthCode: "Monthly (code)", sevenDay: "7-day limit", fiveHour: "5-hour window",
		booster: "Booster wallet", deepseek: "DeepSeek balance", used: "used", monthlyUsed: "monthly used",
		leftFmt: (l, t) => `${l} left of ${t}`,
		available: "available", unavailable: "unavailable — top-up needed",
		usageReport: "Usage report", resetShort: "reset",
		refreshQuota: "Refresh quota", newWindow: "New window",
		reopenClosed: "Reopen closed window", openWindows: "Open windows",
		noQuota: "Quota unavailable — open a Kimi window or sign in",
		stale: "⚠ stale", refreshNeeded: "↻ refresh needed",
		noOpenChats: "No open Kimi chats.", noWaitingChats: "No Kimi chats are waiting for input.", noAttentionChats: "No Kimi chats need attention.",
		openChats: {
			title: "Open Kimi chats", placeholder: "Search open chats", statusRunning: "working", statusWaiting: "waiting for input", statusDone: "done", statusError: "error",
			counterTooltip: (n) => `${n} Kimi chat(s) waiting for input`
		},
		tabCompletionMessage: (title) => `Kimi Code: the work in "${title}" is complete.`
	},
	ru: {
		monthly: "Месячный лимит", monthCode: "Месячный (code)", sevenDay: "7-дневный лимит", fiveHour: "5-часовое окно",
		booster: "Бустер-кошелёк", deepseek: "Баланс DeepSeek", used: "использовано", monthlyUsed: "за месяц использовано",
		leftFmt: (l, t) => `осталось ${l} из ${t}`,
		available: "доступен", unavailable: "недоступен — нужно пополнить",
		usageReport: "Отчёт по лимитам", resetShort: "сброс",
		refreshQuota: "Обновить лимиты", newWindow: "Новое окно",
		reopenClosed: "Вернуть закрытое окно", openWindows: "Открытые окна",
		noQuota: "Квота недоступна — откройте окно Kimi или войдите",
		stale: "⚠ устарело", refreshNeeded: "↻ нужно обновить",
		noOpenChats: "Нет открытых чатов Kimi.", noWaitingChats: "Нет чатов Kimi, ожидающих ответа.", noAttentionChats: "Нет чатов Kimi, требующих внимания.",
		openChats: {
			title: "Открытые чаты Kimi", placeholder: "Поиск открытых чатов", statusRunning: "работа", statusWaiting: "ожидает ответа", statusDone: "завершён", statusError: "ошибка",
			counterTooltip: (n) => `Ожидают ответа: ${n}`
		},
		tabCompletionMessage: (title) => `Kimi Code: работа во вкладке «${title}» завершена.`
	},
	zh: {
		monthly: "月度限额", monthCode: "月度限额 (code)", sevenDay: "7 天限额", fiveHour: "5 小时窗口",
		booster: "Booster 钱包", deepseek: "DeepSeek 余额", used: "已用", monthlyUsed: "本月已用",
		leftFmt: (l, t) => `剩余 ${l}，共 ${t}`,
		available: "可用", unavailable: "不可用——请充值",
		usageReport: "用量报告", resetShort: "重置",
		refreshQuota: "刷新用量", newWindow: "新建窗口",
		reopenClosed: "重新打开已关闭的窗口", openWindows: "已打开的窗口",
		noQuota: "配额不可用——请打开 Kimi 窗口或登录",
		stale: "⚠ 已过期", refreshNeeded: "↻ 需要刷新",
		noOpenChats: "没有打开的 Kimi 聊天。", noWaitingChats: "没有等待输入的 Kimi 聊天。", noAttentionChats: "没有需要注意的 Kimi 聊天。",
		openChats: {
			title: "打开的 Kimi 聊天", placeholder: "搜索打开的聊天", statusRunning: "进行中", statusWaiting: "等待输入", statusDone: "已完成", statusError: "错误",
			counterTooltip: (n) => `${n} 个 Kimi 聊天等待输入`
		},
		tabCompletionMessage: (title) => `Kimi Code：「${title}」中的任务已完成。`
	}
};
const T = (() => {
	const lang = (vscode.env.language || "en").toLowerCase();
	return STR[lang.startsWith("ru") ? "ru" : lang.startsWith("zh") ? "zh" : "en"];
})();

function slotTitle(s) {
	if (s.id === "monthTotal") return T.monthly;
	if (s.id === "monthCode") return T.monthCode;
	if (s.id === "limit7d") return T.sevenDay;
	if (s.id === "win300" || s.id === "limit5h") return T.fiveHour;
	return s.label;
}

async function showMenu() {
	const items = [];
	items.push({ label: `$(refresh) ${T.refreshQuota}`, action: "refresh" });
	items.push({ label: `$(add) ${T.newWindow}`, action: "open" });
	items.push({ label: `$(history) ${T.reopenClosed}`, action: "reopen" });
	items.push({ label: `$(list-selection) ${T.openWindows}`, action: "openChats" });
	const panels = getKimiPanels();
	if (panels.length > 0) {
		items.push({ label: T.openWindows, kind: vscode.QuickPickItemKind.Separator });
		panels.forEach((p, i) => items.push({ label: p.title, description: `#${i + 1}`, panel: p }));
	}
	const picked = await vscode.window.showQuickPick(items, { title: "Kimi Code" });
	if (!picked) return;
	if (picked.panel) {
		safe(() => picked.panel.reveal());
		return;
	}
	if (picked.action === "refresh") {
		usageCache = { data: usageCache.data, at: 0 };
		await refreshUsageStatus();
		await showMenu();
		return;
	}
	const command = {
		open: "kimiCompanion.open",
		reopen: "kimiCompanion.reopenClosed",
		openChats: "kimiCompanion.openChats"
	}[picked.action];
	if (command) await vscode.commands.executeCommand(command);
}

function getKimiPanels() {
	const arr = globalThis.__kimiCompanionPanels;
	if (!Array.isArray(arr)) return [];
	return arr.filter((p) => {
		try {
			void p.title;
			return true;
		} catch {
			return false;
		}
	});
}

// --- Tab status markers -------------------------------------------------

const STATUS_MARKERS = { running: "[~]", done: "[V]", error: "[!]", waiting: "[?]" };
const STATUS_RE = /^(?:\[~]|\[V]|\[!]|\[\?])\s+/;
const panelStatus = new WeakMap();

function stripStatusMarker(title) {
	return String(title || "").replace(STATUS_RE, "");
}

function statusMarkersEnabled() {
	return vscode.workspace.getConfiguration("kimiCompanion").get("tabStatusMarkers", true);
}

function setPanelStatus(panel, status) {
	const base = stripStatusMarker(safe(() => panel.title) || "");
	if (!base) return;
	if (status) panelStatus.set(panel, status);
	else panelStatus.delete(panel);
	const marker = status && statusMarkersEnabled() ? STATUS_MARKERS[status] + " " : "";
	try {
		if (panel.title !== marker + base) panel.title = marker + base;
		log.appendLine(`[status] ${status || "idle"} "${base}"`);
		if (openChats) void openChats.refresh();
	} catch {
		// panel gone
	}
}

// --- Turn completion alert ---------------------------------------------

const COMPLETION_SOUND = path.join(__dirname, "resources", "completion.wav");
const SOUND_COMMAND = {
	win32: ["powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", "$s=New-Object System.Media.SoundPlayer($env:KIMI_COMPANION_SOUND); $s.PlaySync()"]],
	darwin: ["/usr/bin/afplay", [COMPLETION_SOUND]],
	linux: ["paplay", [COMPLETION_SOUND]]
};

function playCompletionSound() {
	try {
		if (vscode.env.uiKind !== vscode.UIKind.Desktop || vscode.env.remoteName) return;
		const spec = SOUND_COMMAND[process.platform];
		if (!spec) return;
		const options = { stdio: "ignore", windowsHide: true };
		if (process.platform === "win32") {
			options.env = { ...process.env, KIMI_COMPANION_SOUND: COMPLETION_SOUND };
		}
		const child = spawn(spec[0], spec[1], options);
		child.on("error", (err) => {
			if (log) log.appendLine(`[sound] FAILED: ${err}`);
		});
	} catch (err) {
		if (log) log.appendLine(`[sound] FAILED: ${err}`);
	}
}

function findPanelsByWebviewIds(webviewIds) {
	const { getWebviewId } = getHooks();
	if (!getWebviewId || !Array.isArray(webviewIds) || webviewIds.length === 0) return [];
	return getKimiPanels().filter((p) => {
		const wid = safe(() => getWebviewId(p));
		return wid && webviewIds.includes(wid);
	});
}

function findPanelByWebviewIds(webviewIds) {
	return findPanelsByWebviewIds(webviewIds)[0] || null;
}

function updateStatusOnStarted(info) {
	try {
		if (!info) return;
		for (const p of findPanelsByWebviewIds(info.webviewIds)) setPanelStatus(p, "running");
	} catch (err) {
		if (log) log.appendLine(`[status] start FAILED: ${err}`);
	}
}

function updateStatusOnWaiting(info) {
	try {
		if (!info) return;
		for (const p of findPanelsByWebviewIds(info.webviewIds)) {
			if (info.waiting) setPanelStatus(p, "waiting");
			else if (panelStatus.get(p) === "waiting") setPanelStatus(p, "running");
		}
	} catch (err) {
		if (log) log.appendLine(`[status] waiting FAILED: ${err}`);
	}
}

function updateStatusOnSettled(info) {
	try {
		if (!info) return;
		let status;
		if (info.reason === "completed") status = "done";
		else if (info.reason === "cancelled") status = null;
		else status = "error";
		for (const p of findPanelsByWebviewIds(info.webviewIds)) setPanelStatus(p, status);
	} catch (err) {
		if (log) log.appendLine(`[status] settled FAILED: ${err}`);
	}
}

// Fallback for prompt ends that bypass emitTerminal: only a still-live [~]/[?] is resolved,
// a status already set by the turn terminal (which fires first) is left as is.
function updateStatusOnPromptSettled(info) {
	try {
		if (!info) return;
		const status = info.status === "finished" ? "done" : info.status === "cancelled" ? null : "error";
		for (const p of findPanelsByWebviewIds(info.webviewIds)) {
			const current = panelStatus.get(p);
			if (current === "running" || current === "waiting") setPanelStatus(p, status);
		}
	} catch (err) {
		if (log) log.appendLine(`[status] prompt settled FAILED: ${err}`);
	}
}

async function notifyTabCompletion(info) {
	try {
		const config = vscode.workspace.getConfiguration("kimiCompanion");
		const notify = config.get("tabCompletionNotification", false);
		const sound = config.get("tabCompletionSound", true);
		if (!notify && !sound) return;
		if (!info || info.reason !== "completed" || info.promptActive !== true) return;
		const panel = findPanelByWebviewIds(info.webviewIds);
		if (!panel) return;
		const title = stripStatusMarker(safe(() => panel.title) || DEFAULT_TITLE);
		log.appendLine(`[done] "${title}" session=${info.sessionId || "-"}`);
		if (sound) playCompletionSound();
		if (!notify) return;
		await vscode.window.showInformationMessage(T.tabCompletionMessage(title));
	} catch (err) {
		if (log) log.appendLine(`[done] FAILED: ${err}`);
	}
}

// --- Tracking state -------------------------------------------------

function currentEntries() {
	const { getWebviewId, getSessionId } = getHooks();
	return getKimiPanels().map((p) => {
		let sessionId = null;
		const wid = getWebviewId ? safe(() => getWebviewId(p)) : undefined;
		if (wid && getSessionId) sessionId = safe(() => getSessionId(wid)) || null;
		return {
			title: stripStatusMarker(p.title),
			sessionId,
			column: safe(() => p.viewColumn) || null,
			userNamed: userNamedPanels.has(p) || undefined
		};
	});
}

function recordClosed(context, prev, now) {
	// Keyed by session only: auto-naming and renames change the title of a window that is
	// still open, and must not put its session into the closed history.
	const nowSessions = new Set(now.map((e) => e.sessionId).filter(Boolean));
	const goneBySession = new Map();
	for (const entry of prev) {
		if (entry.sessionId && !nowSessions.has(entry.sessionId)) goneBySession.set(entry.sessionId, entry);
	}
	const gone = [...goneBySession.values()];
	if (gone.length === 0) return;
	const goneSessions = new Set(goneBySession.keys());
	const hist = context.workspaceState.get(CLOSED_KEY, []).filter((e) => !goneSessions.has(e.sessionId));
	hist.push(...gone);
	while (hist.length > CLOSED_MAX) hist.shift();
	context.workspaceState.update(CLOSED_KEY, hist);
	if (log) log.appendLine(`[closed] remembered: ${JSON.stringify(gone)}`);
}

// --- Auto-naming windows from session topic --------------------------

const kimiHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
let sessionDirCache = null;
let sessionDirCacheTime = 0;

function sessionDirOf(sessionId) {
	const now = Date.now();
	if (!sessionDirCache || now - sessionDirCacheTime > 30000) {
		sessionDirCache = new Map();
		sessionDirCacheTime = now;
		try {
			const lines = fs.readFileSync(path.join(kimiHome, "session_index.jsonl"), "utf8").split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				const rec = safe(() => JSON.parse(line));
				if (rec && rec.sessionId && rec.sessionDir && !rec.deleted) {
					sessionDirCache.set(rec.sessionId, rec.sessionDir);
				}
			}
		} catch {
			// no index yet
		}
	}
	return sessionDirCache.get(sessionId) || null;
}

// A session without a topic yet is re-checked every 10 s instead of on every 2 s poll.
const NAME_RETRY_MS = 10000;
const unnamedSessions = new Map();

function deriveSessionName(sessionId) {
	const miss = unnamedSessions.get(sessionId);
	if (miss && Date.now() - miss < NAME_RETRY_MS) return null;
	const name = readSessionName(sessionId);
	if (name) unnamedSessions.delete(sessionId);
	else unnamedSessions.set(sessionId, Date.now());
	return name;
}

function readSessionName(sessionId) {
	const dir = sessionDirOf(sessionId);
	if (!dir) return null;
	const statePath = path.isAbsolute(dir) ? path.join(dir, "state.json") : path.join(kimiHome, dir, "state.json");
	const state = safe(() => JSON.parse(fs.readFileSync(statePath, "utf8")));
	if (!state) return null;
	const name = String(state.title || state.lastPrompt || "").replace(/\s+/g, " ").trim();
	if (!name) return null;
	return name.length > 42 ? name.slice(0, 41) + "…" : name;
}

// A window the companion opens itself is titled after the current project rather than the
// generic "Kimi Code": that title is the companion's own default, not a name the user chose.
function defaultWindowTitle() {
	const name = safe(() => vscode.workspace.name);
	const folders = safe(() => vscode.workspace.workspaceFolders) || [];
	const folderName = folders.length === 1 ? safe(() => folders[0].name) : undefined;
	for (const candidate of [name, folderName]) {
		const title = String(candidate || "").replace(/\s+/g, " ").trim();
		if (title) return title;
	}
	return DEFAULT_TITLE;
}

// Panels the user renamed by hand keep their title even when it is "Kimi Code".
const userNamedPanels = new WeakSet();

function autoNamePanels() {
	const { getWebviewId, getSessionId } = getHooks();
	if (!getWebviewId || !getSessionId) return;
	const autoTitles = [DEFAULT_TITLE, defaultWindowTitle()];
	for (const p of getKimiPanels()) {
		if (userNamedPanels.has(p) || !autoTitles.includes(stripStatusMarker(p.title))) continue;
		const wid = safe(() => getWebviewId(p));
		const sid = wid ? safe(() => getSessionId(wid)) : null;
		if (!sid) continue;
		const name = deriveSessionName(sid);
		if (name) {
			try {
				const status = panelStatus.get(p) || null;
				const marker = status && statusMarkersEnabled() ? STATUS_MARKERS[status] + " " : "";
				p.title = marker + name;
				log.appendLine(`[autoname] "${name}"`);
			} catch {
				// panel gone
			}
		}
	}
}

function persistSidebarSession(context) {
	if (!canPersistState()) return;
	const { getSidebarId, getSessionId } = getHooks();
	if (!getSidebarId || !getSessionId) return;
	const wid = safe(() => getSidebarId());
	if (!wid) return;
	const sid = safe(() => getSessionId(wid));
	if (sid && sid !== lastSidebarSession) {
		lastSidebarSession = sid;
		context.workspaceState.update(SIDEBAR_KEY, sid);
		log.appendLine(`[sync] sidebar session: ${sid}`);
	}
}

function reconcile(context, reason) {
	if (activationDisposed) return;
	const entries = currentEntries();
	const json = JSON.stringify(entries);
	if (canPersistState() && json !== lastPersisted) {
		recordClosed(context, JSON.parse(lastPersisted), entries);
		lastPersisted = json;
		context.workspaceState.update(ENTRIES_KEY, entries);
		log.appendLine(`[sync:${reason}] tracked: ${json}`);
	}
	persistSidebarSession(context);
	autoNamePanels();
	if (openChats) void openChats.refresh();
}

// --- Patching the Kimi extension ------------------------------------

function patchOptions(ext) {
	const version = String(ext.packageJSON.version);
	return {
		extensionPath: ext.extensionUri.fsPath,
		version,
		extUnits: EXT_UNITS,
		wvUnits: wvUnitsFor(version)
	};
}

function offerReload(message) {
	vscode.window.showInformationMessage(message, "Reload Window").then((choice) => {
		if (choice) vscode.commands.executeCommand("workbench.action.reloadWindow");
	});
}

async function runPatchOperation(operation, notify = true) {
	const ext = vscode.extensions.getExtension(KIMI_EXT_ID);
	if (!ext || !patchManager) return null;
	try {
		const report = await patchManager[operation](patchOptions(ext));
		lastPatchReport = report;
		log.appendLine(`[patch] ${operation}: ${report.state}; ${report.issues.join("; ") || "ok"}`);
		if (notify && report.changed) offerReload(`Kimi Code Companion: Kimi files were ${operation === "restore" ? "restored" : "patched"} — a window reload is required.`);
		else if (notify && !report.ok) vscode.window.showWarningMessage(`Kimi Code Companion: patch state is ${report.state}. ${report.issues.join(" ")}`);
		return report;
	} catch (err) {
		lastPatchReport = err.report || { state: "error", issues: [String(err)] };
		log.appendLine(`[patch] ${operation} FAILED: ${err}`);
		if (notify) vscode.window.showWarningMessage(`Kimi Code Companion: ${operation} failed — ${err.message || err}`);
		return lastPatchReport;
	}
}

async function ensureMoonshotPatched() {
	if (!vscode.extensions.getExtension(KIMI_EXT_ID)) {
		log.appendLine("[patch] moonshot-ai.kimi-code not installed");
		return;
	}
	await runPatchOperation("install");
}

async function restoreMoonshotOriginals() {
	const choice = await vscode.window.showWarningMessage(
		"Restore the original Kimi extension files? The Companion features that depend on patches will stop working after reload.",
		{ modal: true },
		"Restore Original Files"
	);
	if (choice) await runPatchOperation("restore");
}

// --- Opening / restoring ---------------------------------------------

let openQueue = Promise.resolve();
function openKimiTab(context, reason, title, column, userNamed = false) {
	const run = openQueue.then(() => openKimiTabNow(context, reason, title, column, userNamed));
	openQueue = run.then(() => undefined, () => undefined);
	return run;
}

async function openKimiTabNow(context, reason, title, column, userNamed) {
	if (activationDisposed) return undefined;
	log.appendLine(`[open:${reason}] kimi.openInTab${title ? ` title="${title}"` : ""}${column ? ` column=${column}` : ""}`);
	const before = new Set(getKimiPanels());
	try {
		if (title) globalThis.__kimiCompanionNextTitle = title;
		if (column) globalThis.__kimiCompanionNextColumn = column;
		await vscode.commands.executeCommand("kimi.openInTab");
		if (activationDisposed) return undefined;
		const panel = getKimiPanels().find((candidate) => !before.has(candidate));
		if (panel && userNamed) userNamedPanels.add(panel);
		log.appendLine(`[open:${reason}] OK, captured=${panel !== undefined}, tracked=${getKimiPanels().length}`);
		reconcile(context, `open:${reason}`);
		if (!panel) throw new Error("the command completed without creating a new Kimi panel");
		return panel;
	} catch (err) {
		const msg = err && err.message ? err.message : String(err);
		log.appendLine(`[open:${reason}] FAILED: ${msg}`);
		vscode.window.showWarningMessage(`Kimi Code Companion: failed to open a Kimi window — ${msg}`);
		return undefined;
	} finally {
		delete globalThis.__kimiCompanionNextTitle;
		delete globalThis.__kimiCompanionNextColumn;
	}
}

async function ensureSessionLoadedById(wid, sessionId, label) {
	const { getSessionId, loadSession } = getHooks();
	if (!getSessionId || !loadSession) {
		log.appendLine("[restore] session hooks unavailable — history not restored");
		return false;
	}
	for (let attempt = 1; attempt <= 5; attempt++) {
		if (!await delay(1200)) return false;
		const current = safe(() => getSessionId(wid)) || null;
		if (current === sessionId) {
			log.appendLine(`[restore] history attached in ${label}: ${sessionId}`);
			return true;
		}
		if (current) {
			log.appendLine(`[restore] ${label} already has another session (${current}), leaving it`);
			return false;
		}
		log.appendLine(`[restore] loading ${sessionId} into ${label} (attempt ${attempt})`);
		try {
			loadSession(wid, sessionId);
		} catch (err) {
			log.appendLine(`[restore] loadSession error: ${err}`);
		}
	}
	log.appendLine(`[restore] gave up on ${sessionId}`);
	return false;
}

async function ensureSessionLoaded(panel, sessionId) {
	const { getWebviewId } = getHooks();
	const wid = getWebviewId ? safe(() => getWebviewId(panel)) : undefined;
	if (!wid) {
		log.appendLine("[restore] no webviewId for panel");
		return false;
	}
	return ensureSessionLoadedById(wid, sessionId, wid);
}

async function restoreWindows(context, entries) {
	restoringWindows = true;
	try {
		if (!await delay(1500)) return;
		if (getKimiPanels().length > 0) {
			log.appendLine("[restore] windows already present, skipping");
			return;
		}
		const jobs = [];
		for (const entry of entries) {
			const panel = await openKimiTab(context, "restore", entry.title, entry.column, entry.userNamed);
			if (!panel) {
				restoreHadFailure = true;
				continue;
			}
			if (entry.sessionId) jobs.push(ensureSessionLoaded(panel, entry.sessionId));
		}
		const results = await Promise.all(jobs);
		if (results.some((ok) => !ok)) restoreHadFailure = true;
	} catch (err) {
		restoreHadFailure = true;
		log.appendLine(`[restore] windows FAILED: ${err}`);
	} finally {
		restoringWindows = false;
		startupDone = true;
		reconcile(context, "restore");
	}
}

async function restoreSidebarSession(context, sessionId) {
	restoringSidebar = true;
	try {
		const deadline = Date.now() + 90000;
		while (Date.now() < deadline && !activationDisposed) {
			const { getSidebarId } = getHooks();
			const wid = getSidebarId ? safe(() => getSidebarId()) : undefined;
			if (wid) {
				const ok = await ensureSessionLoadedById(wid, sessionId, "sidebar");
				if (!ok) restoreHadFailure = true;
				return;
			}
			if (!await delay(POLL_MS)) return;
		}
		log.appendLine("[restore] sidebar webview did not appear — history not restored");
		restoreHadFailure = true;
	} finally {
		restoringSidebar = false;
	}
}

// --- Commands ----------------------------------------------------------

async function renameWindow(context) {
	const panels = getKimiPanels();
	if (panels.length === 0) {
		vscode.window.showInformationMessage(
			"Kimi Code Companion: no Kimi windows are open. Open a Kimi window and try again."
		);
		return;
	}
	let panel = panels.find((p) => safe(() => p.active));
	if (!panel && panels.length === 1) panel = panels[0];
	if (!panel) {
		const picked = await vscode.window.showQuickPick(
			panels.map((p, i) => ({ label: p.title, description: `#${i + 1}`, panel: p })),
			{ placeHolder: "Which Kimi window should be renamed?" }
		);
		if (!picked) return;
		panel = picked.panel;
	}
	panel.reveal(undefined, false);
	const name = await vscode.window.showInputBox({
		prompt: "New title for the Kimi window",
		value: stripStatusMarker(panel.title),
		ignoreFocusOut: true
	});
	if (!name || !name.trim()) return;
	try {
		panel.title = name.trim();
		userNamedPanels.add(panel);
		setPanelStatus(panel, panelStatus.get(panel) || null);
		log.appendLine(`[rename] title set to "${name.trim()}"`);
		reconcile(context, "rename");
	} catch (err) {
		log.appendLine(`[rename] FAILED: ${err}`);
		vscode.window.showWarningMessage(`Kimi Code Companion: failed to rename — ${err}`);
	}
}

async function reopenClosed(context) {
	const hist = context.workspaceState.get(CLOSED_KEY, []);
	if (hist.length === 0) {
		vscode.window.showInformationMessage("Kimi Code Companion: no recently closed Kimi windows.");
		return;
	}
	const entry = hist[hist.length - 1];
	log.appendLine(`[reopen] ${JSON.stringify(entry)}`);
	const panel = await openKimiTab(context, "reopen", entry.title, entry.column, entry.userNamed);
	if (!panel) return;
	const current = context.workspaceState.get(CLOSED_KEY, []);
	context.workspaceState.update(CLOSED_KEY, current.filter((item) => item !== entry && item.sessionId !== entry.sessionId));
	if (entry.sessionId) void ensureSessionLoaded(panel, entry.sessionId);
}

// --- Activation ---------------------------------------------------------

async function initializeRestore(context, entries, sidebarSession) {
	if (!restoreEnabledForSession || activationDisposed) {
		startupDone = true;
		return;
	}
	try {
		await fs.promises.mkdir(path.dirname(windowLease.filePath), { recursive: true });
		if (!await windowLease.acquire()) {
			startupDone = true;
			log.appendLine("[restore] another window owns this workspace snapshot; leaving it unchanged");
			return;
		}
	} catch (err) {
		startupDone = true;
		restoreHadFailure = true;
		log.appendLine(`[restore] lease failed: ${err}`);
		return;
	}
	if (entries.length > 0) await restoreWindows(context, entries);
	else startupDone = true;
	if (activationDisposed) return;
	if (sidebarSession) {
		lastSidebarSession = sidebarSession;
		await restoreSidebarSession(context, sidebarSession);
	}
	reconcile(context, "startup");
}

function activate(context) {
	appContext = context;
	activationDisposed = false;
	startupDone = false;
	restoreHadFailure = false;
	log = vscode.window.createOutputChannel("Kimi Code Companion");
	context.subscriptions.push(log);
	log.appendLine(`[activate] ${new Date().toISOString()}`);
	patchManager = new PatchDistManager({ backupDir: path.join(context.globalStorageUri.fsPath, "patches") });
	windowLease = new WindowLease({
		filePath: path.join(context.globalStorageUri.fsPath, "window-restore.lease"),
		ownerId: randomUUID()
	});

	globalThis.__kimiCompanionTurnSettled = (info) => {
		setTimeout(() => {
			if (activationDisposed) return;
			updateStatusOnSettled(info);
			void notifyTabCompletion(info);
		}, 0);
	};
	globalThis.__kimiCompanionTurnStarted = (info) => setTimeout(() => {
		if (!activationDisposed) updateStatusOnStarted(info);
	}, 0);
	globalThis.__kimiCompanionWaiting = (info) => setTimeout(() => {
		if (!activationDisposed) updateStatusOnWaiting(info);
	}, 0);
	globalThis.__kimiCompanionPromptSettled = (info) => setTimeout(() => {
		if (!activationDisposed) updateStatusOnPromptSettled(info);
	}, 0);

	restoreEnabledForSession = vscode.workspace.getConfiguration("kimiCompanion").get("restoreTabOnStartup", true);
	let entries = context.workspaceState.get(ENTRIES_KEY, null);
	if (!Array.isArray(entries)) {
		const legacy = context.workspaceState.get(LEGACY_NAMES_KEY, []);
		entries = legacy.map((t) => ({ title: t, sessionId: null, column: null }));
	}
	lastPersisted = JSON.stringify(entries);
	const sidebarSession = context.workspaceState.get(SIDEBAR_KEY, null);
	log.appendLine(`[activate] restoreEnabled=${restoreEnabledForSession} saved=${JSON.stringify(entries)} sidebar=${sidebarSession}`);

	reportProvider = new ReportProvider();
	context.subscriptions.push(reportProvider, vscode.workspace.registerTextDocumentContentProvider("kimi-companion", reportProvider));
	openChats = new OpenChatsController({
		getPanels: () => getKimiPanels().map((panel) => ({ panel, title: stripStatusMarker(panel.title), status: panelStatus.get(panel) || null })),
		reveal: (panel) => panel.reveal(),
		createQuickPick: () => vscode.window.createQuickPick(),
		createStatusItem: () => {
			const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
			item.command = "kimiCompanion.nextWaitingChat";
			return item;
		},
		texts: T.openChats
	});
	context.subscriptions.push(openChats);

	context.subscriptions.push(
		vscode.window.tabGroups.onDidChangeTabs(() => reconcile(context, "tabsChanged")),
		vscode.commands.registerCommand("kimiCompanion.open", () => { void openKimiTab(context, "command", defaultWindowTitle()); }),
		vscode.commands.registerCommand("kimiCompanion.rename", () => { void renameWindow(context); }),
		vscode.commands.registerCommand("kimiCompanion.reopenClosed", () => { void reopenClosed(context); }),
		vscode.commands.registerCommand("kimiCompanion.usage", () => { void showUsage(); }),
		vscode.commands.registerCommand("kimiCompanion.diagnostics", () => { void showDiagnostics(context); }),
		vscode.commands.registerCommand("kimiCompanion.checkCompatibility", async () => {
			await runPatchOperation("check", false);
			await showDiagnostics(context);
		}),
		vscode.commands.registerCommand("kimiCompanion.installPatch", () => runPatchOperation("install")),
		vscode.commands.registerCommand("kimiCompanion.restorePatch", () => restoreMoonshotOriginals()),
		vscode.commands.registerCommand("kimiCompanion.openChats", () => {
			if (!openChats.show()) vscode.window.showInformationMessage(T.noOpenChats);
		}),
		vscode.commands.registerCommand("kimiCompanion.nextWaitingChat", () => {
			if (!openChats.nextWaiting()) vscode.window.showInformationMessage(T.noWaitingChats);
		}),
		vscode.commands.registerCommand("kimiCompanion.nextAttentionChat", () => {
			if (!openChats.nextAttention()) vscode.window.showInformationMessage(T.noAttentionChats);
		}),
		vscode.commands.registerCommand("kimiCompanion.menu", () => { void showMenu(); })
	);

	const pollTimer = setInterval(() => reconcile(context, "poll"), POLL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
	item.text = STATUS_TEXT;
	item.tooltip = "Kimi Code";
	item.command = "kimiCompanion.menu";
	statusItem = item;
	context.subscriptions.push(item);
	const usageTimer = setInterval(() => { void refreshUsageStatus(); }, USAGE_REFRESH_MS);
	context.subscriptions.push({ dispose: () => clearInterval(usageTimer) });
	void refreshUsageStatus();

	const updateButton = () => {
		const enabled = vscode.workspace.getConfiguration("kimiCompanion").get("statusBarButton", true);
		if (enabled) item.show();
		else item.hide();
	};
	updateButton();
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration("kimiCompanion.statusBarButton")) updateButton();
		if (e.affectsConfiguration("kimiCompanion.deepseekBalance")) usageCache = { data: null, at: 0 };
		if (e.affectsConfiguration("kimiCompanion.usageInStatusBar") || e.affectsConfiguration("kimiCompanion.deepseekBalance")) void refreshUsageStatus();
		if (e.affectsConfiguration("kimiCompanion.tabStatusMarkers")) {
			for (const p of getKimiPanels()) setPanelStatus(p, panelStatus.get(p) || null);
			reconcile(context, "statusMarkers");
		}
	}));

	void (async () => {
		const report = await ensureMoonshotPatched();
		if (activationDisposed) return;
		if (report && report.changed) {
			startupDone = true;
			return;
		}
		if (!hooksAvailable()) {
			startupDone = true;
			log.appendLine("[restore] hooks unavailable; saved state is preserved until a compatible reload");
			return;
		}
		await initializeRestore(context, entries, sidebarSession);
	})().catch((err) => {
		startupDone = true;
		restoreHadFailure = true;
		log.appendLine(`[activate] initialization FAILED: ${err}`);
	});
	void openChats.refresh();
}

async function deactivate() {
	activationDisposed = true;
	cancelPendingDelays();
	cancelPendingRequests();
	if (openChats) openChats.dispose();
	if (windowLease) await windowLease.dispose();
	if (log) log.appendLine(`[deactivate] ${new Date().toISOString()}`);
	delete globalThis.__kimiCompanionTurnSettled;
	delete globalThis.__kimiCompanionTurnStarted;
	delete globalThis.__kimiCompanionWaiting;
	delete globalThis.__kimiCompanionPromptSettled;
}

module.exports = {
	activate,
	deactivate,
	// Pure helpers exposed for test/*.test.js (not part of the extension API).
	_test: {
		parseDirectQuota,
		usageSlots,
		paceInfo,
		formatDuration,
		fractionSetting,
		money,
		plainText,
		quotaWindowLabel,
		recordClosed,
		reconcile,
		reopenClosed,
		openKimiTab,
		defaultWindowTitle,
		canPersistState,
		checkQuotaAlerts,
		doRefreshUsageStatus,
		setStateForTests(state) {
			if ("startupDone" in state) startupDone = state.startupDone;
			if ("activationDisposed" in state) activationDisposed = state.activationDisposed;
			if ("restoringWindows" in state) restoringWindows = state.restoringWindows;
			if ("restoringSidebar" in state) restoringSidebar = state.restoringSidebar;
			if ("restoreHadFailure" in state) restoreHadFailure = state.restoreHadFailure;
			if ("restoreEnabledForSession" in state) restoreEnabledForSession = state.restoreEnabledForSession;
			if ("windowLease" in state) windowLease = state.windowLease;
			if ("lastPersisted" in state) lastPersisted = state.lastPersisted;
			if ("statusItem" in state) statusItem = state.statusItem;
			if ("usageCache" in state) usageCache = state.usageCache;
			if ("appContext" in state) appContext = state.appContext;
			if ("log" in state) log = state.log;
		},
		stripStatusMarker,
		EXT_UNITS,
		WV_UNITS,
		WV_UNITS_084,
		wvUnitsFor
	}
};
