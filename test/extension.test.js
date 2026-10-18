// Offline tests for the pure helpers of extension.js: node --test test/
// The `vscode` module only exists inside the extension host, so a minimal stub is injected.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

const config = {};
const vscodeStub = {
	env: { language: "en" },
	workspace: { getConfiguration: () => ({ get: (key, def) => (key in config ? config[key] : def) }) },
	MarkdownString: class {},
	ThemeColor: class {}
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	return request === "vscode" ? vscodeStub : originalLoad.call(this, request, ...rest);
};
const { _test: x } = require(path.join(__dirname, "..", "extension.js"));
Module._load = originalLoad;

const HOUR = 3600000;

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

test("status markers are stripped, user titles that only look similar are kept", () => {
	assert.equal(x.stripStatusMarker("[~] Fix the bug"), "Fix the bug");
	assert.equal(x.stripStatusMarker("[?] Kimi Code"), "Kimi Code");
	assert.equal(x.stripStatusMarker("[x] note"), "[x] note");
});

test("patch units: each marker is unique and only its own unit can introduce it", () => {
	for (const units of [x.EXT_UNITS, x.WV_UNITS]) {
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
