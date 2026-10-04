const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
	}
];
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

let log;
let lastPersisted = "[]";
let lastSidebarSession = null;
let startupDone = false;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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

function quotaUrlCandidates() {
	const urls = [];
	const push = (u) => {
		if (u && !urls.includes(u)) urls.push(u);
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

function quotaWindowLabel(duration, timeUnit) {
	const n = Number(duration) || 0;
	const minutes =
		timeUnit === "TIME_UNIT_MINUTE" ? n :
		timeUnit === "TIME_UNIT_HOUR" ? n * 60 :
		timeUnit === "TIME_UNIT_DAY" ? n * 1440 : 0;
	if (minutes === 0) return `${duration} ${timeUnit || "window"}`;
	if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
	if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
	return `${minutes}-minute window`;
}

const USAGE_KEY_MAP = {
	limit_5h: "limit5h",
	limit_7d: "limit7d",
	limit_month_total: "monthTotal",
	limit_month_code: "monthCode"
};

function parseDirectQuota(d) {
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
			used: detail.used,
			limit: detail.limit,
			resetAt: detail.resetTime || null,
			durationMinutes
		});
	}
	const usages = {};
	const wire = d.usages || {};
	for (const key of Object.keys(USAGE_KEY_MAP)) {
		const u = wire[key];
		if (u && typeof u.used_ratio === "number") {
			usages[USAGE_KEY_MAP[key]] = { usedRatio: u.used_ratio, resetAt: u.reset_time || undefined };
		}
	}
	let extraUsage = null;
	const bw = d.booster_wallet;
	if (bw && bw.balance) {
		const cents8 = (v) => Math.round((Number(v) || 0) / 1e6);
		const monthlyLimitCents = bw.monthlyChargeLimit ? Number(bw.monthlyChargeLimit.priceInCents) || 0 : 0;
		extraUsage = {
			balanceCents: cents8(bw.balance.amountLeft),
			totalCents: cents8(bw.balance.amount),
			monthlyChargeLimitEnabled: monthlyLimitCents > 0,
			monthlyChargeLimitCents: monthlyLimitCents,
			monthlyUsedCents: bw.monthlyUsed ? Number(bw.monthlyUsed.priceInCents) || 0 : 0,
			currency:
				(bw.monthlyChargeLimit && bw.monthlyChargeLimit.currency) ||
				(bw.topupLimit && bw.topupLimit.currency) ||
				"USD"
		};
	}
	return { kind: "ok", source: "direct", windows, quota: { usages, extraUsage } };
}

async function fetchKimiQuotaDirect() {
	const file = kimiCredentialsFile();
	if (!file) return null;
	let tok;
	try {
		tok = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
	if (!tok || !tok.access_token) return null;
	if (typeof tok.expires_at === "number" && tok.expires_at - Date.now() / 1000 < 60) {
		// Let the Kimi extension refresh the token; the next poll reads the fresh file.
		return null;
	}
	const urls = workingQuotaUrl
		? [workingQuotaUrl, ...quotaUrlCandidates().filter((u) => u !== workingQuotaUrl)]
		: quotaUrlCandidates();
	for (const url of urls) {
		try {
			const resp = await fetch(url, {
				headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" }
			});
			if (!resp.ok) {
				log.appendLine(`[usage] ${url} -> HTTP ${resp.status}`);
				continue;
			}
			workingQuotaUrl = url;
			return parseDirectQuota(await resp.json());
		} catch (err) {
			log.appendLine(`[usage] ${url} -> ${err}`);
		}
	}
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
	const key = deepseekApiKey();
	if (!key) return null;
	const resp = await fetch(DEEPSEEK_BALANCE_URL, {
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }
	});
	if (!resp.ok) return null;
	const d = await resp.json();
	const b = d && Array.isArray(d.balance_infos) ? d.balance_infos[0] : null;
	if (!b) return null;
	return {
		available: d.is_available !== false,
		currency: b.currency || "USD",
		total: Number(b.total_balance) || 0,
		granted: Number(b.granted_balance) || 0,
		toppedUp: Number(b.topped_up_balance) || 0
	};
}

async function getUsage(force) {
	if (!force && usageCache.data && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.data;
	let res = null;
	try {
		res = await fetchKimiQuotaDirect();
	} catch (err) {
		log.appendLine(`[usage] direct quota fetch failed: ${err}`);
	}
	if (!res) {
		const fn = globalThis.__kimiCompanionGetUsage;
		if (typeof fn === "function") {
			try {
				res = await fn(USAGE_PROVIDER);
			} catch (err) {
				log.appendLine(`[usage] hook threw: ${err}`);
				res = null;
			}
		}
	}
	if (res && res.kind === "ok") {
		try {
			res.deepseek = await fetchDeepseekBalance();
		} catch (err) {
			log.appendLine(`[usage] deepseek balance failed: ${err}`);
			res.deepseek = null;
		}
		usageCache = { data: res, at: Date.now() };
	}
	return res;
}

function usageSlots(res) {
	const slots = [];
	const windows = res && Array.isArray(res.windows) ? res.windows : [];
	for (const w of windows) {
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
	const has5hWindow = windows.some((w) => w.durationMinutes === 300);
	const usages = res && res.quota && res.quota.usages ? res.quota.usages : {};
	for (const def of LIMITS) {
		if (def.key === "limit5h" && has5hWindow) continue; // live 5h counter supersedes the stale backend field
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
	return { text: parts.join(" · "), hot: info.depletesInMs != null && slot.durationMinutes <= 1440 };
}

async function checkQuotaAlerts(res) {
	if (!appContext) return;
	const cfg = vscode.workspace.getConfiguration("kimiCompanion");
	if (cfg.get("alerts", true) === false) return;
	const t5h = Number(cfg.get("alertThreshold5h", 0.8));
	const tMonth = Number(cfg.get("alertThresholdMonth", 0.9));
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
		if ((s.id === "win300" || s.id === "limit5h") && s.ratio >= t5h) {
			const eta = pi && pi.depletesInMs != null ? ` — depletes in ~${formatDuration(pi.depletesInMs)}` : "";
			const left = pi ? `, resets in ${formatDuration(pi.resetInMs)}` : "";
			fire("5h", s.resetAt || "?", `Kimi quota: 5-hour window is ${Math.round(s.ratio * 100)}% used${eta}${left}.`);
		}
		if (s.id === "monthTotal" && s.ratio >= tMonth) {
			fire("month", s.resetAt || "?", `Kimi quota: monthly limit is ${Math.round(s.ratio * 100)}% used (resets ${resetStamp(s.resetAt, true) || "?"}).`);
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
	const sym = !currency || currency === "USD" ? "$" : currency === "RUB" ? "₽" : `${currency} `;
	return `${sym}${value.toFixed(2)}`;
}

function extraUsageLines(res) {
	const extra = res && res.quota ? res.quota.extraUsage : null;
	if (!extra) return [];
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
	const lines = ["Kimi Code subscription usage (api.kimi.com)", `Updated: ${localStamp(new Date())}`, ""];
	const slots = usageSlots(res);
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
	return lines.join("\n") + "\n";
}

async function refreshUsageStatus() {
	const item = statusItem;
	if (!item) return;
	item.backgroundColor = undefined;
	const enabled =
		vscode.workspace.getConfiguration("kimiCompanion").get("usageInStatusBar", true) !== false;
	if (!enabled) {
		item.text = STATUS_TEXT;
		item.tooltip = "Kimi Code";
		return;
	}
	try {
		const res = await getUsage(false);
		if (!res || res.kind !== "ok") {
			item.text = STATUS_TEXT;
			item.tooltip = "Kimi Code";
			return;
		}
		const slots = usageSlots(res);
		const monthSlot = slots.find((s) => s.id === "monthTotal");
		const h5Slot = slots.find((s) => s.id === "win300" || s.id === "limit5h");
		const parts = [];
		if (monthSlot) parts.push(`M ${Math.round(monthSlot.ratio * 100)}%`);
		if (h5Slot) parts.push(`5h ${Math.round(h5Slot.ratio * 100)}%`);
		item.text = parts.length > 0 ? `$(kimi-companion-k) ${parts.join(" · ")}` : STATUS_TEXT;
		const now = Date.now();
		let hot = false;
		const tip = ["Kimi Code"];
		for (const s of slots) {
			const reset = resetStamp(s.resetAt, false);
			const counter = s.counter ? ` (${s.counter})` : "";
			const ps = paceSummary(s, now);
			tip.push(
				`${s.short}: ${Math.round(s.ratio * 100)}%${counter}${reset ? ` (reset ${reset})` : ""}${ps ? ` — ${ps.text}` : ""}`
			);
			if (ps && ps.hot) hot = true;
		}
		if (res.deepseek) {
			tip.push(`deepseek: ${money(res.deepseek.total * 100, res.deepseek.currency)}`);
		}
		item.tooltip = tip.join("\n");
		item.backgroundColor = hot ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
		void checkQuotaAlerts(res);
	} catch (err) {
		log.appendLine(`[usage] status refresh failed: ${err}`);
		item.text = STATUS_TEXT;
		item.tooltip = "Kimi Code";
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

function unitStatus(file, unit) {
	try {
		return fs.readFileSync(file, "utf8").includes(unit.marker)
			? `OK      ${unit.marker}`
			: `MISSING ${unit.marker}`;
	} catch {
		return `MISSING ${unit.marker} (cannot read ${path.basename(file)})`;
	}
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
		for (const unit of EXT_UNITS) lines.push(`  ${unitStatus(path.join(dir, "extension.js"), unit)}`);
		for (const unit of WV_UNITS) lines.push(`  ${unitStatus(path.join(dir, "webview.js"), unit)}`);
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
		usageReport: "Usage report", refreshQuota: "Refresh quota", newWindow: "New window",
		reopenClosed: "Reopen closed window", openWindows: "Open windows",
		noQuota: "Quota unavailable — open a Kimi window or sign in"
	},
	ru: {
		monthly: "Месячный лимит", monthCode: "Месячный (code)", sevenDay: "7-дневный лимит", fiveHour: "5-часовое окно",
		booster: "Бустер-кошелёк", deepseek: "Баланс DeepSeek", used: "использовано", monthlyUsed: "за месяц использовано",
		leftFmt: (l, t) => `осталось ${l} из ${t}`,
		available: "доступен", unavailable: "недоступен — нужно пополнить",
		usageReport: "Отчёт по лимитам", refreshQuota: "Обновить лимиты", newWindow: "Новое окно",
		reopenClosed: "Вернуть закрытое окно", openWindows: "Открытые окна",
		noQuota: "Квота недоступна — откройте окно Kimi или войдите"
	},
	zh: {
		monthly: "月度限额", monthCode: "月度限额 (code)", sevenDay: "7 天限额", fiveHour: "5 小时窗口",
		booster: "Booster 钱包", deepseek: "DeepSeek 余额", used: "已用", monthlyUsed: "本月已用",
		leftFmt: (l, t) => `剩余 ${l}，共 ${t}`,
		available: "可用", unavailable: "不可用——请充值",
		usageReport: "用量报告", refreshQuota: "刷新用量", newWindow: "新建窗口",
		reopenClosed: "重新打开已关闭的窗口", openWindows: "已打开的窗口",
		noQuota: "配额不可用——请打开 Kimi 窗口或登录"
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
	const res = await getUsage(false);
	const items = [];
	if (res && res.kind === "ok") {
		const order = (s) =>
			s.id === "monthTotal" ? 0 :
			s.id === "win300" || s.id === "limit5h" ? 1 :
			s.id === "limit7d" ? 2 : 3;
		const sorted = usageSlots(res).slice().sort((a, b) => order(a) - order(b));
		for (const s of sorted) {
			const ps = paceSummary(s, Date.now());
			const counter = s.counter ? ` · ${s.counter}` : "";
			items.push({
				label: `$(pulse) ${slotTitle(s)}`,
				description: `${Math.round(s.ratio * 100)}%`,
				detail: `[${usageBar(s.ratio)}]  ${Math.round(s.ratio * 100)}% ${T.used}${counter}${ps ? ` · ${ps.text}` : ""}`,
				action: "usage"
			});
		}
		const extra = res.quota && res.quota.extraUsage ? res.quota.extraUsage : null;
		if (extra) {
			items.push({
				label: `$(pulse) ${T.booster}`,
				description: money(extra.balanceCents, extra.currency),
				detail: `${T.leftFmt(money(extra.balanceCents, extra.currency), money(extra.totalCents, extra.currency))} · ${T.monthlyUsed} ${money(extra.monthlyUsedCents, extra.currency)}`,
				action: "usage"
			});
		}
		const ds = res.deepseek;
		if (ds) {
			items.push({
				label: `$(pulse) ${T.deepseek}`,
				description: money(ds.total * 100, ds.currency),
				detail: ds.available ? T.available : T.unavailable,
				action: "usage"
			});
		}
		items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
	} else {
		items.push({ label: `$(warning) ${T.noQuota}`, action: "usage" });
	}
	items.push({ label: `$(graph) ${T.usageReport}`, action: "usage" });
	items.push({ label: `$(refresh) ${T.refreshQuota}`, action: "refresh" });
	items.push({ label: `$(add) ${T.newWindow}`, action: "open" });
	items.push({ label: `$(history) ${T.reopenClosed}`, action: "reopen" });
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
		usageCache = { data: null, at: 0 };
		await refreshUsageStatus();
		await showMenu();
		return;
	}
	const command = {
		usage: "kimiCompanion.usage",
		open: "kimiCompanion.open",
		reopen: "kimiCompanion.reopenClosed"
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

// --- Tracking state -------------------------------------------------

function currentEntries() {
	const { getWebviewId, getSessionId } = getHooks();
	return getKimiPanels().map((p) => {
		let sessionId = null;
		const wid = getWebviewId ? safe(() => getWebviewId(p)) : undefined;
		if (wid && getSessionId) sessionId = safe(() => getSessionId(wid)) || null;
		return { title: p.title, sessionId, column: safe(() => p.viewColumn) || null };
	});
}

function recordClosed(context, prev, now) {
	const nowKeys = new Set(now.map((e) => `${e.title}${e.sessionId}`));
	const gone = prev.filter((e) => e.sessionId && !nowKeys.has(`${e.title}${e.sessionId}`));
	if (gone.length === 0) return;
	const hist = context.workspaceState.get(CLOSED_KEY, []);
	hist.push(...gone);
	while (hist.length > CLOSED_MAX) hist.shift();
	context.workspaceState.update(CLOSED_KEY, hist);
	log.appendLine(`[closed] remembered: ${JSON.stringify(gone)}`);
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

function deriveSessionName(sessionId) {
	const dir = sessionDirOf(sessionId);
	if (!dir) return null;
	const statePath = path.isAbsolute(dir) ? path.join(dir, "state.json") : path.join(kimiHome, dir, "state.json");
	const state = safe(() => JSON.parse(fs.readFileSync(statePath, "utf8")));
	if (!state) return null;
	const name = String(state.title || state.lastPrompt || "").replace(/\s+/g, " ").trim();
	if (!name) return null;
	return name.length > 42 ? name.slice(0, 41) + "…" : name;
}

function autoNamePanels() {
	const { getWebviewId, getSessionId } = getHooks();
	if (!getWebviewId || !getSessionId) return;
	for (const p of getKimiPanels()) {
		if (p.title !== DEFAULT_TITLE) continue;
		const wid = safe(() => getWebviewId(p));
		const sid = wid ? safe(() => getSessionId(wid)) : null;
		if (!sid) continue;
		const name = deriveSessionName(sid);
		if (name) {
			try {
				p.title = name;
				log.appendLine(`[autoname] "${name}"`);
			} catch {
				// panel gone
			}
		}
	}
}

function persistSidebarSession(context) {
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
	const entries = currentEntries();
	const json = JSON.stringify(entries);
	if (json !== lastPersisted) {
		if (startupDone) recordClosed(context, JSON.parse(lastPersisted), entries);
		lastPersisted = json;
		context.workspaceState.update(ENTRIES_KEY, entries);
		log.appendLine(`[sync:${reason}] tracked: ${json}`);
	}
	persistSidebarSession(context);
	autoNamePanels();
}

// --- Patching the Kimi extension ------------------------------------

function patchDistFile(file, units, failures) {
	let src;
	try {
		src = fs.readFileSync(file, "utf8");
	} catch (err) {
		log.appendLine(`[patch] cannot read ${file}: ${err}`);
		return false;
	}
	let changed = false;
	for (const unit of units) {
		if (src.includes(unit.marker)) continue;
		if (src.split(unit.old).length - 1 !== 1) {
			log.appendLine(`[patch] anchor for ${unit.marker} not found exactly once in ${path.basename(file)}`);
			failures.push(unit.marker);
			continue;
		}
		src = src.replace(unit.old, unit.repl);
		changed = true;
		log.appendLine(`[patch] applied ${unit.marker} to ${path.basename(file)}`);
	}
	if (changed) {
		try {
			const bak = file + ".bak-kimi-companion";
			if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
			fs.writeFileSync(file, src, "utf8");
		} catch (err) {
			log.appendLine(`[patch] write failed for ${file}: ${err}`);
			return false;
		}
	}
	return changed;
}

function ensureMoonshotPatched() {
	const ext = vscode.extensions.getExtension(KIMI_EXT_ID);
	if (!ext) {
		log.appendLine("[patch] moonshot-ai.kimi-code not installed");
		return;
	}
	const distDir = path.join(ext.extensionUri.fsPath, "dist");
	const failures = [];
	const applied =
		patchDistFile(path.join(distDir, "extension.js"), EXT_UNITS, failures) |
		patchDistFile(path.join(distDir, "webview.js"), WV_UNITS, failures);
	if (failures.length > 0) {
		vscode.window.showWarningMessage(
			`Kimi Code Companion: the installed Kimi version changed its code (anchors: ${failures.join(", ")}). Manual repatch is required — see the extension README.`
		);
	}
	if (applied) {
		vscode.window
			.showInformationMessage(
				"Kimi Code Companion: the Kimi extension was patched — a window reload is required.",
				"Reload Window"
			)
			.then((choice) => {
				if (choice) vscode.commands.executeCommand("workbench.action.reloadWindow");
			});
	} else if (failures.length === 0) {
		log.appendLine("[patch] all patches present");
	}
}

// --- Opening / restoring ---------------------------------------------

function openKimiTab(context, reason, title, column) {
	log.appendLine(`[open:${reason}] kimi.openInTab${title ? ` title="${title}"` : ""}${column ? ` column=${column}` : ""}`);
	if (title) globalThis.__kimiCompanionNextTitle = title;
	if (column) globalThis.__kimiCompanionNextColumn = column;
	const before = getKimiPanels().length;
	return vscode.commands.executeCommand("kimi.openInTab").then(
		() => {
			delete globalThis.__kimiCompanionNextTitle;
			delete globalThis.__kimiCompanionNextColumn;
			const panels = getKimiPanels();
			const panel = panels.length > before ? panels[panels.length - 1] : undefined;
			log.appendLine(`[open:${reason}] OK, captured=${panel !== undefined}, tracked=${panels.length}`);
			reconcile(context, `open:${reason}`);
			return panel;
		},
		(err) => {
			delete globalThis.__kimiCompanionNextTitle;
			delete globalThis.__kimiCompanionNextColumn;
			const msg = err && err.message ? err.message : String(err);
			log.appendLine(`[open:${reason}] FAILED: ${msg}`);
			vscode.window.showWarningMessage(`Kimi Code Companion: failed to open a Kimi window — ${msg}`);
			return undefined;
		}
	);
}

async function ensureSessionLoadedById(wid, sessionId, label) {
	const { getSessionId, loadSession } = getHooks();
	if (!getSessionId || !loadSession) {
		log.appendLine("[restore] session hooks unavailable — history not restored");
		return;
	}
	for (let attempt = 1; attempt <= 5; attempt++) {
		await delay(1200);
		const current = safe(() => getSessionId(wid)) || null;
		if (current === sessionId) {
			log.appendLine(`[restore] history attached in ${label}: ${sessionId}`);
			return;
		}
		if (current) {
			log.appendLine(`[restore] ${label} already has another session (${current}), leaving it`);
			return;
		}
		log.appendLine(`[restore] loading ${sessionId} into ${label} (attempt ${attempt})`);
		try {
			loadSession(wid, sessionId);
		} catch (err) {
			log.appendLine(`[restore] loadSession error: ${err}`);
		}
	}
	log.appendLine(`[restore] gave up on ${sessionId}`);
}

async function ensureSessionLoaded(panel, sessionId) {
	const { getWebviewId } = getHooks();
	const wid = getWebviewId ? safe(() => getWebviewId(panel)) : undefined;
	if (!wid) {
		log.appendLine("[restore] no webviewId for panel");
		return;
	}
	await ensureSessionLoadedById(wid, sessionId, wid);
}

async function restoreWindows(context, entries) {
	await delay(1500);
	try {
		if (getKimiPanels().length > 0) {
			log.appendLine("[restore] windows already present, skipping");
			return;
		}
		const jobs = [];
		for (const entry of entries) {
			const panel = await openKimiTab(context, "restore", entry.title, entry.column);
			if (panel && entry.sessionId) {
				jobs.push(ensureSessionLoaded(panel, entry.sessionId));
			}
		}
		await Promise.all(jobs);
		reconcile(context, "restore");
	} finally {
		startupDone = true;
	}
}

async function restoreSidebarSession(context, sessionId) {
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline) {
		const { getSidebarId } = getHooks();
		const wid = getSidebarId ? safe(() => getSidebarId()) : undefined;
		if (wid) {
			await ensureSessionLoadedById(wid, sessionId, "sidebar");
			return;
		}
		await delay(POLL_MS);
	}
	log.appendLine("[restore] sidebar webview did not appear — history not restored");
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
	let panel = panels[0];
	if (panels.length > 1) {
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
		value: panel.title,
		ignoreFocusOut: true
	});
	if (!name || !name.trim()) return;
	try {
		panel.title = name.trim();
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
	context.workspaceState.update(CLOSED_KEY, hist.slice(0, -1));
	log.appendLine(`[reopen] ${JSON.stringify(entry)}`);
	const panel = await openKimiTab(context, "reopen", entry.title, entry.column);
	if (panel && entry.sessionId) {
		void ensureSessionLoaded(panel, entry.sessionId);
	}
}

// --- Activation ---------------------------------------------------------

function activate(context) {
	appContext = context;
	log = vscode.window.createOutputChannel("Kimi Code Companion");
	context.subscriptions.push(log);
	log.appendLine(`[activate] ${new Date().toISOString()}`);

	ensureMoonshotPatched();

	const restoreEnabled = vscode.workspace
		.getConfiguration("kimiCompanion")
		.get("restoreTabOnStartup", true);
	let entries = context.workspaceState.get(ENTRIES_KEY, null);
	if (!Array.isArray(entries)) {
		const legacy = context.workspaceState.get(LEGACY_NAMES_KEY, []);
		entries = legacy.map((t) => ({ title: t, sessionId: null, column: null }));
	}
	lastPersisted = JSON.stringify(entries);
	const sidebarSession = context.workspaceState.get(SIDEBAR_KEY, null);
	log.appendLine(
		`[activate] restoreEnabled=${restoreEnabled} saved=${JSON.stringify(entries)} sidebar=${sidebarSession}`
	);

	if (restoreEnabled && entries.length > 0) {
		void restoreWindows(context, entries);
	} else {
		startupDone = true;
	}
	if (restoreEnabled && sidebarSession) {
		lastSidebarSession = sidebarSession;
		void restoreSidebarSession(context, sidebarSession);
	}

	reportProvider = new ReportProvider();
	context.subscriptions.push(
		reportProvider,
		vscode.workspace.registerTextDocumentContentProvider("kimi-companion", reportProvider)
	);

	context.subscriptions.push(
		vscode.window.tabGroups.onDidChangeTabs(() => reconcile(context, "tabsChanged")),
		vscode.commands.registerCommand("kimiCompanion.open", () => {
			void openKimiTab(context, "command");
		}),
		vscode.commands.registerCommand("kimiCompanion.rename", () => {
			void renameWindow(context);
		}),
		vscode.commands.registerCommand("kimiCompanion.reopenClosed", () => {
			void reopenClosed(context);
		}),
		vscode.commands.registerCommand("kimiCompanion.usage", () => {
			void showUsage();
		}),
		vscode.commands.registerCommand("kimiCompanion.diagnostics", () => {
			void showDiagnostics(context);
		}),
		vscode.commands.registerCommand("kimiCompanion.menu", () => {
			void showMenu();
		})
	);

	const pollTimer = setInterval(() => reconcile(context, "poll"), POLL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
	item.text = STATUS_TEXT;
	item.tooltip = "Kimi Code";
	item.command = "kimiCompanion.menu";
	statusItem = item;
	context.subscriptions.push(item);

	const usageTimer = setInterval(() => {
		void refreshUsageStatus();
	}, USAGE_REFRESH_MS);
	context.subscriptions.push({ dispose: () => clearInterval(usageTimer) });
	void refreshUsageStatus();

	const updateButton = () => {
		const enabled = vscode.workspace
			.getConfiguration("kimiCompanion")
			.get("statusBarButton", true);
		if (enabled) {
			item.show();
		} else {
			item.hide();
		}
	};
	updateButton();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("kimiCompanion.statusBarButton")) {
				updateButton();
			}
			if (e.affectsConfiguration("kimiCompanion.usageInStatusBar")) {
				void refreshUsageStatus();
			}
		})
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
