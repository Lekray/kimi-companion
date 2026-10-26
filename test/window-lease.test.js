// Offline tests for lib/window-lease.js: node --test test/window-lease.test.js
// Timers and the clock are injected, so staleness and heartbeats are deterministic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WindowLease = require(path.join(__dirname, "..", "lib", "window-lease.js"));
const { WindowLease: NamedWindowLease } = require(path.join(__dirname, "..", "lib", "window-lease.js"));

const fsp = fs.promises;
const STALE = 1000;
const HEARTBEAT = 200;
const OPTS = { staleMs: STALE, heartbeatMs: HEARTBEAT };

async function tempDir(t) {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "kimi-window-lease-"));
	t.after(() => fsp.rm(dir, { recursive: true, force: true }));
	return dir;
}

function makeClock(start = Date.now()) {
	const state = { t: start };
	return {
		now: () => state.t,
		advance(ms) {
			state.t += ms;
		},
		get time() {
			return state.t;
		}
	};
}

function makeTimers() {
	const timers = [];
	return {
		setIntervalFn(fn, ms) {
			const timer = { fn, ms, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearIntervalFn(timer) {
			timer.cleared = true;
		},
		active() {
			return timers.filter((timer) => !timer.cleared);
		},
		async tick() {
			for (const timer of timers.slice()) {
				if (!timer.cleared) await timer.fn();
			}
		}
	};
}

function makeLease(filePath, ownerId, clock, timers, extra) {
	return new WindowLease({
		filePath,
		ownerId,
		now: clock.now,
		setIntervalFn: timers.setIntervalFn,
		clearIntervalFn: timers.clearIntervalFn,
		...extra
	});
}

async function readLease(filePath) {
	return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function exists(target) {
	try {
		await fsp.stat(target);
		return true;
	} catch (err) {
		return false;
	}
}

async function writeStaleLease(filePath, clock, ownerId = "ghost") {
	const renewedAt = clock.time - STALE * 4;
	await fsp.writeFile(filePath, JSON.stringify({
		ownerId,
		token: `${ownerId}:token`,
		pid: 1,
		acquiredAt: renewedAt,
		renewedAt
	}));
}

test("exports the class as both the module and a named property", () => {
	assert.equal(NamedWindowLease, WindowLease);
});

test("rejects unusable configuration", () => {
	assert.throws(() => new WindowLease({ ownerId: "host" }), TypeError);
	assert.throws(() => new WindowLease({ filePath: "lease.json" }), TypeError);
	assert.throws(() => new WindowLease({ filePath: "lease.json", ownerId: "host", staleMs: 100, heartbeatMs: 100 }), RangeError);
});

test("acquire creates an exclusive lease and release removes it", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "restore.json");
	const clock = makeClock();
	const timers = makeTimers();
	const lease = makeLease(file, "host-a", clock, timers, OPTS);

	assert.equal(lease.isOwner, false);
	assert.equal(await lease.acquire(), true);
	assert.equal(lease.isOwner, true);
	const record = await readLease(file);
	assert.equal(record.ownerId, "host-a");
	assert.equal(typeof record.token, "string");
	assert.ok(record.token.length > 0);
	assert.equal(record.renewedAt, clock.time);
	assert.equal(timers.active().length, 1);

	assert.equal(await lease.acquire(), true, "acquire while owner is idempotent");
	assert.equal((await readLease(file)).token, record.token);
	assert.equal(timers.active().length, 1, "no duplicate heartbeat");

	await lease.release();
	assert.equal(lease.isOwner, false);
	assert.equal(await exists(file), false);
	assert.equal(timers.active().length, 0);
	await lease.release();
});

test("simultaneous owners never both acquire the same lease", async (t) => {
	const dir = await tempDir(t);
	const clock = makeClock();
	for (let round = 0; round < 25; round++) {
		const file = path.join(dir, `lease-${round}.json`);
		const timersA = makeTimers();
		const timersB = makeTimers();
		const a = makeLease(file, "host-a", clock, timersA, OPTS);
		const b = makeLease(file, "host-b", clock, timersB, OPTS);

		const [gotA, gotB] = await Promise.all([a.acquire(), b.acquire()]);
		assert.equal(Number(gotA) + Number(gotB), 1, `round ${round}: exactly one winner`);
		assert.equal(a.isOwner === b.isOwner, false, `round ${round}: only one reports ownership`);
		assert.equal(timersA.active().length + timersB.active().length, 1, `round ${round}: one heartbeat`);
		assert.equal((await readLease(file)).ownerId, gotA ? "host-a" : "host-b", `round ${round}: disk owner matches winner`);

		await Promise.all([a.dispose(), b.dispose()]);
		assert.equal(await exists(file), false, `round ${round}: winner released`);
	}
});

test("only one contender wins a stale lease takeover", async (t) => {
	const dir = await tempDir(t);
	const clock = makeClock();
	for (let round = 0; round < 15; round++) {
		const file = path.join(dir, `stale-${round}.json`);
		await writeStaleLease(file, clock);
		const leases = [];
		for (let i = 0; i < 6; i++) {
			leases.push(makeLease(file, `host-${i}`, clock, makeTimers(), OPTS));
		}
		const results = await Promise.all(leases.map((lease) => lease.acquire()));
		assert.equal(results.filter(Boolean).length, 1, `round ${round}: exactly one takeover`);
		const winner = leases[results.indexOf(true)];
		assert.equal((await readLease(file)).ownerId, winner.ownerId, `round ${round}: disk owner matches winner`);
		await Promise.all(leases.map((lease) => lease.dispose()));
		assert.equal(await exists(file), false, `round ${round}: winner released`);
	}
});

test("a lease created after a failed exclusive create is not overwritten", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const clock = makeClock();
	const timers = makeTimers();
	const contender = makeLease(file, "host-a", clock, timers, OPTS);

	// White box: reproduce the window between a failed exclusive create and the
	// locked re-read, where the old lease is released and a new owner appears.
	await fsp.writeFile(file, JSON.stringify({
		ownerId: "host-b",
		token: "host-b:token",
		pid: 2,
		acquiredAt: clock.time,
		renewedAt: clock.time
	}));
	const realRead = contender._readLease.bind(contender);
	let reads = 0;
	contender._readLease = async () => {
		reads += 1;
		if (reads === 1) return { state: "missing" };
		return realRead();
	};

	assert.equal(await contender.acquire(), false, "a freshly created foreign lease is respected");
	assert.equal(contender.isOwner, false);
	assert.ok(reads >= 2, "the lease was re-read before any write");
	assert.equal(timers.active().length, 0);
	assert.equal((await readLease(file)).ownerId, "host-b");
});

test("a stale lease is taken over; the former owner stops and cannot delete it", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const clock = makeClock();
	const timersA = makeTimers();
	const timersB = makeTimers();
	const a = makeLease(file, "host-a", clock, timersA, OPTS);
	const b = makeLease(file, "host-b", clock, timersB, OPTS);

	assert.equal(await a.acquire(), true);
	const tokenA = (await readLease(file)).token;
	clock.advance(STALE * 2);
	assert.equal(await b.acquire(), true);
	assert.equal(b.isOwner, true);
	const tokenB = (await readLease(file)).token;
	assert.notEqual(tokenB, tokenA);

	await timersA.tick();
	assert.equal(a.isOwner, false, "the paused owner notices the takeover");
	assert.equal(timersA.active().length, 0, "the paused owner stops its heartbeat");

	await a.release();
	assert.equal(await exists(file), true, "a former owner does not delete the lease");
	assert.equal((await readLease(file)).token, tokenB);

	await timersB.tick();
	assert.equal((await readLease(file)).token, tokenB, "the new owner keeps renewing");
	await b.release();
	assert.equal(await exists(file), false);
});

test("a non-owner cannot release or overwrite a live lease", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const clock = makeClock();
	const timersA = makeTimers();
	const timersB = makeTimers();
	const a = makeLease(file, "host-a", clock, timersA, OPTS);
	const b = makeLease(file, "host-b", clock, timersB, OPTS);

	assert.equal(await a.acquire(), true);
	const tokenA = (await readLease(file)).token;

	assert.equal(await b.acquire(), false);
	assert.equal(b.isOwner, false);
	await b.release();
	assert.equal(await exists(file), true);
	assert.equal((await readLease(file)).token, tokenA);
	await timersB.tick();

	await timersA.tick();
	assert.equal(a.isOwner, true, "the owner still renews after a failed contender");
	assert.equal((await readLease(file)).token, tokenA);
	await a.release();
});

test("heartbeats keep the lease fresh beyond staleMs", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const clock = makeClock();
	const timersA = makeTimers();
	const timersB = makeTimers();
	const a = makeLease(file, "host-a", clock, timersA, OPTS);
	const b = makeLease(file, "host-b", clock, timersB, OPTS);

	assert.equal(await a.acquire(), true);
	const firstRenewed = (await readLease(file)).renewedAt;
	for (let i = 0; i < 10; i++) {
		clock.advance(HEARTBEAT);
		await timersA.tick();
	}
	assert.ok(clock.time - firstRenewed > STALE, "more than staleMs elapsed");
	assert.equal((await readLease(file)).renewedAt, clock.time, "the last beat is on disk");
	assert.equal(await b.acquire(), false, "a renewed lease is not stale");
	assert.equal(a.isOwner, true);
	await a.dispose();
});

test("a heartbeat never rewrites or deletes another owner's lease", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const clock = makeClock();
	const timersA = makeTimers();
	const a = makeLease(file, "host-a", clock, timersA, OPTS);

	assert.equal(await a.acquire(), true);
	await timersA.tick();
	const foreign = {
		ownerId: "host-b",
		token: "foreign-token",
		pid: 2,
		acquiredAt: clock.time,
		renewedAt: clock.time + STALE
	};
	await fsp.writeFile(file, JSON.stringify(foreign));

	await timersA.tick();
	assert.equal(a.isOwner, false, "the heartbeat detects the foreign token");
	assert.equal(timersA.active().length, 0, "the heartbeat stops");
	assert.deepEqual(await readLease(file), foreign, "the foreign lease is untouched");
	await a.release();
	assert.deepEqual(await readLease(file), foreign);
});

test("release lets another owner in immediately and reacquire rotates the token", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const clock = makeClock();
	const timersA = makeTimers();
	const timersB = makeTimers();
	const a = makeLease(file, "host-a", clock, timersA, OPTS);
	const b = makeLease(file, "host-b", clock, timersB, OPTS);

	assert.equal(await a.acquire(), true);
	const tokenA = (await readLease(file)).token;
	await a.release();
	assert.equal(await exists(file), false);

	assert.equal(await b.acquire(), true, "a free lease is available without waiting for staleMs");
	assert.equal((await readLease(file)).ownerId, "host-b");
	await b.release();

	assert.equal(await a.acquire(), true);
	const tokenA2 = (await readLease(file)).token;
	assert.notEqual(tokenA2, tokenA, "reacquire gets a fresh token");
	assert.equal((await readLease(file)).ownerId, "host-a");
	await a.release();
});

test("dispose stops the heartbeat and releases only its own lease", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const clock = makeClock();
	const timersA = makeTimers();
	const owner = makeLease(file, "host-a", clock, timersA, OPTS);

	assert.equal(await owner.acquire(), true);
	assert.equal(timersA.active().length, 1);
	const token = (await readLease(file)).token;

	const bystander = makeLease(file, "host-b", clock, makeTimers(), OPTS);
	await bystander.dispose();
	assert.equal(await exists(file), true, "disposing a non-owner keeps the lease");
	assert.equal((await readLease(file)).token, token);

	await owner.dispose();
	assert.equal(owner.isOwner, false);
	assert.equal(timersA.active().length, 0);
	assert.equal(await exists(file), false);
	await owner.dispose();
	assert.equal(await owner.acquire(), false, "a disposed lease never reacquires");
	assert.equal(await exists(file), false);
});

test("dispose during acquire leaves no lease behind", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const clock = makeClock();
	const timers = makeTimers();
	const lease = makeLease(file, "host-a", clock, timers, OPTS);

	let openGate;
	const gate = new Promise((resolve) => { openGate = resolve; });
	let atGate;
	const reached = new Promise((resolve) => { atGate = resolve; });
	const realCreate = lease._createExclusive.bind(lease);
	let gated = false;
	lease._createExclusive = async (record) => {
		if (!gated) {
			gated = true;
			atGate();
			await gate;
		}
		return realCreate(record);
	};

	const acquiring = lease.acquire();
	await reached;
	await lease.dispose();
	openGate();

	assert.equal(await acquiring, false, "an acquire racing dispose loses");
	assert.equal(lease.isOwner, false);
	assert.equal(timers.active().length, 0);
	assert.equal(await exists(file), false, "the unwritten lease is discarded");
});

test("a removed storage directory is recreated on the next attempt", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const clock = makeClock();
	const lease = makeLease(file, "host-a", clock, makeTimers(), OPTS);

	assert.equal(await lease.acquire(), true);
	await lease.release();
	await fsp.rm(dir, { recursive: true, force: true });

	assert.equal(await lease.acquire(), false, "the attempt that hit the vanished directory fails");
	assert.equal(await lease.acquire(), true, "the retry recreates the directory");
	assert.equal((await readLease(file)).ownerId, "host-a");
	await lease.release();
});

test("corrupt leases block takeover until their mtime is stale", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const clock = makeClock();
	const timers = makeTimers();
	const lease = makeLease(file, "host-b", clock, timers, OPTS);

	await fsp.writeFile(file, "{ this is not json");
	const fresh = new Date(clock.time - STALE / 2);
	await fsp.utimes(file, fresh, fresh);
	assert.equal(await lease.acquire(), false, "a fresh unreadable lease is held");
	assert.equal(lease.isOwner, false);

	const stale = new Date(clock.time - STALE * 2);
	await fsp.utimes(file, stale, stale);
	assert.equal(await lease.acquire(), true, "an aged unreadable lease is reclaimed");
	assert.equal((await readLease(file)).ownerId, "host-b");
	await lease.release();

	assert.equal(await lease.acquire(), true, "a missing lease is a normal acquisition");
	await lease.release();
});

test("only a stale mutex directory is reclaimed", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "lease.json");
	const lockPath = `${file}.lock`;
	const clock = makeClock();
	const timers = makeTimers();
	const lease = makeLease(file, "host-b", clock, timers, { ...OPTS, lockStaleMs: 500 });

	await writeStaleLease(file, clock);
	await fsp.mkdir(lockPath);
	await fsp.utimes(lockPath, new Date(clock.time), new Date(clock.time));
	assert.equal(await lease.acquire(), false, "a fresh mutex blocks acquisition");
	assert.equal(lease.isOwner, false);
	assert.equal(await exists(lockPath), true);

	const ancient = new Date(clock.time - STALE * 4);
	await fsp.utimes(lockPath, ancient, ancient);
	clock.advance(STALE * 2);
	assert.equal(await lease.acquire(), true, "an abandoned mutex and stale lease are reclaimed");
	assert.equal((await readLease(file)).ownerId, "host-b");
	assert.equal(await exists(lockPath), false, "the reclaimed mutex is cleaned up");
	await lease.release();
});
