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
const USAGE_CACHE_MS = 60000;
const USAGE_REFRESH_MS = 5 * 60 * 1000;
const USAGE_URI = "kimi-companion://report/Kimi Code Usage.txt";
const DIAG_URI = "kimi-companion://report/Diagnostics.txt";
const STATUS_TEXT = "$(kimi-companion-k) Kimi Code";
const BAR_WIDTH = 16;
const LIMITS = [
	{ key: "limit5h", label: "5-hour limit", short: "5h" },
	{ key: "limit7d", label: "7-day limit", short: "7d" },
	{ key: "monthTotal", label: "Monthly total", short: "month" },
	{ key: "monthCode", label: "Monthly (code)", short: "month code" }
];

let statusItem = null;
let reportProvider = null;
let usageCache = { data: null, at: 0 };

async function getUsage(force) {
	const fn = globalThis.__kimiCompanionGetUsage;
	if (typeof fn !== "function") return null;
	if (!force && usageCache.data && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.data;
	let res;
	try {
		res = await fn(USAGE_PROVIDER);
	} catch (err) {
		log.appendLine(`[usage] hook threw: ${err}`);
		return null;
	}
	if (res && res.kind === "ok") usageCache = { data: res, at: Date.now() };
	return res;
}

function usageSlots(res) {
	const usages = res && res.quota && res.quota.usages ? res.quota.usages : {};
	const slots = [];
	for (const def of LIMITS) {
		const u = usages[def.key];
		if (!u || typeof u.usedRatio !== "number") continue;
		slots.push({ label: def.label, short: def.short, ratio: u.usedRatio, resetAt: u.resetAt || null });
	}
	return slots;
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
		lines.push(
			`${s.label.padEnd(15)}[${usageBar(s.ratio)}]  ${Math.round(s.ratio * 100)}%` +
				(reset ? `   resets ${reset}` : "")
		);
	}
	const extra = extraUsageLines(res);
	if (extra.length > 0) lines.push("", ...extra);
	return lines.join("\n") + "\n";
}

function usageErrorReport(res) {
	const lines = ["Kimi Code subscription usage (api.kimi.com)", `Updated: ${localStamp(new Date())}`, ""];
	if (!res) {
		lines.push("Usage is unavailable: the hook __kimiCompanionGetUsage is not present.");
		lines.push("The Kimi extension has not been activated or patched yet — reload the window and open a Kimi window.");
	} else {
		const msg = res.error || res.message || res.reason;
		lines.push(`Usage request failed: ${typeof msg === "string" ? msg : JSON.stringify(res)}`);
	}
	return lines.join("\n") + "\n";
}

async function refreshUsageStatus() {
	const item = statusItem;
	if (!item) return;
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
		const maxRatio = slots.reduce((max, s) => Math.max(max, s.ratio), 0);
		item.text = `$(kimi-companion-k) ${Math.round(100 * maxRatio)}%`;
		const tip = ["Kimi Code"];
		for (const s of slots) {
			const reset = resetStamp(s.resetAt, false);
			tip.push(`${s.short}: ${Math.round(s.ratio * 100)}%${reset ? ` (reset ${reset})` : ""}`);
		}
		item.tooltip = tip.join("\n");
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

// --- Menu -------------------------------------------------------------

async function showMenu() {
	const items = [];
	if (typeof globalThis.__kimiCompanionGetUsage === "function") {
		items.push({ label: "$(graph) Usage…", action: "usage" });
	}
	items.push({ label: "$(add) New window", action: "open" });
	items.push({ label: "$(history) Reopen closed window", action: "reopen" });
	const panels = getKimiPanels();
	if (panels.length > 0) items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
	panels.forEach((p, i) => items.push({ label: p.title, description: `#${i + 1}`, panel: p }));
	const picked = await vscode.window.showQuickPick(items, { placeHolder: "Kimi Code" });
	if (!picked) return;
	if (picked.panel) {
		safe(() => picked.panel.reveal());
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
