"use strict";

function usageFreshness(res, slots, now = Date.now(), staleMs = 120000) {
	if (!res || !Number.isFinite(res.updatedAt)) return "unavailable";
	if (slots.some((slot) => {
		if (!slot.resetAt) return false;
		const reset = new Date(slot.resetAt).getTime();
		return !Number.isFinite(reset) || reset <= now;
	})) return "refresh-needed";
	return res.updatedAt > now || now - res.updatedAt > staleMs ? "stale" : "fresh";
}

class FiveHourSourceTracker {
	constructor() {
		this.official = null;
		this.wire = null;
		this.preferOfficial = true;
	}

	track(res) {
		const official = res && res.quota && res.quota.usages && res.quota.usages.limit5h;
		const officialRatio = official && typeof official.usedRatio === "number" ? official.usedRatio : null;
		const window = res && Array.isArray(res.windows) ? res.windows.find((w) => w.durationMinutes === 300) : null;
		const wireRatio = window && Number.isFinite(window.ratio) ? window.ratio : null;
		if (officialRatio === null) this.preferOfficial = false;
		else if (wireRatio === null) this.preferOfficial = true;
		else if (officialRatio === 0) this.preferOfficial = false;
		else if (this.official !== null && this.wire !== null) {
			const officialMoved = officialRatio !== this.official;
			const wireMoved = wireRatio !== this.wire;
			if (officialMoved) this.preferOfficial = true;
			else if (wireMoved && officialRatio !== wireRatio) this.preferOfficial = false;
		} else this.preferOfficial = officialRatio > 0;
		this.official = officialRatio;
		this.wire = wireRatio;
		return this.preferOfficial;
	}
}

module.exports = { usageFreshness, FiveHourSourceTracker };
