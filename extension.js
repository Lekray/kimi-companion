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
		})
	);

	const pollTimer = setInterval(() => reconcile(context, "poll"), POLL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
	item.text = "$(kimi-companion-k) Kimi Code";
	item.tooltip = "Kimi Code: Open";
	item.command = "kimiCompanion.open";
	context.subscriptions.push(item);

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
		})
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
