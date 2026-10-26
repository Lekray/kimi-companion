// Offline tests for lib/open-chats.js: node --test test/open-chats.test.js
// VS Code is simulated with small stubs so every ordering / lifecycle rule is deterministic.
const test = require("node:test");
const assert = require("node:assert/strict");

const { OpenChatsController, TEXTS } = require("../lib/open-chats");

function panel(title) {
	return { title };
}

function quickPickStub() {
	const handlers = { accept: [], hide: [], change: [] };
	const subscribe = (event, fn) => {
		handlers[event].push(fn);
		return {
			dispose() {
				const at = handlers[event].indexOf(fn);
				if (at >= 0) handlers[event].splice(at, 1);
			}
		};
	};
	const picker = {
		items: [],
		selectedItems: [],
		value: undefined,
		shown: false,
		disposed: false,
		onDidAccept: (fn) => subscribe("accept", fn),
		onDidHide: (fn) => subscribe("hide", fn),
		onDidChangeValue: (fn) => subscribe("change", fn),
		show() {
			picker.shown = true;
		},
		hide() {
			if (!picker.shown) return;
			picker.shown = false;
			picker.emit("hide");
		},
		dispose() {
			picker.disposed = true;
		},
		emit(event) {
			for (const fn of handlers[event].slice()) fn();
		},
		listenerCount(event) {
			return handlers[event].length;
		}
	};
	return picker;
}

function statusItemStub() {
	return {
		text: "",
		tooltip: "",
		// Main's factory owns the command; the controller must not touch it.
		command: "kimiCompanion.openChats",
		visible: false,
		disposed: false,
		show() {
			this.visible = true;
		},
		hide() {
			this.visible = false;
		},
		dispose() {
			this.disposed = true;
		}
	};
}

function setup(entries, options = {}) {
	const env = {
		entries,
		panelCalls: 0,
		revealed: [],
		pickers: [],
		items: [],
		tabListeners: [],
		tabDisposed: 0,
		panelsError: null
	};
	env.controller = new OpenChatsController({
		getPanels: () => {
			env.panelCalls++;
			if (env.panelsError) throw env.panelsError;
			return env.entries;
		},
		reveal: (target) => {
			env.revealed.push(target);
			return options.reveal ? options.reveal(target) : undefined;
		},
		createQuickPick: () => {
			const picker = quickPickStub();
			env.pickers.push(picker);
			return picker;
		},
		createStatusItem: () => {
			const item = statusItemStub();
			env.items.push(item);
			return item;
		},
		onDidChangeTabs: (listener) => {
			env.tabListeners.push(listener);
			return {
				dispose() {
					env.tabDisposed++;
				}
			};
		},
		texts: options.texts
	});
	return env;
}

function settle() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("the picker lists waiting, then errors, then the rest in tab order", () => {
	const done = panel("done");
	const wait = panel("wait");
	const run = panel("run");
	const fail = panel("fail");
	const idle = panel("idle");
	const env = setup([
		{ panel: done, title: "done", status: "done" },
		{ panel: wait, title: "wait", status: "waiting" },
		{ panel: run, title: "run", status: "running" },
		{ panel: fail, title: "fail", status: "error" },
		{ panel: idle, title: "idle", status: null }
	]);
	assert.equal(env.controller.show(), true);
	const picker = env.pickers[0];
	assert.deepEqual(picker.items.map((i) => i.label), ["wait", "fail", "done", "run", "idle"]);
	assert.deepEqual(picker.items.map((i) => i.panel), [wait, fail, done, run, idle]);
	assert.deepEqual(picker.items.map((i) => i.status), ["waiting", "error", "done", "running", null]);
	assert.equal(picker.shown, true);
});

test("live search stays native: the full list is handed over and value is untouched", () => {
	const env = setup([
		{ panel: panel("alpha"), title: "alpha", status: "waiting" },
		{ panel: panel("beta"), title: "beta", status: "done" }
	]);
	env.controller.show();
	const picker = env.pickers[0];
	assert.equal(picker.value, undefined, "the controller never writes into the search box");
	assert.equal(picker.matchOnDescription, true, "status words are searchable too");
	picker.value = "alph";
	picker.emit("change");
	assert.equal(picker.items.length, 2, "items are not narrowed by hand");
	assert.deepEqual(picker.items.map((i) => i.label), ["alpha", "beta"]);
});

test("accept reveals the selected panel while it is still open", async () => {
	const a = panel("a");
	const b = panel("b");
	const env = setup([
		{ panel: a, title: "a", status: "waiting" },
		{ panel: b, title: "b", status: "done" }
	]);
	env.controller.show();
	const picker = env.pickers[0];
	picker.selectedItems = [picker.items[1]];
	picker.emit("accept");
	await settle();
	assert.deepEqual(env.revealed, [b]);
	assert.equal(picker.disposed, true);
	assert.equal(picker.listenerCount("accept"), 0, "listeners are gone with the picker");
	assert.equal(picker.listenerCount("hide"), 0);
});

test("accept does nothing when the chat was closed while the picker was open", async () => {
	const a = panel("a");
	const b = panel("b");
	const env = setup([
		{ panel: a, title: "a", status: "waiting" },
		{ panel: b, title: "b", status: "done" }
	]);
	env.controller.show();
	const picker = env.pickers[0];
	const itemA = picker.items.find((i) => i.panel === a);
	picker.selectedItems = [itemA];
	env.entries = [{ panel: b, title: "b", status: "done" }];
	picker.emit("accept");
	await settle();
	assert.deepEqual(env.revealed, [], "a closed panel is never revealed from a stale item");
});

test("accept without a selection only closes the picker", async () => {
	const env = setup([{ panel: panel("a"), title: "a", status: "waiting" }]);
	env.controller.show();
	const picker = env.pickers[0];
	picker.emit("accept");
	await settle();
	assert.deepEqual(env.revealed, []);
	assert.equal(picker.disposed, true);
});

test("hiding the picker (Esc) disposes it and ignores later accepts", async () => {
	const env = setup([{ panel: panel("a"), title: "a", status: "waiting" }]);
	env.controller.show();
	const picker = env.pickers[0];
	picker.hide();
	assert.equal(picker.disposed, true);
	assert.equal(picker.listenerCount("accept"), 0);
	picker.emit("accept");
	await settle();
	assert.deepEqual(env.revealed, []);
});

test("opening the picker again closes the previous one", () => {
	const env = setup([{ panel: panel("a"), title: "a", status: null }]);
	env.controller.show();
	const first = env.pickers[0];
	env.controller.show();
	const second = env.pickers[1];
	assert.equal(first.disposed, true);
	assert.equal(first.listenerCount("accept"), 0);
	assert.equal(second.disposed, false);
	assert.equal(second.shown, true);
});

test("show does nothing without open chats", () => {
	const env = setup([]);
	assert.equal(env.controller.show(), false);
	assert.equal(env.pickers.length, 0);
});

test("entries without a panel are skipped and invalid statuses become idle", () => {
	const env = setup([
		{ title: "ghost", status: "waiting" },
		{ panel: panel("a"), title: "a", status: "bogus" },
		{ panel: null, title: "b", status: "waiting" }
	]);
	env.controller.show();
	const picker = env.pickers[0];
	assert.deepEqual(picker.items.map((i) => i.label), ["a"]);
	assert.equal(picker.items[0].status, null);
});

test("a missing title falls back to the panel title, then to the product name", () => {
	const titled = { title: "  My chat " };
	const broken = {
		get title() {
			throw new Error("panel is gone");
		}
	};
	const env = setup([
		{ panel: titled, title: "", status: null },
		{ panel: broken, status: null }
	]);
	env.controller.show();
	assert.deepEqual(env.pickers[0].items.map((i) => i.label), ["My chat", "Kimi Code"]);
});

test("the counter counts waiting chats, hides at zero and leaves the command to Main", async () => {
	const waiting = panel("w");
	const error = panel("e");
	const env = setup([
		{ panel: waiting, title: "w", status: "waiting" },
		{ panel: error, title: "e", status: "error" }
	]);
	await env.controller.refresh();
	const item = env.items[0];
	assert.equal(item.text, "[? 1]");
	assert.equal(item.visible, true);
	assert.equal(item.command, "kimiCompanion.openChats", "the controller never assigns the command");
	assert.equal(item.tooltip, TEXTS.counterTooltip(1));
	env.entries = [{ panel: error, title: "e", status: "error" }];
	await env.controller.refresh();
	assert.equal(item.text, "[? 0]", "errors do not count as waiting");
	assert.equal(item.visible, false);
	await env.controller.refresh();
	assert.equal(env.items.length, 1, "the status item is created once and reused");
});

test("the status item is created on the first refresh, not at construction", async () => {
	const env = setup([]);
	assert.equal(env.items.length, 0);
	await env.controller.refresh();
	assert.equal(env.items.length, 1);
	assert.equal(env.items[0].text, "[? 0]");
	assert.equal(env.items[0].visible, false);
});

test("refresh coalesces a burst into one read of the panel list", async () => {
	const env = setup([{ panel: panel("a"), title: "a", status: "waiting" }]);
	const first = env.controller.refresh();
	const second = env.controller.refresh();
	assert.equal(first, second, "callers awaiting a pending refresh share it");
	assert.equal(env.panelCalls, 0, "nothing is read before the queued task runs");
	const entries = await first;
	assert.equal(env.panelCalls, 1);
	assert.equal(entries.length, 1);
	await env.controller.refresh();
	assert.equal(env.panelCalls, 2, "a later refresh reads again");
});

test("tab events are coalesced too", async () => {
	const env = setup([{ panel: panel("a"), title: "a", status: "waiting" }]);
	env.tabListeners[0]();
	env.tabListeners[0]();
	await settle();
	assert.equal(env.panelCalls, 1, "two tab changes collapse into one recompute");
});

test("nextWaiting cycles the waiting chats and restarts when the list changes", () => {
	const w1 = panel("w1");
	const w2 = panel("w2");
	const error = panel("e");
	const env = setup([
		{ panel: w1, title: "w1", status: "waiting" },
		{ panel: error, title: "e", status: "error" },
		{ panel: w2, title: "w2", status: "waiting" }
	]);
	assert.equal(env.controller.nextWaiting(), w1);
	assert.equal(env.controller.nextWaiting(), w2);
	assert.equal(env.controller.nextWaiting(), w1, "the cycle wraps around");
	env.entries = [{ panel: error, title: "e", status: "error" }];
	assert.equal(env.controller.nextWaiting(), null, "errors are not waiting");
	env.entries = [{ panel: w2, title: "w2", status: "waiting" }];
	assert.equal(env.controller.nextWaiting(), w2, "a vanished cursor restarts at the first chat");
	assert.deepEqual(env.revealed, [w1, w2, w1, w2]);
});

test("nextAttention cycles waiting then error chats", () => {
	const w1 = panel("w1");
	const w2 = panel("w2");
	const error = panel("e");
	const env = setup([
		{ panel: error, title: "e", status: "error" },
		{ panel: w1, title: "w1", status: "waiting" },
		{ panel: w2, title: "w2", status: "waiting" }
	]);
	const seen = [];
	for (let i = 0; i < 5; i++) seen.push(env.controller.nextAttention());
	assert.deepEqual(seen, [w1, w2, error, w1, w2]);
});

test("nextWaiting and nextAttention keep independent cursors", () => {
	const w1 = panel("w1");
	const w2 = panel("w2");
	const entries = [
		{ panel: w1, title: "w1", status: "waiting" },
		{ panel: w2, title: "w2", status: "waiting" }
	];
	const waiting = setup(entries);
	assert.equal(waiting.controller.nextWaiting(), w1);
	assert.equal(waiting.controller.nextWaiting(), w2);
	const attention = setup(entries);
	assert.equal(attention.controller.nextAttention(), w1, "attention starts fresh");
	assert.equal(attention.controller.nextAttention(), w2);
});

test("nextWaiting and nextAttention are inert without candidates", () => {
	const env = setup([{ panel: panel("d"), title: "d", status: "done" }]);
	assert.equal(env.controller.nextWaiting(), null);
	assert.equal(env.controller.nextAttention(), null);
	assert.deepEqual(env.revealed, []);
});

test("a throwing panel source degrades to an empty list", () => {
	const env = setup([{ panel: panel("a"), title: "a", status: "waiting" }]);
	env.panelsError = new Error("extension host is going away");
	assert.equal(env.controller.show(), false);
	assert.equal(env.controller.nextWaiting(), null);
	assert.equal(env.controller.nextAttention(), null);
	assert.deepEqual(env.revealed, []);
});

test("a rejected reveal is swallowed", async () => {
	const env = setup([{ panel: panel("a"), title: "a", status: "waiting" }], {
		reveal: () => Promise.reject(new Error("panel is gone"))
	});
	env.controller.show();
	const picker = env.pickers[0];
	picker.selectedItems = [picker.items[0]];
	picker.emit("accept");
	await settle();
	assert.equal(env.revealed.length, 1);
});

test("dispose tears down the picker, the tab listener and the status item", async () => {
	const env = setup([{ panel: panel("a"), title: "a", status: "waiting" }]);
	await env.controller.refresh();
	env.controller.show();
	const picker = env.pickers[0];
	env.controller.dispose();
	assert.equal(env.items[0].disposed, true);
	assert.equal(picker.disposed, true);
	assert.equal(picker.listenerCount("accept"), 0);
	assert.equal(picker.listenerCount("hide"), 0);
	assert.equal(env.tabDisposed, 1);
	env.controller.dispose();
	assert.equal(env.tabDisposed, 1, "dispose is idempotent");
	const calls = env.panelCalls;
	env.tabListeners[0]();
	await settle();
	assert.equal(env.panelCalls, calls, "late tab events are ignored");
	assert.deepEqual(await env.controller.refresh(), []);
	assert.equal(env.controller.show(), false);
	assert.equal(env.controller.nextWaiting(), null);
	assert.equal(env.controller.nextAttention(), null);
});

test("a refresh queued before dispose never touches the UI afterwards", async () => {
	const env = setup([{ panel: panel("a"), title: "a", status: "waiting" }]);
	const pending = env.controller.refresh();
	env.controller.dispose();
	const entries = await pending;
	assert.deepEqual(entries, []);
	assert.equal(env.panelCalls, 0);
	assert.equal(env.items.length, 0, "no status item is created after dispose");
});

test("a reveal resolving after dispose settles quietly", async () => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const env = setup([{ panel: panel("a"), title: "a", status: "waiting" }], { reveal: () => gate });
	env.controller.show();
	const picker = env.pickers[0];
	picker.selectedItems = [picker.items[0]];
	picker.emit("accept");
	env.controller.dispose();
	release();
	await settle();
	assert.equal(env.revealed.length, 1);
	assert.equal(env.items.length, 0);
});

test("texts are injectable so Main can supply RU or ZH", () => {
	const env = setup([{ panel: panel("a"), title: "a", status: "waiting" }], {
		texts: { placeholder: "Выберите чат Kimi", statusWaiting: "ждёт ответа" }
	});
	env.controller.show();
	const picker = env.pickers[0];
	assert.equal(picker.placeholder, "Выберите чат Kimi");
	assert.equal(picker.items[0].description, "ждёт ответа");
	assert.equal(picker.title, TEXTS.title, "keys that are not overridden keep the EN default");
});

test("refresh updates an open picker without clearing its query or active panel", async () => {
	const first = panel("first");
	const second = panel("second");
	const env = setup([{ panel: first, title: "first", status: "done" }]);
	env.controller.show();
	const picker = env.pickers[0];
	picker.value = "fir";
	picker.activeItems = [picker.items[0]];
	env.entries = [
		{ panel: second, title: "second", status: "waiting" },
		{ panel: first, title: "first renamed", status: "done" }
	];
	await env.controller.refresh();
	assert.equal(picker.value, "fir");
	assert.deepEqual(picker.items.map((item) => item.label), ["second", "first renamed"]);
	assert.equal(picker.activeItems[0].panel, first);
});

test("accept uses activeItems when selectedItems is empty", () => {
	const target = panel("target");
	const env = setup([{ panel: target, title: "target", status: "waiting" }]);
	env.controller.show();
	const picker = env.pickers[0];
	picker.activeItems = [picker.items[0]];
	picker.selectedItems = [];
	picker.emit("accept");
	assert.deepEqual(env.revealed, [target]);
});
