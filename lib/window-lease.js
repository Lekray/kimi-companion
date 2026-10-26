"use strict";

// Cross-process ownership lease for one writer on storage shared by several
// extension hosts (for example one workspace globalStorage folder).
//
// The lease is a JSON file created with O_CREAT|O_EXCL. A sibling directory acts
// as a short-lived mutex around the read-modify-write paths (takeover, heartbeat,
// release). The holder refreshes `renewedAt` every heartbeatMs; a lease whose
// renewedAt (or, for an unparsable file, whose mtime) is older than staleMs is
// considered abandoned. Every write and unlink is guarded by the holder token,
// so a former holder can neither refresh nor delete another owner's lease.
// Filesystem problems degrade to "not the owner" instead of throwing.

const fs = require("fs");
const path = require("path");

const fsp = fs.promises;
const LOCK_OWNER_FILE = "owner";

let tokenSeq = 0;

class WindowLease {
	constructor(options) {
		const opts = options || {};
		if (typeof opts.filePath !== "string" || opts.filePath.length === 0) {
			throw new TypeError("WindowLease: filePath must be a non-empty string");
		}
		if (typeof opts.ownerId !== "string" || opts.ownerId.length === 0) {
			throw new TypeError("WindowLease: ownerId must be a non-empty string");
		}
		const staleMs = opts.staleMs === undefined ? 15000 : opts.staleMs;
		const heartbeatMs = opts.heartbeatMs === undefined ? 5000 : opts.heartbeatMs;
		if (!Number.isFinite(staleMs) || staleMs <= 0) {
			throw new RangeError("WindowLease: staleMs must be a positive number");
		}
		if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
			throw new RangeError("WindowLease: heartbeatMs must be a positive number");
		}
		if (heartbeatMs >= staleMs) {
			throw new RangeError("WindowLease: heartbeatMs must be smaller than staleMs");
		}

		this.filePath = path.resolve(opts.filePath);
		this.ownerId = opts.ownerId;
		this.staleMs = staleMs;
		this.heartbeatMs = heartbeatMs;
		this.lockStaleMs = opts.lockStaleMs === undefined
			? Math.max(2000, Math.min(staleMs, 10000))
			: opts.lockStaleMs;
		if (!Number.isFinite(this.lockStaleMs) || this.lockStaleMs <= 0) {
			throw new RangeError("WindowLease: lockStaleMs must be a positive number");
		}
		this.lockPath = `${this.filePath}.lock`;
		this.tempPath = `${this.filePath}.tmp`;
		this.lastError = null;

		this._now = typeof opts.now === "function" ? opts.now : Date.now;
		this._setInterval = typeof opts.setIntervalFn === "function"
			? opts.setIntervalFn
			: (fn, ms) => setInterval(fn, ms);
		this._clearInterval = typeof opts.clearIntervalFn === "function"
			? opts.clearIntervalFn
			: (timer) => clearInterval(timer);

		this._pid = process.pid;
		this._token = null;
		this._acquiredAt = 0;
		this._timer = null;
		this._beatRunning = false;
		this._beatPromise = null;
		this._lockToken = null;
		this._acquiring = false;
		this._dirReady = false;
		this._disposed = false;
	}

	get isOwner() {
		return this._token !== null && !this._disposed;
	}

	// Resolves true only when this instance owns the lease. Never throws: any
	// filesystem or contention failure resolves false so the caller can retry.
	async acquire() {
		if (this._disposed) return false;
		if (this._token !== null) return true;
		if (this._acquiring) return false;
		this._acquiring = true;
		this.lastError = null;
		try {
			if (!(await this._ensureDir())) return false;
			const record = this._newRecord();
			const created = await this._createExclusive(record);
			if (created === "created") return this._commit(record);
			if (created !== "exists") return false;

			if (!(await this._lock())) return false;
			let written = false;
			try {
				written = await this._claimUnderLock(record);
			} finally {
				await this._unlock();
			}
			return written ? this._commit(record) : false;
		} catch (err) {
			this.lastError = err;
			return false;
		} finally {
			this._acquiring = false;
		}
	}

	// Drops ownership. A no-op for a non-owner, which is what keeps one host from
	// deleting another host's lease.
	async release() {
		const token = this._token;
		if (token === null) return;
		this._stopHeartbeat();
		this._token = null;
		this._acquiredAt = 0;
		const pending = this._beatPromise;
		this._beatPromise = null;
		if (pending) {
			try {
				await pending;
			} catch (err) {
				this.lastError = err;
			}
		}
		try {
			if (!(await this._lock())) return;
			try {
				const lease = await this._readLease();
				if (lease.state === "valid" && lease.record.token === token) {
					try {
						await fsp.unlink(this.filePath);
					} catch (err) {
						if (err.code !== "ENOENT") this.lastError = err;
					}
				}
				try {
					await fsp.unlink(this.tempPath);
				} catch (err) {
					if (err.code !== "ENOENT") this.lastError = err;
				}
			} finally {
				await this._unlock();
			}
		} catch (err) {
			this.lastError = err;
		}
	}

	// Stops the heartbeat and releases the lease. Idempotent and safe to call on
	// an instance that never owned anything.
	async dispose() {
		if (this._disposed) {
			this._stopHeartbeat();
			return;
		}
		this._disposed = true;
		this._stopHeartbeat();
		if (this._token !== null) {
			await this.release();
			return;
		}
		const pending = this._beatPromise;
		this._beatPromise = null;
		if (pending) {
			try {
				await pending;
			} catch (err) {
				this.lastError = err;
			}
		}
	}

	async _commit(record) {
		if (this._disposed) {
			// acquire() raced dispose(): never leave a lease that no heartbeat renews.
			await this._discardOwnRecord(record.token);
			return false;
		}
		this._token = record.token;
		this._acquiredAt = record.acquiredAt;
		this._startHeartbeat();
		return true;
	}

	async _discardOwnRecord(token) {
		try {
			if (!(await this._lock())) return;
			try {
				const lease = await this._readLease();
				if (lease.state !== "valid" || lease.record.token !== token) return;
				try {
					await fsp.unlink(this.filePath);
				} catch (err) {
					if (err.code !== "ENOENT") this.lastError = err;
				}
			} finally {
				await this._unlock();
			}
		} catch (err) {
			this.lastError = err;
		}
	}

	_newToken(kind) {
		tokenSeq = (tokenSeq + 1) % Number.MAX_SAFE_INTEGER;
		const rand = Math.random().toString(36).slice(2, 10);
		return `${kind}:${this._pid}:${this._now().toString(36)}:${tokenSeq.toString(36)}:${rand}`;
	}

	_newRecord() {
		const acquiredAt = this._now();
		return {
			ownerId: this.ownerId,
			token: this._newToken("lease"),
			pid: this._pid,
			acquiredAt,
			renewedAt: acquiredAt
		};
	}

	async _ensureDir() {
		if (this._dirReady) return true;
		try {
			await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
			this._dirReady = true;
			return true;
		} catch (err) {
			this.lastError = err;
			return false;
		}
	}

	async _createExclusive(record) {
		try {
			await fsp.writeFile(this.filePath, JSON.stringify(record), { flag: "wx" });
			return "created";
		} catch (err) {
			if (err.code === "EEXIST") return "exists";
			if (err.code === "ENOENT") this._dirReady = false;
			this.lastError = err;
			return "error";
		}
	}

	// Called only while holding the mutex. A missing lease is created exclusively:
	// the file may have been released after our unlocked attempt, in which case a
	// fresh owner may already have won the exclusive create that follows.
	async _claimUnderLock(record) {
		let lease = await this._readLease();
		if (lease.state === "missing") {
			const created = await this._createExclusive(record);
			if (created === "created") return true;
			if (created !== "exists") return false;
			lease = await this._readLease();
			if (lease.state === "missing") return false;
		}
		if (!this._isStale(lease)) return false;
		return this._writeRecord(record);
	}

	async _writeRecord(record) {
		const data = JSON.stringify(record);
		try {
			await fsp.writeFile(this.tempPath, data);
			try {
				await fsp.rename(this.tempPath, this.filePath);
				return true;
			} catch (renameErr) {
				// Windows can refuse to replace a file another host has open. The
				// mutex still makes a direct write safe among cooperating processes.
				await fsp.writeFile(this.filePath, data);
				await fsp.unlink(this.tempPath).catch(() => {});
				return true;
			}
		} catch (err) {
			if (err.code === "ENOENT") this._dirReady = false;
			this.lastError = err;
			return false;
		}
	}

	async _readLease() {
		let raw;
		try {
			raw = await fsp.readFile(this.filePath, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") return { state: "missing" };
			this.lastError = err;
			return { state: "corrupt", mtimeMs: await this._mtime() };
		}
		let record = null;
		try {
			record = JSON.parse(raw);
		} catch (err) {
			record = null;
		}
		const valid = record !== null && typeof record === "object" && !Array.isArray(record) &&
			typeof record.ownerId === "string" && record.ownerId.length > 0 &&
			typeof record.token === "string" && record.token.length > 0 &&
			Number.isFinite(record.renewedAt);
		if (!valid) return { state: "corrupt", mtimeMs: await this._mtime() };
		return { state: "valid", record };
	}

	async _mtime() {
		try {
			const st = await fsp.stat(this.filePath);
			return st.mtimeMs;
		} catch (err) {
			return null;
		}
	}

	// A corrupt or unreadable lease keeps blocking until its mtime ages out; an
	// unknown age is treated as "still held" so a half-written file cannot cause
	// a second owner.
	_isStale(lease) {
		if (lease.state === "missing") return true;
		const stamp = lease.state === "valid" ? lease.record.renewedAt : lease.mtimeMs;
		if (typeof stamp !== "number" || !Number.isFinite(stamp)) return false;
		const age = this._now() - stamp;
		if (age < 0) return false;
		return age > this.staleMs;
	}

	async _lock() {
		const token = this._newToken("lock");
		let got = await this._mkdirLock();
		if (!got && await this._breakStaleLock()) got = await this._mkdirLock();
		if (!got) return false;
		try {
			await fsp.writeFile(path.join(this.lockPath, LOCK_OWNER_FILE), token);
		} catch (err) {
			this.lastError = err;
			await this._removeOwnLock(token);
			return false;
		}
		this._lockToken = token;
		return true;
	}

	async _unlock() {
		const token = this._lockToken;
		this._lockToken = null;
		if (token === null) return;
		await this._removeOwnLock(token);
	}

	async _mkdirLock() {
		try {
			await fsp.mkdir(this.lockPath);
			return true;
		} catch (err) {
			if (err.code !== "EEXIST") {
				if (err.code === "ENOENT") this._dirReady = false;
				this.lastError = err;
			}
			return false;
		}
	}

	async _breakStaleLock() {
		let st;
		try {
			st = await fsp.stat(this.lockPath);
		} catch (err) {
			if (err.code !== "ENOENT") this.lastError = err;
			return false;
		}
		if (!(this._now() - st.mtimeMs > this.lockStaleMs)) return false;
		try {
			if (st.isDirectory()) {
				try {
					await fsp.unlink(path.join(this.lockPath, LOCK_OWNER_FILE));
				} catch (err) {
					if (err.code !== "ENOENT") return false;
				}
				await fsp.rmdir(this.lockPath);
			} else {
				await fsp.unlink(this.lockPath);
			}
			return true;
		} catch (err) {
			if (err.code !== "ENOENT") this.lastError = err;
			return false;
		}
	}

	async _removeOwnLock(token) {
		const markerPath = path.join(this.lockPath, LOCK_OWNER_FILE);
		try {
			const raw = await fsp.readFile(markerPath, "utf8");
			if (raw !== token) return;
		} catch (err) {
			if (err.code !== "ENOENT") {
				this.lastError = err;
				return;
			}
		}
		try {
			await fsp.unlink(markerPath);
		} catch (err) {
			if (err.code !== "ENOENT") {
				this.lastError = err;
				return;
			}
		}
		try {
			await fsp.rmdir(this.lockPath);
		} catch (err) {
			if (err.code !== "ENOENT") this.lastError = err;
		}
	}

	_startHeartbeat() {
		this._stopHeartbeat();
		const tick = () => {
			if (!this._beatRunning) this._beatPromise = this._beat();
			return this._beatPromise;
		};
		let timer;
		try {
			timer = this._setInterval(tick, this.heartbeatMs);
		} catch (err) {
			this.lastError = err;
			return;
		}
		this._timer = timer;
		if (timer && typeof timer.unref === "function") timer.unref();
	}

	_stopHeartbeat() {
		if (this._timer === null) return;
		const timer = this._timer;
		this._timer = null;
		try {
			this._clearInterval(timer);
		} catch (err) {
			this.lastError = err;
		}
	}

	_loseOwnership() {
		this._stopHeartbeat();
		this._token = null;
		this._acquiredAt = 0;
	}

	async _beat() {
		const token = this._token;
		if (token === null || this._beatRunning) return;
		this._beatRunning = true;
		try {
			if (!(await this._lock())) return;
			try {
				const lease = await this._readLease();
				if (this._token !== token) return;
				if (lease.state !== "valid" || lease.record.token !== token) {
					this._loseOwnership();
					return;
				}
				await this._writeRecord({
					ownerId: this.ownerId,
					token,
					pid: this._pid,
					acquiredAt: this._acquiredAt,
					renewedAt: this._now()
				});
			} finally {
				await this._unlock();
			}
		} catch (err) {
			this.lastError = err;
		} finally {
			this._beatRunning = false;
		}
	}
}

module.exports = WindowLease;
module.exports.WindowLease = WindowLease;
