const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchWithTimeout, cancelPendingRequests, resetHttpForTests } = require("../lib/http");

test.afterEach(() => {
	cancelPendingRequests();
	resetHttpForTests();
});

test("fetchWithTimeout aborts a stalled request", async () => {
	const original = global.fetch;
	global.fetch = (_url, options) => new Promise((_, reject) => {
		options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
	});
	try {
		await assert.rejects(fetchWithTimeout("https://example.test", {}, 5), /timed out/);
	} finally {
		global.fetch = original;
	}
});

test("cancelPendingRequests aborts active work and rejects later work", async () => {
	const original = global.fetch;
	global.fetch = (_url, options) => new Promise((_, reject) => {
		options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
	});
	try {
		const pending = fetchWithTimeout("https://example.test", {}, 60000);
		cancelPendingRequests();
		await assert.rejects(pending, /deactivated/);
		await assert.rejects(fetchWithTimeout("https://example.test"), /deactivated/);
	} finally {
		global.fetch = original;
	}
});
