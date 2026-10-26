const test = require("node:test");
const assert = require("node:assert/strict");
const { usageFreshness, FiveHourSourceTracker } = require("../lib/usage-state");

const NOW = Date.parse("2026-10-18T12:00:00Z");

test("usageFreshness marks stale, expired-reset and future snapshots", () => {
	const slots = [{ resetAt: new Date(NOW + 60000).toISOString() }];
	assert.equal(usageFreshness({ updatedAt: NOW - 1000 }, slots, NOW), "fresh");
	assert.equal(usageFreshness({ updatedAt: NOW - 120001 }, slots, NOW), "stale");
	assert.equal(usageFreshness({ updatedAt: NOW + 1 }, slots, NOW), "stale");
	assert.equal(usageFreshness({ updatedAt: NOW }, [{ resetAt: new Date(NOW).toISOString() }], NOW), "refresh-needed");
	assert.equal(usageFreshness({ updatedAt: NOW }, [{ resetAt: "bad" }], NOW), "refresh-needed");
	assert.equal(usageFreshness(null, slots, NOW), "unavailable");
});

test("5h tracker yields to a moving wire value when official is frozen", () => {
	const tracker = new FiveHourSourceTracker();
	const response = (official, wire) => ({
		quota: { usages: { limit5h: { usedRatio: official } } },
		windows: [{ durationMinutes: 300, ratio: wire }]
	});
	assert.equal(tracker.track(response(0.3, 0.3)), true);
	assert.equal(tracker.track(response(0.3, 0.4)), false);
	assert.equal(tracker.track(response(0.35, 0.4)), true);
});

test("5h tracker keeps stale-zero fallback and handles a missing wire source", () => {
	const tracker = new FiveHourSourceTracker();
	assert.equal(tracker.track({ quota: { usages: { limit5h: { usedRatio: 0 } } }, windows: [{ durationMinutes: 300, ratio: 0.4 }] }), false);
	assert.equal(tracker.track({ quota: { usages: { limit5h: { usedRatio: 0.4 } } }, windows: [] }), true);
	assert.equal(tracker.track({ quota: { usages: {} }, windows: [{ durationMinutes: 300, ratio: 0.4 }] }), false);
});
