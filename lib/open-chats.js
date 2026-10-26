// Navigation across the currently open Kimi chats: a quick pick (waiting first),
// cycling through chats that need attention, and the "[? N]" status bar counter.
// Every VS Code API is injected, so this file stays host-free and testable with node.

const STATUSES = ["running", "waiting", "done", "error"];
const FALLBACK_TITLE = "Kimi Code";

const TEXTS = {
	title: "Kimi Code",
	placeholder: "Select a Kimi chat",
	statusRunning: "running",
	statusWaiting: "waiting for input",
	statusDone: "done",
	statusError: "error",
	counterTooltip: (n) => (n === 1 ? "1 Kimi chat is waiting for input" : `${n} Kimi chats are waiting for input`)
};

// Waiting needs the user most, an error is the next thing worth a look; everything
// else (running, done, idle) keeps the tab order it came in.
function rank(status) {
	if (status === "waiting") return 0;
	if (status === "error") return 1;
	return 2;
}

function normalizeStatus(status) {
	return STATUSES.includes(status) ? status : null;
}

function titleOf(panel, title) {
	if (typeof title === "string" && title.trim()) return title.trim();
	let fallback = "";
	try {
		fallback = String(panel.title || "");
	} catch {
		// panel already gone
	}
	return fallback.trim() || FALLBACK_TITLE;
}

function disposeQuietly(value) {
	if (!value) return;
	try {
		if (typeof value.dispose === "function") value.dispose();
		else if (typeof value === "function") value();
	} catch {
		// disposal is best effort
	}
}

class OpenChatsController {
	constructor(options = {}) {
		const opts = options || {};
		this.getPanels = typeof opts.getPanels === "function" ? opts.getPanels : () => [];
		this.reveal = typeof opts.reveal === "function" ? opts.reveal : () => {};
		this.createQuickPick = typeof opts.createQuickPick === "function" ? opts.createQuickPick : null;
		this.createStatusItem = typeof opts.createStatusItem === "function" ? opts.createStatusItem : null;
		this.texts = { ...TEXTS, ...(opts.texts || {}) };
		this.disposed = false;
		this.pending = null;
		this.picker = null;
		this.pickerSubs = [];
		this.statusItem = null;
		this.waitCursor = null;
		this.attentionCursor = null;
		this.tabSub = null;
		if (typeof opts.onDidChangeTabs === "function") {
			try {
				this.tabSub = opts.onDidChangeTabs(() => {
					void this.refresh();
				});
			} catch {
				this.tabSub = null;
			}
		}
	}

	// Coalesced: any number of calls in one tick share a single read of getPanels().
	// The queued task re-checks `disposed`, so a refresh scheduled before dispose
	// never reaches the UI afterwards.
	refresh() {
		if (this.disposed) return Promise.resolve([]);
		if (this.pending) return this.pending;
		this.pending = Promise.resolve().then(() => {
			this.pending = null;
			if (this.disposed) return [];
			const entries = this.readEntries();
			this.updateCounter(entries);
			this.updatePicker(entries);
			return entries;
		});
		return this.pending;
	}

	// Opens the picker with the full, sorted list. Live search stays native: `items`
	// is never narrowed here and `value` is never touched, so VS Code filters as the
	// user types. Acceptance revalidates the panel against the live list.
	show() {
		if (this.disposed) return false;
		const entries = this.readEntries();
		if (entries.length === 0) return false;
		this.closePicker();
		if (this.disposed) return false;
		const picker = this.createPicker();
		if (!picker) return false;
		this.picker = picker;
		picker.title = this.texts.title;
		picker.placeholder = this.texts.placeholder;
		picker.matchOnDescription = true;
		this.updatePicker(entries);
		this.pickerSubs = [
			this.listen(picker, "onDidAccept", () => this.accept(picker)),
			this.listen(picker, "onDidHide", () => this.closePicker(picker))
		].filter(Boolean);
		picker.show();
		return true;
	}

	updatePicker(entries) {
		const picker = this.picker;
		if (!picker || this.disposed) return;
		const active = Array.isArray(picker.activeItems) && picker.activeItems[0] ? picker.activeItems[0].panel : null;
		picker.items = this.sortedEntries(entries).map((entry) => ({
			label: entry.title,
			description: this.statusText(entry.status),
			panel: entry.panel,
			status: entry.status
		}));
		if (active) {
			const current = picker.items.find((item) => item.panel === active);
			picker.activeItems = current ? [current] : [];
		}
	}

	// Each call reveals the waiting chat after the previously revealed one and wraps
	// around. A cursor whose panel disappeared restarts the cycle at the first chat.
	// Returns the panel that was revealed, or null when nothing is waiting.
	nextWaiting() {
		return this.advance("waitCursor", ["waiting"]);
	}

	// Same cycle over waiting and error chats, waiting group first.
	nextAttention() {
		return this.advance("attentionCursor", ["waiting", "error"]);
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.pending = null;
		this.closePicker();
		const tabSub = this.tabSub;
		this.tabSub = null;
		disposeQuietly(tabSub);
		const item = this.statusItem;
		this.statusItem = null;
		disposeQuietly(item);
	}

	readEntries() {
		if (this.disposed) return [];
		let raw;
		try {
			raw = this.getPanels();
		} catch {
			return [];
		}
		if (!Array.isArray(raw)) return [];
		const entries = [];
		for (const item of raw) {
			if (!item || typeof item !== "object" || !item.panel) continue;
			entries.push({
				panel: item.panel,
				title: titleOf(item.panel, item.title),
				status: normalizeStatus(item.status)
			});
		}
		return entries;
	}

	sortedEntries(entries) {
		// Array.prototype.sort is stable, so equal ranks keep the getPanels() order.
		return entries.slice().sort((a, b) => rank(a.status) - rank(b.status));
	}

	statusText(status) {
		if (status === "waiting") return this.texts.statusWaiting;
		if (status === "error") return this.texts.statusError;
		if (status === "running") return this.texts.statusRunning;
		if (status === "done") return this.texts.statusDone;
		return "";
	}

	advance(cursorKey, statuses) {
		if (this.disposed) return null;
		const entries = this.sortedEntries(this.readEntries()).filter((entry) => statuses.includes(entry.status));
		if (entries.length === 0) return null;
		const cursor = this[cursorKey];
		let index = 0;
		if (cursor) {
			const at = entries.findIndex((entry) => entry.panel === cursor);
			if (at >= 0) index = (at + 1) % entries.length;
		}
		const target = entries[index].panel;
		this[cursorKey] = target;
		void this.revealPanel(target);
		return target;
	}

	accept(picker) {
		if (this.picker !== picker) return;
		const active = Array.isArray(picker.activeItems) ? picker.activeItems[0] : null;
		const picked = active || (Array.isArray(picker.selectedItems) ? picker.selectedItems[0] : null);
		this.closePicker(picker);
		if (!picked || !picked.panel || this.disposed) return;
		// The chat may have been closed while the picker was open; reveal only a panel
		// that is still in the live list (matched by identity, not by index or title).
		const current = this.readEntries().find((entry) => entry.panel === picked.panel);
		if (!current) return;
		void this.revealPanel(current.panel);
	}

	async revealPanel(panel) {
		if (this.disposed) return false;
		try {
			await this.reveal(panel);
		} catch {
			return false;
		}
		return !this.disposed;
	}

	updateCounter(entries) {
		if (this.disposed) return;
		const waiting = entries.filter((entry) => entry.status === "waiting").length;
		const item = this.ensureStatusItem();
		if (!item) return;
		// The command is Main's to assign; this module only owns text, tooltip and visibility.
		item.text = `[? ${waiting}]`;
		item.tooltip = this.texts.counterTooltip(waiting);
		if (waiting > 0) item.show();
		else item.hide();
	}

	ensureStatusItem() {
		if (this.statusItem) return this.statusItem;
		if (!this.createStatusItem) return null;
		const make = this.createStatusItem;
		try {
			this.statusItem = make() || null;
		} catch {
			this.statusItem = null;
		}
		return this.statusItem;
	}

	createPicker() {
		if (!this.createQuickPick) return null;
		const make = this.createQuickPick;
		try {
			return make() || null;
		} catch {
			return null;
		}
	}

	listen(picker, event, handler) {
		const subscribe = picker[event];
		if (typeof subscribe !== "function") return null;
		try {
			return subscribe.call(picker, handler) || null;
		} catch {
			return null;
		}
	}

	closePicker(target) {
		const picker = this.picker;
		if (!picker || (target && target !== picker)) return;
		this.picker = null;
		const subs = this.pickerSubs;
		this.pickerSubs = [];
		for (const sub of subs) disposeQuietly(sub);
		try {
			picker.hide();
		} catch {
			// picker already gone
		}
		disposeQuietly(picker);
	}
}

module.exports = { OpenChatsController, TEXTS };
