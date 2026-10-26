"use strict";

const activeControllers = new Set();
let disposed = false;

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
	if (disposed) throw new Error("Companion is deactivated");
	const controller = new AbortController();
	activeControllers.add(controller);
	const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
	try {
		return await fetch(url, { ...options, signal: controller.signal });
	} finally {
		clearTimeout(timer);
		activeControllers.delete(controller);
	}
}

function cancelPendingRequests() {
	disposed = true;
	for (const controller of activeControllers) controller.abort(new Error("Companion deactivated"));
	activeControllers.clear();
}

function resetHttpForTests() {
	disposed = false;
}

module.exports = { fetchWithTimeout, cancelPendingRequests, resetHttpForTests };
