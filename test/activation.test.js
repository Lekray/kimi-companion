const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const sourceDist = path.join(os.homedir(), ".vscode", "extensions", "moonshot-ai.kimi-code-0.8.3-win32-x64", "dist");
const hasDist = ["extension.js", "webview.js"].every((name) =>
	fs.existsSync(path.join(sourceDist, `${name}.bak-kimi-companion`))
);

function memento(initial = {}) {
	const state = { ...initial };
	return {
		state,
		get: (key, fallback) => key in state ? state[key] : fallback,
		update: (key, value) => { state[key] = value; return Promise.resolve(); }
	};
}

test("activation preserves state across patch reload and restores a real panel flow", { timeout: 20000, skip: !hasDist }, async (t) => {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kimi-companion-activation-"));
	const extensionPath = path.join(root, "kimi");
	const dist = path.join(extensionPath, "dist");
	await fs.promises.mkdir(dist, { recursive: true });
	for (const name of ["extension.js", "webview.js"]) {
		await fs.promises.copyFile(path.join(sourceDist, `${name}.bak-kimi-companion`), path.join(dist, name));
	}
	const commands = new Map();
	const panels = [];
	const sessions = new Map();
	const config = { deepseekBalance: false, alerts: false };
	const noop = () => {};
	const disposable = () => ({ dispose: noop });
	const statusItem = () => ({ show: noop, hide: noop, dispose: noop });
	const vscode = {
		env: { language: "en", uiKind: 1 },
		workspace: {
			getConfiguration: () => ({ get: (key, fallback) => key in config ? config[key] : fallback }),
			registerTextDocumentContentProvider: disposable,
			onDidChangeConfiguration: disposable
		},
		window: {
			createOutputChannel: () => ({ appendLine: noop, dispose: noop }),
			createStatusBarItem: statusItem,
			createQuickPick: () => ({}),
			tabGroups: { onDidChangeTabs: disposable },
			showWarningMessage: () => Promise.resolve(undefined),
			showInformationMessage: () => Promise.resolve(undefined),
			showQuickPick: () => Promise.resolve(undefined),
			showTextDocument: () => Promise.resolve(undefined)
		},
		commands: {
			registerCommand: (name, handler) => { commands.set(name, handler); return disposable(); },
			executeCommand: async (name) => {
				if (name !== "kimi.openInTab") return undefined;
				const panel = {
					id: `w${panels.length + 1}`,
					title: globalThis.__kimiCompanionNextTitle || "Kimi Code",
					viewColumn: globalThis.__kimiCompanionNextColumn || 1,
					active: true,
					reveal: noop
				};
				panels.push(panel);
				globalThis.__kimiCompanionPanels = panels;
				return undefined;
			}
		},
		extensions: {
			getExtension: () => ({ extensionUri: { fsPath: extensionPath }, packageJSON: { version: "0.8.3" } })
		},
		MarkdownString: class { appendMarkdown() {} },
		ThemeColor: class {},
		EventEmitter: class {
			constructor() { this.event = disposable; }
			fire() {}
			dispose() {}
		},
		Uri: { parse: (value) => ({ toString: () => value }) },
		QuickPickItemKind: { Separator: -1 },
		StatusBarAlignment: { Right: 2 },
		ViewColumn: { Beside: -2 },
		UIKind: { Desktop: 1 }
	};
	const originalLoad = Module._load;
	Module._load = function (request, ...rest) {
		return request === "vscode" ? vscode : originalLoad.call(this, request, ...rest);
	};
	const extension = require("../extension.js");
	Module._load = originalLoad;
	const workspaceState = memento({
		kimiTabEntries: [{ title: "Restore me", sessionId: "session-1", column: 2, userNamed: true }]
	});
	const globalState = memento();
	const globalStorageUri = { fsPath: path.join(root, "storage") };
	const contexts = [];
	const activate = async () => {
		const context = {
			extension: { packageJSON: { version: "1.7.2" } },
			workspaceState,
			globalState,
			globalStorageUri,
			subscriptions: []
		};
		contexts.push(context);
		extension.activate(context);
	};
	const cleanup = async () => {
		await extension.deactivate();
		for (const context of contexts.splice(0)) for (const item of context.subscriptions.reverse()) {
			if (item && typeof item.dispose === "function") await item.dispose();
		}
		delete globalThis.__kimiCompanionGetUsage;
		delete globalThis.__kimiCompanionPanels;
		delete globalThis.__kimiCompanionGetWebviewId;
		delete globalThis.__kimiCompanionGetSessionId;
		delete globalThis.__kimiCompanionLoadSession;
		delete globalThis.__kimiCompanionGetSidebarId;
		await fs.promises.rm(root, { recursive: true, force: true });
	};
	t.after(cleanup);
	globalThis.__kimiCompanionGetUsage = () => Promise.resolve({ kind: "ok", windows: [], quota: { usages: {} } });

	await activate();
	let patchedSource = "";
	for (let attempt = 0; attempt < 50; attempt++) {
		patchedSource = await fs.promises.readFile(path.join(dist, "extension.js"), "utf8");
		if (patchedSource.includes("__kimiCompanionNextTitle")) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(workspaceState.state.kimiTabEntries.length, 1, "patch pending reload does not erase saved state");
	assert.ok(patchedSource.includes("__kimiCompanionNextTitle"));
	await cleanup();

	globalThis.__kimiCompanionGetUsage = () => Promise.resolve({ kind: "ok", windows: [], quota: { usages: {} } });
	globalThis.__kimiCompanionGetWebviewId = (panel) => panel.id;
	globalThis.__kimiCompanionGetSessionId = (wid) => sessions.get(wid) || null;
	globalThis.__kimiCompanionLoadSession = (wid, sessionId) => { sessions.set(wid, sessionId); };
	globalThis.__kimiCompanionGetSidebarId = () => null;
	await activate();
	await new Promise((resolve) => setTimeout(resolve, 3200));
	assert.equal(panels.length, 1);
	assert.equal(panels[0].title, "Restore me");
	assert.equal(panels[0].viewColumn, 2);
	assert.equal(sessions.get("w1"), "session-1");
	assert.equal(workspaceState.state.kimiTabEntries[0].userNamed, true);
});
