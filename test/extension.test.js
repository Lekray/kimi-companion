// Offline tests for the pure helpers of extension.js: node --test "test/**/*.test.js"
// The `vscode` module only exists inside the extension host, so a minimal stub is injected.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Session metadata is read from KIMI_CODE_HOME; point it at a scratch directory before loading.
const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-companion-home-"));
process.env.KIMI_CODE_HOME = kimiHome;

const config = {};
const vscodeStub = {
	env: { language: "en" },
	workspace: { getConfiguration: () => ({ get: (key, def) => (key in config ? config[key] : def) }) },
	window: { showWarningMessage: () => Promise.resolve(undefined) },
	commands: { executeCommand: () => Promise.resolve(undefined) },
	MarkdownString: class {},
	ThemeColor: class {}
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	return request === "vscode" ? vscodeStub : originalLoad.call(this, request, ...rest);
};
const { _test: x } = require(path.join(__dirname, "..", "extension.js"));
Module._load = originalLoad;

test.after(() => fs.rmSync(kimiHome, { recursive: true, force: true }));

const HOUR = 3600000;

// Runs `fn` with exactly the given workspace name/folders and puts the stub back afterwards.
function withWorkspace(state, fn) {
	const saved = { ...vscodeStub.workspace };
	try {
		delete vscodeStub.workspace.name;
		delete vscodeStub.workspace.workspaceFolders;
		Object.assign(vscodeStub.workspace, state);
		return fn();
	} finally {
		delete vscodeStub.workspace.name;
		delete vscodeStub.workspace.workspaceFolders;
		Object.assign(vscodeStub.workspace, saved);
	}
}

test("defaultWindowTitle takes the workspace name, trimmed and collapsed", () => {
	const title = withWorkspace({ name: "  My   Workspace  ", workspaceFolders: [{ name: "folder" }, { name: "other" }] }, () => x.defaultWindowTitle());
	assert.equal(title, "My Workspace");
});

test("defaultWindowTitle falls back to the name of the only workspace folder", () => {
	assert.equal(withWorkspace({ workspaceFolders: [{ name: "  Single   Folder " }] }, () => x.defaultWindowTitle()), "Single Folder");
	assert.equal(withWorkspace({ name: "   ", workspaceFolders: [{ name: "single-folder" }] }, () => x.defaultWindowTitle()), "single-folder");
});

test("defaultWindowTitle falls back to the stock title without a project name", () => {
	assert.equal(withWorkspace({}, () => x.defaultWindowTitle()), "Kimi Code");
	assert.equal(withWorkspace({ name: "   " }, () => x.defaultWindowTitle()), "Kimi Code");
	assert.equal(withWorkspace({ workspaceFolders: [] }, () => x.defaultWindowTitle()), "Kimi Code");
	assert.equal(withWorkspace({ workspaceFolders: [{ name: "  " }] }, () => x.defaultWindowTitle()), "Kimi Code");
	assert.equal(withWorkspace({ workspaceFolders: [{ name: "a" }, { name: "b" }] }, () => x.defaultWindowTitle()), "Kimi Code", "neither folder wins in a multi-root workspace");
});

test("parseDirectQuota reads official usages, wire windows and the booster wallet", () => {
	const res = x.parseDirectQuota({
		usages: {
			limit_5h: { used_ratio: 0.25, reset_time: "2026-10-18T15:00:00Z" },
			limit_month_total: { used_ratio: 0.5 },
			bogus: { used_ratio: 1 }
		},
		limits: [
			{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "200", used: "50", resetTime: "x" } },
			{ window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: 0, used: 1 } },
			{ window: {}, detail: { limit: "abc", used: 1 } }
		],
		boosterWallet: {
			balance: { amountLeft: 1500000000, amount: 2000000000 },
			monthlyChargeLimit: { priceInCents: 1000, currency: "rub" }
		}
	});
	assert.equal(res.kind, "ok");
	assert.deepEqual(Object.keys(res.quota.usages).sort(), ["limit5h", "monthTotal"]);
	assert.equal(res.windows.length, 1, "zero/invalid limits are skipped");
	assert.equal(res.windows[0].durationMinutes, 300);
	assert.equal(res.windows[0].short, "5h");
	assert.equal(res.windows[0].used, 50, "counters are numbers, not raw server strings");
	assert.equal(res.windows[0].ratio, 0.25);
	assert.equal(res.quota.extraUsage.balanceCents, 1500);
	assert.equal(res.quota.extraUsage.currency, "RUB");
});

test("server strings cannot inject markdown or command links", () => {
	const label = x.quotaWindowLabel("[x](command:workbench.action.quit)", "<img src=y>");
	assert.doesNotMatch(label, /[[\]()<>]/);
	const res = x.parseDirectQuota({ booster_wallet: { balance: { amountLeft: 1, amount: 1 }, topupLimit: { currency: "](evil)" } } });
	assert.equal(res.quota.extraUsage.currency, "USD");
	assert.equal(x.money(150, "](evil)"), "$1.50");
	assert.equal(x.money(150, "RUB"), "₽1.50");
	assert.equal(x.money(150, "EUR"), "EUR 1.50");
});

test("usageSlots: a moving official 5h field supersedes the wire counter", () => {
	const res = {
		windows: [{ label: "5-hour window", short: "5h", ratio: 0.4, used: 80, limit: 200, resetAt: null, durationMinutes: 300 }],
		quota: { usages: { limit5h: { usedRatio: 0.3 } } }
	};
	const ids = x.usageSlots(res).map((s) => s.id);
	assert.deepEqual(ids, ["limit5h"]);
});

test("usageSlots: a stale-zero official 5h field yields to the live wire counter", () => {
	const res = {
		windows: [{ label: "5-hour window", short: "5h", ratio: 0.4, used: 80, limit: 200, resetAt: null, durationMinutes: 300 }],
		quota: { usages: { limit5h: { usedRatio: 0 }, monthTotal: { usedRatio: 0.1 } } }
	};
	const slots = x.usageSlots(res);
	assert.deepEqual(slots.map((s) => s.id), ["win300", "monthTotal"]);
	assert.equal(slots[0].counter, "80/200");
});

test("paceInfo forecasts depletion inside the window and ignores out-of-window data", () => {
	const now = Date.parse("2026-10-18T12:00:00Z");
	const slot = { ratio: 0.8, durationMinutes: 300, resetAt: new Date(now + 3 * HOUR).toISOString() };
	const info = x.paceInfo(slot, now); // 2h elapsed, 80% used → 0.4/h → 0.5h left
	assert.ok(Math.abs(info.pace - 2) < 1e-9);
	assert.ok(Math.abs(info.depletesInMs - 0.5 * HOUR) < 1);
	assert.equal(x.paceInfo({ ...slot, resetAt: new Date(now - HOUR).toISOString() }, now), null);
	assert.equal(x.paceInfo({ ...slot, resetAt: "garbage" }, now), null);
	assert.equal(x.formatDuration(0.5 * HOUR), "30m");
	assert.equal(x.formatDuration(26 * HOUR), "1d 2h");
});

test("fractionSetting reads a typed percent as a fraction and rejects garbage", () => {
	const cfg = (v) => ({ get: () => v });
	assert.equal(x.fractionSetting(cfg(0.7), "k", 0.8), 0.7);
	assert.equal(x.fractionSetting(cfg(80), "k", 0.8), 0.8);
	assert.equal(x.fractionSetting(cfg(500), "k", 0.8), 1);
	assert.equal(x.fractionSetting(cfg("abc"), "k", 0.8), 0.8);
	assert.equal(x.fractionSetting(cfg(-1), "k", 0.8), 0.8);
});

function fakeContext(closed = []) {
	const state = { kimiClosedHistory: closed };
	return {
		state,
		workspaceState: {
			get: (k, d) => (k in state ? state[k] : d),
			update: (k, v) => {
				state[k] = v;
			}
		}
	};
}

test("recordClosed ignores title changes of a window that is still open", () => {
	const ctx = fakeContext();
	x.recordClosed(ctx, [{ title: "Kimi Code", sessionId: "s1", column: 1 }], [{ title: "Fix the bug", sessionId: "s1", column: 1 }]);
	assert.deepEqual(ctx.state.kimiClosedHistory, []);
});

test("recordClosed remembers a closed session once, newest last, capped at 5", () => {
	const old = [1, 2, 3, 4, 5].map((n) => ({ title: `t${n}`, sessionId: `s${n}`, column: 1 }));
	const ctx = fakeContext(old.slice());
	x.recordClosed(ctx, [{ title: "again", sessionId: "s2", column: 2 }, { title: "new", sessionId: "s9", column: 1 }], []);
	const ids = ctx.state.kimiClosedHistory.map((e) => e.sessionId);
	assert.deepEqual(ids, ["s3", "s4", "s5", "s2", "s9"]);
	assert.equal(ctx.state.kimiClosedHistory[3].title, "again");
});

test("recordClosed deduplicates repeated views of one closed session", () => {
	const ctx = fakeContext();
	x.recordClosed(ctx, [
		{ title: "first", sessionId: "same", column: 1 },
		{ title: "last", sessionId: "same", column: 2 }
	], []);
	assert.deepEqual(ctx.state.kimiClosedHistory, [{ title: "last", sessionId: "same", column: 2 }]);
});

test("a missing booster balance stays unknown instead of becoming zero", () => {
	const res = x.parseDirectQuota({ boosterWallet: { balance: { amount: 2000000000 } } });
	assert.equal(res.quota.extraUsage.balanceCents, null);
	assert.equal(res.quota.extraUsage.totalCents, 2000);
});

test("status markers are stripped, user titles that only look similar are kept", () => {
	assert.equal(x.stripStatusMarker("[~] Fix the bug"), "Fix the bug");
	assert.equal(x.stripStatusMarker("[?] Kimi Code"), "Kimi Code");
	assert.equal(x.stripStatusMarker("[x] note"), "[x] note");
});

test("patch units: each marker is unique and only its own unit can introduce it", () => {
	for (const units of [x.EXT_UNITS, x.WV_UNITS, x.WV_UNITS_084]) {
		const markers = units.map((u) => u.marker);
		assert.equal(new Set(markers).size, markers.length);
		units.forEach((u, i) => {
			assert.ok(u.repl.includes(u.marker), `${u.marker}: replacement carries its marker`);
			assert.ok(!u.old.includes(u.marker), `${u.marker}: anchor already contains the marker`);
			// An earlier unit whose text carried this marker would make this unit look applied.
			for (const earlier of units.slice(0, i)) {
				assert.ok(!earlier.repl.includes(u.marker), `${u.marker} leaks from ${earlier.marker}`);
			}
		});
	}
});

test("patch units apply cleanly, in order, to text holding each anchor once", () => {
	// The pristine dist holds every anchor that no earlier unit creates itself.
	const units = x.EXT_UNITS;
	let src = units
		.filter((u, i) => !units.slice(0, i).some((e) => e.repl.includes(u.old)))
		.map((u) => u.old)
		.join("\n");
	for (const u of x.EXT_UNITS) {
		assert.equal(src.split(u.old).length - 1, 1, `${u.marker}: anchor found exactly once`);
		src = src.replace(u.old, u.repl);
	}
	for (const u of x.EXT_UNITS) assert.ok(src.includes(u.marker), `${u.marker} applied`);
});

function installHooks(panels) {
	globalThis.__kimiCompanionPanels = panels;
	globalThis.__kimiCompanionGetWebviewId = (panel) => panel.webviewId;
	globalThis.__kimiCompanionGetSessionId = (wid) => panels.find((p) => p.webviewId === wid)?.sessionId || null;
	globalThis.__kimiCompanionLoadSession = () => {};
}

function clearHooks() {
	for (const key of ["__kimiCompanionPanels", "__kimiCompanionGetWebviewId", "__kimiCompanionGetSessionId", "__kimiCompanionLoadSession"]) delete globalThis[key];
}

test("reconcile preserves saved entries when restore is disabled or hooks are unavailable", () => {
	const saved = [{ title: "saved", sessionId: "s1", column: 1 }];
	const ctx = fakeContext();
	ctx.state.kimiTabEntries = saved;
	x.setStateForTests({ restoreEnabledForSession: false, startupDone: true, restoringWindows: false, restoringSidebar: false, restoreHadFailure: false, windowLease: { isOwner: true }, lastPersisted: JSON.stringify(saved), log: { appendLine() {} } });
	installHooks([]);
	x.reconcile(ctx, "test-disabled");
	assert.deepEqual(ctx.state.kimiTabEntries, saved);
	x.setStateForTests({ restoreEnabledForSession: true });
	clearHooks();
	x.reconcile(ctx, "test-no-hooks");
	assert.deepEqual(ctx.state.kimiTabEntries, saved);
	clearHooks();
});

test("reconcile persists a verified snapshot only for the lease owner", () => {
	const panel = { title: "custom", webviewId: "w1", sessionId: "s1", viewColumn: 1 };
	installHooks([panel]);
	const ctx = fakeContext();
	x.setStateForTests({ restoreEnabledForSession: true, startupDone: true, restoringWindows: false, restoringSidebar: false, restoreHadFailure: false, windowLease: { isOwner: true }, lastPersisted: "[]", log: { appendLine() {} } });
	x.reconcile(ctx, "test-owner");
	assert.equal(ctx.state.kimiTabEntries[0].sessionId, "s1");
	x.setStateForTests({ windowLease: { isOwner: false }, lastPersisted: "[]" });
	ctx.state.kimiTabEntries = [{ title: "other", sessionId: "other", column: 1 }];
	x.reconcile(ctx, "test-nonowner");
	assert.equal(ctx.state.kimiTabEntries[0].sessionId, "other");
	clearHooks();
});

test("auto-naming replaces the project default title but never a name of its own", () => {
	const sessionDir = path.join(kimiHome, "sessions", "auto-name-1");
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify({ title: "Fix the parser" }));
	fs.writeFileSync(path.join(kimiHome, "session_index.jsonl"), JSON.stringify({ sessionId: "auto-name-1", sessionDir: "sessions/auto-name-1" }) + "\n");

	const projectPanel = { title: "demo-project", webviewId: "w1", sessionId: "auto-name-1", viewColumn: 1 };
	const customPanel = { title: "My own name", webviewId: "w2", sessionId: "auto-name-1", viewColumn: 1 };
	installHooks([projectPanel, customPanel]);
	x.setStateForTests({ restoreEnabledForSession: false, startupDone: true, restoringWindows: false, restoringSidebar: false, restoreHadFailure: false, windowLease: { isOwner: true }, lastPersisted: "[]", log: { appendLine() {} } });
	withWorkspace({ name: "demo-project" }, () => x.reconcile(fakeContext(), "test-autoname"));
	assert.equal(projectPanel.title, "Fix the parser", "the project title is still the companion's own default");
	assert.equal(customPanel.title, "My own name", "a title that is not a default is left alone");
	clearHooks();
});

test("failed reopen keeps the closed-history entry", async () => {
	const entry = { title: "closed", sessionId: "s1", column: 1 };
	const ctx = fakeContext([entry]);
	installHooks([]);
	x.setStateForTests({ activationDisposed: false, restoreEnabledForSession: false, log: { appendLine() {} } });
	vscodeStub.commands.executeCommand = () => Promise.reject(new Error("not ready"));
	await x.reopenClosed(ctx);
	assert.deepEqual(ctx.state.kimiClosedHistory, [entry]);
	clearHooks();
});

test("concurrent open commands cannot mix titles and columns", async () => {
	const panels = [];
	installHooks(panels);
	x.setStateForTests({ activationDisposed: false, restoreEnabledForSession: false, log: { appendLine() {} } });
	vscodeStub.commands.executeCommand = async () => {
		const title = globalThis.__kimiCompanionNextTitle;
		const column = globalThis.__kimiCompanionNextColumn;
		await new Promise((resolve) => setTimeout(resolve, 2));
		panels.push({ title, viewColumn: column, webviewId: title, sessionId: title });
	};
	const ctx = fakeContext();
	const first = x.openKimiTab(ctx, "test", "one", 1);
	const second = x.openKimiTab(ctx, "test", "two", 2);
	const opened = await Promise.all([first, second]);
	assert.deepEqual(opened.map((p) => p.title), ["one", "two"]);
	assert.deepEqual(panels.map((p) => [p.title, p.viewColumn]), [["one", 1], ["two", 2]]);
	assert.equal(globalThis.__kimiCompanionNextTitle, undefined);
	clearHooks();
});

test("quota alerts still run when usage is hidden from the status bar", async () => {
	Object.assign(config, { usageInStatusBar: false, deepseekBalance: false, alerts: true });
	let warnings = 0;
	vscodeStub.window.showWarningMessage = () => {
		warnings++;
		return Promise.resolve(undefined);
	};
	const stored = {};
	globalThis.__kimiCompanionGetUsage = () => Promise.resolve({ kind: "ok", windows: [], quota: { usages: { monthTotal: { usedRatio: 0.95 } } } });
	x.setStateForTests({
		activationDisposed: false,
		statusItem: {},
		usageCache: { data: null, at: 0 },
		appContext: { globalState: { get: (_key, fallback) => fallback, update: (key, value) => { stored[key] = value; } } },
		log: { appendLine() {} }
	});
	try {
		await x.doRefreshUsageStatus();
		assert.equal(warnings, 1);
		assert.ok(stored.kimiQuotaAlertLatch.month);
	} finally {
		delete globalThis.__kimiCompanionGetUsage;
		for (const key of ["usageInStatusBar", "deepseekBalance", "alerts"]) delete config[key];
	}
});

test("quota alerts re-arm without resetAt after usage falls below the threshold", async () => {
	Object.assign(config, { alerts: true, alertThresholdMonth: 0.9 });
	let warnings = 0;
	vscodeStub.window.showWarningMessage = () => {
		warnings++;
		return Promise.resolve(undefined);
	};
	const latch = {};
	x.setStateForTests({
		appContext: { globalState: { get: () => latch, update: () => {} } },
		log: { appendLine() {} }
	});
	const response = (ratio) => ({ kind: "ok", windows: [], quota: { usages: { monthTotal: { usedRatio: ratio } } } });
	try {
		await x.checkQuotaAlerts(response(0.95));
		await x.checkQuotaAlerts(response(0.95));
		await x.checkQuotaAlerts(response(0.5));
		await x.checkQuotaAlerts(response(0.96));
		assert.equal(warnings, 2);
	} finally {
		for (const key of ["alerts", "alertThresholdMonth"]) delete config[key];
	}
});
