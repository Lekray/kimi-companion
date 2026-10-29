"use strict";

// Offline tests for lib/patch-dist.js: node --test test/patch-dist.test.js
// Real-dist tests copy the installed pristine `.bak-kimi-companion` files into a
// temp directory; the installed extension is only ever read, never written.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const { PatchDistManager, _test } = require(path.join(__dirname, "..", "lib", "patch-dist"));
const { sha256, unitsFingerprint, applyUnits } = _test;

const MANIFEST_PATH = path.join(__dirname, "..", "resources", "patch-manifest.json");
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

function loadExtensionUnits() {
	const originalLoad = Module._load;
	const vscodeStub = {
		env: { language: "en" },
		workspace: { getConfiguration: () => ({ get: (key, def) => def }) },
		MarkdownString: class {},
		ThemeColor: class {}
	};
	Module._load = function (request, ...rest) {
		return request === "vscode" ? vscodeStub : originalLoad.call(this, request, ...rest);
	};
	try {
		const extension = require(path.join(__dirname, "..", "extension.js"));
		return {
			extUnits: extension._test.EXT_UNITS,
			wvUnits: extension._test.WV_UNITS,
			wvUnits084: extension._test.WV_UNITS_084,
			wvUnitsFor: extension._test.wvUnitsFor
		};
	} finally {
		Module._load = originalLoad;
	}
}

const { extUnits: REAL_EXT_UNITS, wvUnits: REAL_WV_UNITS, wvUnits084: REAL_WV_UNITS_084, wvUnitsFor } = loadExtensionUnits();

const SYN_PRIS = {
	"extension.js": "const A = 1;\nconsole.log(A);\n",
	"webview.js": "var B = 2;\nconsole.log(B);\n"
};
const SYN_EXT = [{ marker: "/*KC*/", old: "const A = 1;", repl: "const A = 1; /*KC*/" }];
const SYN_WV = [{ marker: "/*KWV*/", old: "var B = 2;", repl: "var B = 2; /*KWV*/" }];
const SYN_VERSION = "9.9.9";

function tempRoot(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-patch-test-"));
	t.after(() => {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	return root;
}

function syntheticManifest(files = SYN_PRIS, ext = SYN_EXT, wv = SYN_WV, version = SYN_VERSION) {
	const entries = {};
	for (const [name, text] of Object.entries(files)) {
		const units = name === "extension.js" ? ext : wv;
		const patched = applyUnits(text, units, name);
		assert.equal(patched.ok, true, `${name}: test units apply`);
		entries[name] = {
			pristineSha256: sha256(text),
			pristineSize: Buffer.byteLength(text),
			patchedSha256: patched.sha256,
			patchedSize: Buffer.byteLength(patched.text)
		};
	}
	return { schema: 1, unitsSha256: unitsFingerprint(ext, wv), versions: { [version]: { files: entries } } };
}

function setup(t, options = {}) {
	const files = options.files || SYN_PRIS;
	const ext = options.ext || SYN_EXT;
	const wv = options.wv || SYN_WV;
	const version = options.version || SYN_VERSION;
	const patchManifest = options.manifest || syntheticManifest(files, ext, wv, version);
	const root = tempRoot(t);
	const dist = path.join(root, "dist");
	fs.mkdirSync(dist, { recursive: true });
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dist, name), text);
	const backupDir = path.join(root, "backup");
	const args = { extensionPath: root, version, extUnits: ext, wvUnits: wv };
	const manager = (extra = {}) => new PatchDistManager({ backupDir, manifest: patchManifest, ...extra });
	return { root, dist, backupDir, args, manifest: patchManifest, manager, ext, wv, version };
}

function hashOf(dir, name) {
	return sha256(fs.readFileSync(path.join(dir, name)));
}

function readText(dir, name) {
	return fs.readFileSync(path.join(dir, name), "utf8");
}

function writeText(dir, name, text) {
	fs.writeFileSync(path.join(dir, name), text);
}

async function waitForFile(filePath, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(filePath)) return true;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	return false;
}

function slowFs(ms) {
	const promises = new Proxy(fs.promises, {
		get(target, property) {
			const value = target[property];
			if (property !== "readFile" || typeof value !== "function") {
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (...args) => {
				const result = await value.apply(target, args);
				await new Promise((resolve) => setTimeout(resolve, ms));
				return result;
			};
		}
	});
	return new Proxy(fs, {
		get(target, property) {
			if (property === "promises") return promises;
			const value = target[property];
			return typeof value === "function" ? value.bind(target) : value;
		}
	});
}

function failingFs(failPath, beforeFail) {
	const resolved = path.resolve(failPath);
	const promises = new Proxy(fs.promises, {
		get(target, property) {
			if (property === "rename") {
				return async (from, to) => {
					if (path.resolve(to) === resolved) {
						if (beforeFail) await beforeFail(from, to);
						const err = new Error(`injected rename failure for ${to}`);
						err.code = "EIO";
						throw err;
					}
					return target.rename(from, to);
				};
			}
			const value = target[property];
			return typeof value === "function" ? value.bind(target) : value;
		}
	});
	return new Proxy(fs, {
		get(target, property) {
			if (property === "promises") return promises;
			const value = target[property];
			return typeof value === "function" ? value.bind(target) : value;
		}
	});
}

test("production manifest matches the patch units selected per version and hashes every version", () => {
	assert.equal(manifest.schema, 1);
	assert.equal(manifest.unitsSha256, unitsFingerprint(REAL_EXT_UNITS, REAL_WV_UNITS));
	for (const version of ["0.8.2", "0.8.3", "0.8.4"]) {
		assert.ok(manifest.versions[version], `${version} is covered`);
		const declared = manifest.versions[version].unitsSha256 ?? manifest.unitsSha256;
		assert.equal(
			declared,
			unitsFingerprint(REAL_EXT_UNITS, wvUnitsFor(version)),
			`${version} declares the fingerprint of the units selected for it`
		);
		for (const name of ["extension.js", "webview.js"]) {
			const entry = manifest.versions[version].files[name];
			assert.match(entry.pristineSha256, /^[a-f0-9]{64}$/);
			assert.match(entry.patchedSha256, /^[a-f0-9]{64}$/);
			assert.ok(Number.isInteger(entry.pristineSize) && entry.pristineSize > 0);
			assert.ok(Number.isInteger(entry.patchedSize) && entry.patchedSize > 0);
		}
	}
	assert.equal(manifest.versions["0.8.4"].unitsSha256, "5e55fb69f7c83620a532fd3e6e88e9e41304a324f000b7812eedb85e36f70c4e");
	assert.equal(REAL_WV_UNITS_084[0].old, "const Ve=new zie,IC=[");
	assert.notEqual(REAL_WV_UNITS_084[0].old, REAL_WV_UNITS[0].old);
	assert.equal(wvUnitsFor("0.8.4"), REAL_WV_UNITS_084);
	assert.equal(wvUnitsFor("0.8.3"), REAL_WV_UNITS);
	assert.equal(wvUnitsFor("0.8.2"), REAL_WV_UNITS);
});

test("a stale units fingerprint refuses installation before any write", async (t) => {
	const stale = syntheticManifest();
	stale.unitsSha256 = "0".repeat(64);
	const db = setup(t, { manifest: stale });
	const before = { ext: hashOf(db.dist, "extension.js"), wv: hashOf(db.dist, "webview.js") };
	const manager = db.manager();
	const check = await manager.check(db.args);
	assert.equal(check.canInstall, false);
	assert.ok(check.issues.some((item) => item.code === "manifest-mismatch"));
	const installed = await manager.install(db.args);
	assert.equal(installed.ok, false);
	assert.equal(installed.changed, false);
	assert.equal(hashOf(db.dist, "extension.js"), before.ext);
	assert.equal(hashOf(db.dist, "webview.js"), before.wv);
});

test("a version entry may override the manifest-wide units fingerprint", async (t) => {
	const units = unitsFingerprint(SYN_EXT, SYN_WV);

	const fallback = setup(t);
	const fallbackReport = await fallback.manager().check(fallback.args);
	assert.equal(fallbackReport.units.manifest, units, "an entry without its own fingerprint uses the manifest-wide one");
	assert.equal(fallbackReport.units.matches, true);
	assert.equal(fallbackReport.canInstall, true);

	const override = syntheticManifest();
	override.unitsSha256 = "0".repeat(64);
	override.versions[SYN_VERSION].unitsSha256 = units;
	const db = setup(t, { manifest: override });
	const report = await db.manager().check(db.args);
	assert.equal(report.units.manifest, units, "the entry-level fingerprint wins over the stale manifest-wide one");
	assert.equal(report.units.matches, true);
	assert.equal(report.ok, true);
	assert.equal(report.canInstall, true);
	const installed = await db.manager().install(db.args);
	assert.equal(installed.ok, true);
	assert.equal(installed.state, "patched");
	assert.equal(installed.changed, true);
	assert.equal(
		hashOf(db.dist, "extension.js"),
		override.versions[SYN_VERSION].files["extension.js"].patchedSha256
	);

	const stale = syntheticManifest();
	stale.versions[SYN_VERSION].unitsSha256 = "1".repeat(64);
	const staleDb = setup(t, { manifest: stale });
	const staleReport = await staleDb.manager().check(staleDb.args);
	assert.equal(staleReport.units.manifest, "1".repeat(64), "an entry-level fingerprint is not replaced by the manifest-wide one");
	assert.equal(staleReport.units.matches, false);
	assert.equal(staleReport.canInstall, false);
	assert.ok(staleReport.issues.some((item) => item.code === "manifest-mismatch"));
	const staleInstall = await staleDb.manager().install(staleDb.args);
	assert.equal(staleInstall.ok, false);
	assert.equal(staleInstall.changed, false);
	assert.equal(
		hashOf(staleDb.dist, "extension.js"),
		stale.versions[SYN_VERSION].files["extension.js"].pristineSha256
	);
});

test("install is transactional and idempotent; restore returns the exact pristine bytes", async (t) => {
	const db = setup(t);
	const pristine = {
		ext: fs.readFileSync(path.join(db.dist, "extension.js")),
		wv: fs.readFileSync(path.join(db.dist, "webview.js"))
	};
	const manager = db.manager();

	const first = await manager.check(db.args);
	assert.equal(first.ok, true);
	assert.equal(first.state, "original");
	assert.equal(first.canInstall, true);
	assert.equal(first.canRestore, false);

	const installed = await manager.install(db.args);
	assert.equal(installed.ok, true);
	assert.equal(installed.state, "patched");
	assert.equal(installed.changed, true);
	assert.equal(hashOf(db.dist, "extension.js"), db.manifest.versions[db.version].files["extension.js"].patchedSha256);
	assert.equal(hashOf(db.dist, "webview.js"), db.manifest.versions[db.version].files["webview.js"].patchedSha256);

	const metaFile = path.join(db.backupDir, db.version, "backup.json");
	const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
	assert.equal(meta.version, db.version);
	assert.equal(meta.files["extension.js"].sha256, db.manifest.versions[db.version].files["extension.js"].pristineSha256);
	assert.equal(meta.files["webview.js"].sha256, db.manifest.versions[db.version].files["webview.js"].pristineSha256);
	assert.equal(hashOf(path.join(db.backupDir, db.version), "extension.js"), meta.files["extension.js"].sha256);

	const again = await manager.install(db.args);
	assert.equal(again.ok, true);
	assert.equal(again.state, "patched");
	assert.equal(again.changed, false);

	const restored = await manager.restore(db.args);
	assert.equal(restored.ok, true);
	assert.equal(restored.state, "original");
	assert.equal(restored.changed, true);
	assert.deepEqual(fs.readFileSync(path.join(db.dist, "extension.js")), pristine.ext);
	assert.deepEqual(fs.readFileSync(path.join(db.dist, "webview.js")), pristine.wv);

	const noop = await manager.restore(db.args);
	assert.equal(noop.ok, true);
	assert.equal(noop.changed, false);
});

test("a patched dist is recognized by applying the units to manifest-verified pristine", async (t) => {
	const db = setup(t);
	const pristine = {};
	for (const name of ["extension.js", "webview.js"]) pristine[name] = fs.readFileSync(path.join(db.dist, name));
	await db.manager().install(db.args);
	for (const name of ["extension.js", "webview.js"]) {
		fs.writeFileSync(path.join(db.dist, `${name}.bak-kimi-companion`), pristine[name]);
	}
	fs.rmSync(db.backupDir, { recursive: true, force: true });

	const report = await db.manager().check(db.args);
	assert.equal(report.ok, true);
	assert.equal(report.state, "patched");
	assert.equal(report.canInstall, true);
	assert.equal(report.canRestore, true);
	assert.equal(report.backup.source, "legacy");
	assert.equal(report.files["extension.js"].status, "patched");
	assert.equal(report.files["webview.js"].status, "patched");

	const restored = await db.manager().restore(db.args);
	assert.equal(restored.ok, true);
	assert.equal(restored.state, "original");
	assert.equal(readText(db.dist, "extension.js"), SYN_PRIS["extension.js"]);
	assert.equal(readText(db.dist, "webview.js"), SYN_PRIS["webview.js"]);
	assert.ok(fs.existsSync(path.join(db.backupDir, db.version, "backup.json")));
});

test("legacy .bak files are migrated only when their pristine hash verifies", async (t) => {
	const valid = setup(t);
	for (const name of ["extension.js", "webview.js"]) {
		fs.copyFileSync(path.join(valid.dist, name), path.join(valid.dist, `${name}.bak-kimi-companion`));
	}
	const check = await valid.manager().check(valid.args);
	assert.equal(check.backup.source, "legacy");
	assert.equal(check.canInstall, true);

	const installed = await valid.manager().install(valid.args);
	assert.equal(installed.ok, true);
	assert.equal(installed.backup.migrated, true);
	assert.equal(installed.backup.valid, true);
	assert.ok(fs.existsSync(path.join(valid.backupDir, valid.version, "backup.json")));

	const invalid = setup(t);
	writeText(invalid.dist, "extension.js.bak-kimi-companion", "not the pristine file\n");
	writeText(invalid.dist, "webview.js.bak-kimi-companion", "also not pristine\n");
	const invalidCheck = await invalid.manager().check(invalid.args);
	assert.equal(invalidCheck.state, "original");
	assert.equal(invalidCheck.canInstall, true);
	assert.equal(invalidCheck.backup.valid, false);
	assert.ok(invalidCheck.issues.some((item) => item.code === "legacy-invalid"));

	const invalidInstalled = await invalid.manager().install(invalid.args);
	assert.equal(invalidInstalled.ok, true);
	assert.equal(invalidInstalled.backup.migrated, false);
	assert.equal(readText(invalid.dist, "extension.js.bak-kimi-companion"), "not the pristine file\n");
	assert.equal(
		hashOf(path.join(invalid.backupDir, invalid.version), "extension.js"),
		invalid.manifest.versions[invalid.version].files["extension.js"].pristineSha256
	);
});

test("unknown versions, missing anchors, foreign bytes and unproven partials are refused without writes", async (t) => {
	const unknown = setup(t);
	const unknownReport = await unknown.manager().check({ ...unknown.args, version: "1.0.0" });
	assert.equal(unknownReport.ok, false);
	assert.equal(unknownReport.state, "unknown");
	assert.equal(unknownReport.canInstall, false);
	const unknownInstall = await unknown.manager().install({ ...unknown.args, version: "1.0.0" });
	assert.equal(unknownInstall.ok, false);
	assert.ok(unknownInstall.issues.some((item) => item.code === "version-unknown"));
	assert.equal(readText(unknown.dist, "extension.js"), SYN_PRIS["extension.js"]);
	assert.equal(fs.existsSync(path.join(unknown.backupDir, "1.0.0")), false);

	const missing = setup(t);
	const missingUnits = [{ marker: "/*KX*/", old: "const A = 2;", repl: "const A = 2; /*KX*/" }];
	const missingReport = await missing.manager().check({ ...missing.args, extUnits: missingUnits });
	assert.equal(missingReport.state, "original");
	assert.equal(missingReport.canInstall, false);
	assert.ok(missingReport.issues.some((item) => item.code === "anchor-missing"));
	const missingInstall = await missing.manager().install({ ...missing.args, extUnits: missingUnits });
	assert.equal(missingInstall.ok, false);
	assert.equal(readText(missing.dist, "extension.js"), SYN_PRIS["extension.js"]);
	assert.equal(fs.existsSync(path.join(missing.backupDir, missing.version)), false);

	const foreign = setup(t);
	writeText(foreign.dist, "extension.js", "const A = 1; // edited by hand\nconsole.log(A);\n");
	const foreignReport = await foreign.manager().check(foreign.args);
	assert.equal(foreignReport.state, "foreign");
	assert.equal(foreignReport.canInstall, false);
	assert.equal(foreignReport.canRestore, false);
	const foreignInstall = await foreign.manager().install(foreign.args);
	assert.equal(foreignInstall.ok, false);
	const foreignRestore = await foreign.manager().restore(foreign.args);
	assert.equal(foreignRestore.ok, false);
	assert.equal(readText(foreign.dist, "extension.js"), "const A = 1; // edited by hand\nconsole.log(A);\n");

	const partial = setup(t);
	const patched = applyUnits(SYN_PRIS["extension.js"], SYN_EXT, "extension.js");
	assert.equal(patched.ok, true);
	writeText(partial.dist, "extension.js", `${patched.text}// foreign tail\n`);
	const partialReport = await partial.manager().check(partial.args);
	assert.equal(partialReport.state, "partial");
	assert.equal(partialReport.canInstall, false);
	assert.equal(partialReport.canRestore, false);
	assert.ok(partialReport.issues.some((item) => item.code === "predecessor-unproven"));
	const partialInstall = await partial.manager().install(partial.args);
	assert.equal(partialInstall.ok, false);
	assert.equal(readText(partial.dist, "extension.js"), `${patched.text}// foreign tail\n`);

	const gone = setup(t);
	fs.rmSync(path.join(gone.dist, "webview.js"));
	const goneReport = await gone.manager().check(gone.args);
	assert.equal(goneReport.state, "foreign");
	assert.equal(goneReport.canInstall, false);
	assert.equal(goneReport.files["webview.js"].status, "missing");
});

test("a partial state with one patched file can be completed without a backup", async (t) => {
	const db = setup(t);
	await db.manager().install(db.args);
	writeText(db.dist, "webview.js", SYN_PRIS["webview.js"]);
	fs.rmSync(db.backupDir, { recursive: true, force: true });

	const report = await db.manager().check(db.args);
	assert.equal(report.state, "partial");
	assert.equal(report.canInstall, true);
	assert.equal(report.canRestore, false);
	assert.ok(report.issues.some((item) => item.code === "backup-missing"));

	const installed = await db.manager().install(db.args);
	assert.equal(installed.ok, true);
	assert.equal(installed.state, "patched");
	assert.equal(installed.changed, true);
	assert.equal(installed.canRestore, false);
	assert.equal(hashOf(db.dist, "webview.js"), db.manifest.versions[db.version].files["webview.js"].patchedSha256);
});

test("a partial state proven by the backup can be completed or restored", async (t) => {
	const db = setup(t);
	await db.manager().install(db.args);
	writeText(db.dist, "webview.js", SYN_PRIS["webview.js"]);

	const report = await db.manager().check(db.args);
	assert.equal(report.state, "partial");
	assert.equal(report.canInstall, true);
	assert.equal(report.canRestore, true);

	const restored = await db.manager().restore(db.args);
	assert.equal(restored.ok, true);
	assert.equal(restored.state, "original");
	assert.deepEqual(readText(db.dist, "extension.js"), SYN_PRIS["extension.js"]);
	assert.deepEqual(readText(db.dist, "webview.js"), SYN_PRIS["webview.js"]);
});

test("a partial state with unknown edits is refused even when a backup exists", async (t) => {
	const db = setup(t);
	await db.manager().install(db.args);
	const edited = `${readText(db.dist, "extension.js")}// foreign tail\n`;
	writeText(db.dist, "extension.js", edited);

	const report = await db.manager().check(db.args);
	assert.equal(report.state, "partial");
	assert.equal(report.canInstall, false);
	assert.equal(report.canRestore, false);
	assert.ok(report.issues.some((item) => item.code === "predecessor-unproven"));

	const installed = await db.manager().install(db.args);
	assert.equal(installed.ok, false);
	const restored = await db.manager().restore(db.args);
	assert.equal(restored.ok, false);
	assert.equal(readText(db.dist, "extension.js"), edited);
});

test("corrupt backups are reported as backup-invalid and cannot be restored", async (t) => {
	const brokenFile = setup(t);
	await brokenFile.manager().install(brokenFile.args);
	writeText(path.join(brokenFile.backupDir, brokenFile.version), "extension.js", "corrupt\n");
	const report = await brokenFile.manager().check(brokenFile.args);
	assert.equal(report.state, "backup-invalid");
	assert.equal(report.canInstall, true, "already patched, so a no-op install is still possible");
	assert.equal(report.canRestore, false);
	assert.ok(report.issues.some((item) => item.code === "backup-invalid"));
	assert.doesNotMatch(report.issues.join("; "), /\[object Object\]/);
	const restore = await brokenFile.manager().restore(brokenFile.args);
	assert.equal(restore.ok, false);
	assert.equal(restore.state, "backup-invalid");

	const brokenMeta = setup(t);
	await brokenMeta.manager().install(brokenMeta.args);
	writeText(path.join(brokenMeta.backupDir, brokenMeta.version), "backup.json", "{not json");
	const metaReport = await brokenMeta.manager().check(brokenMeta.args);
	assert.equal(metaReport.state, "backup-invalid");
	assert.equal(metaReport.canRestore, false);

	const pristine = setup(t);
	fs.mkdirSync(path.join(pristine.backupDir, pristine.version), { recursive: true });
	writeText(path.join(pristine.backupDir, pristine.version), "backup.json", "garbage\n");
	writeText(path.join(pristine.backupDir, pristine.version), "extension.js", "garbage\n");
	const pristineReport = await pristine.manager().check(pristine.args);
	assert.equal(pristineReport.state, "original");
	assert.equal(pristineReport.canInstall, true);
	assert.equal(pristineReport.ok, true, "a stale backup is only a warning for a pristine dist");
	const repaired = await pristine.manager().install(pristine.args);
	assert.equal(repaired.ok, true);
	assert.equal(repaired.backup.valid, true);
	assert.equal(hashOf(pristine.dist, "extension.js"), pristine.manifest.versions[pristine.version].files["extension.js"].patchedSha256);
});

test("concurrent installs are serialized by the lock file", async (t) => {
	const db = setup(t);
	const lock = path.join(db.backupDir, ".kimi-companion-patch.lock");
	const first = db.manager({ fs: slowFs(40) });
	const second = db.manager({ lockTimeoutMs: 5000, lockRetryMs: 5 });
	const firstRun = first.install(db.args);
	assert.equal(await waitForFile(lock), true, "the first install holds the lock");
	const [a, b] = await Promise.all([firstRun, second.install(db.args)]);
	assert.equal(a.ok, true);
	assert.equal(a.state, "patched");
	assert.equal(a.changed, true);
	assert.equal(b.ok, true);
	assert.equal(b.state, "patched");
	assert.equal(b.changed, false);
	assert.ok(!b.issues.some((item) => item.code === "locked"), "the waiter is not reported as busy");
	assert.equal(fs.existsSync(lock), false, "both installs released the lock");

	const after = await db.manager().install(db.args);
	assert.equal(after.ok, true);
	assert.equal(after.state, "patched");
	assert.equal(after.changed, false);
	assert.equal(hashOf(db.dist, "extension.js"), db.manifest.versions[db.version].files["extension.js"].patchedSha256);
});

test("an install waits for a held lock instead of reporting busy", async (t) => {
	const db = setup(t);
	fs.mkdirSync(db.backupDir, { recursive: true });
	const lock = path.join(db.backupDir, ".kimi-companion-patch.lock");
	fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, token: "holder", at: new Date().toISOString() }));
	const started = Date.now();
	const pending = db.manager({ lockTimeoutMs: 5000, lockRetryMs: 5 }).install(db.args);
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(fs.existsSync(lock), true, "the foreign lock is still held");
	fs.rmSync(lock);
	const installed = await pending;
	assert.equal(installed.ok, true);
	assert.equal(installed.state, "patched");
	assert.equal(installed.changed, true);
	assert.ok(Date.now() - started >= 150);
});

test("a lock that is never released times out as busy", async (t) => {
	const db = setup(t);
	fs.mkdirSync(db.backupDir, { recursive: true });
	const lock = path.join(db.backupDir, ".kimi-companion-patch.lock");
	const holder = JSON.stringify({ pid: process.ppid, token: "holder", at: new Date().toISOString() });
	fs.writeFileSync(lock, holder);
	const started = Date.now();
	const report = await db.manager({ lockTimeoutMs: 120, lockRetryMs: 10 }).install(db.args);
	assert.equal(report.ok, false);
	assert.equal(report.state, "busy");
	assert.ok(report.issues.some((item) => item.code === "locked"));
	assert.match(report.issues.join("; "), /locked by another process/);
	assert.ok(Date.now() - started >= 100);
	assert.equal(readText(db.dist, "extension.js"), SYN_PRIS["extension.js"]);
	assert.equal(fs.readFileSync(lock, "utf8"), holder, "the foreign lock is left intact");
	assert.equal(fs.existsSync(path.join(db.backupDir, db.version)), false);
});

test("a stale lock left by this process is removed", async (t) => {
	const db = setup(t);
	fs.mkdirSync(db.backupDir, { recursive: true });
	const lock = path.join(db.backupDir, ".kimi-companion-patch.lock");
	fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "stale", at: new Date(0).toISOString() }));
	fs.utimesSync(lock, new Date(0), new Date(0));
	const installed = await db.manager().install(db.args);
	assert.equal(installed.ok, true);
	assert.equal(installed.state, "patched");
});

test("an expired lock is reclaimed even when its foreign PID is still alive", async (t) => {
	const db = setup(t);
	fs.mkdirSync(db.backupDir, { recursive: true });
	const lock = path.join(db.backupDir, ".kimi-companion-patch.lock");
	fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, token: "stale", at: new Date(0).toISOString() }));
	fs.utimesSync(lock, new Date(0), new Date(0));
	const installed = await db.manager({ lockStaleMs: 20 }).install(db.args);
	assert.equal(installed.ok, true);
	assert.equal(installed.state, "patched");
});

test("a failed write is rolled back to the exact prior bytes", async (t) => {
	const db = setup(t);
	const pristine = {
		ext: fs.readFileSync(path.join(db.dist, "extension.js")),
		wv: fs.readFileSync(path.join(db.dist, "webview.js"))
	};
	const manager = db.manager({ fs: failingFs(path.join(db.dist, "webview.js")) });
	const report = await manager.install(db.args);
	assert.equal(report.ok, false);
	assert.equal(report.state, "original");
	assert.equal(report.rollback.ok, true);
	assert.ok(report.issues.some((item) => item.code === "write-failed"));
	assert.deepEqual(fs.readFileSync(path.join(db.dist, "extension.js")), pristine.ext);
	assert.deepEqual(fs.readFileSync(path.join(db.dist, "webview.js")), pristine.wv);
	assert.deepEqual(
		fs.readdirSync(db.dist).filter((name) => name.includes(".kc-")),
		[]
	);

	const installed = await db.manager().install(db.args);
	assert.equal(installed.ok, true);
	assert.equal(installed.state, "patched");
});

test("a failed backup write aborts before touching the dist", async (t) => {
	const db = setup(t);
	const pristine = fs.readFileSync(path.join(db.dist, "extension.js"));
	const manager = db.manager({ fs: failingFs(path.join(db.backupDir, db.version, "webview.js")) });
	const report = await manager.install(db.args);
	assert.equal(report.ok, false);
	assert.equal(report.state, "original");
	assert.ok(report.issues.some((item) => item.code === "backup-write-failed"));
	assert.deepEqual(fs.readFileSync(path.join(db.dist, "extension.js")), pristine);
	assert.equal(fs.existsSync(path.join(db.backupDir, db.version, "backup.json")), false);

	const installed = await db.manager().install(db.args);
	assert.equal(installed.ok, true);
	assert.equal(installed.state, "patched");
});

test("rollback does not overwrite a foreign change made after our write", async (t) => {
	const db = setup(t);
	const foreignText = "const A = 99; // foreign change\n";
	const proxy = failingFs(path.join(db.dist, "webview.js"), async () => {
		await fs.promises.writeFile(path.join(db.dist, "extension.js"), foreignText);
	});
	const report = await db.manager({ fs: proxy }).install(db.args);
	assert.equal(report.ok, false);
	assert.equal(report.rollback.ok, false);
	assert.deepEqual(report.rollback.foreign, ["extension.js"]);
	assert.ok(report.issues.some((item) => item.code === "rollback-skipped-foreign"));
	assert.equal(readText(db.dist, "extension.js"), foreignText);
	assert.equal(readText(db.dist, "webview.js"), SYN_PRIS["webview.js"]);
});

test("the parse check rejects a broken replacement before any write", async (t) => {
	const badUnits = [{ marker: "/*BAD*/", old: "const A = 1;", repl: "const A = = 1; /*BAD*/" }];
	const db = setup(t, { ext: badUnits });
	const report = await db.manager().check(db.args);
	assert.equal(report.state, "original");
	assert.equal(report.canInstall, false);
	assert.ok(report.issues.some((item) => item.code === "parse-error"));
	const installed = await db.manager().install(db.args);
	assert.equal(installed.ok, false);
	assert.equal(readText(db.dist, "extension.js"), SYN_PRIS["extension.js"]);
	assert.equal(fs.existsSync(path.join(db.backupDir, db.version)), false);
});

test("the ESM parse path accepts the real extension.js shape", async (t) => {
	const esmFiles = {
		"extension.js": 'import fs from "node:fs";\nconst A = 1;\nconsole.log(A);\n',
		"webview.js": SYN_PRIS["webview.js"]
	};
	const db = setup(t, { files: esmFiles });
	const report = await db.manager().install(db.args);
	assert.equal(report.ok, true);
	assert.equal(report.state, "patched");
	assert.match(readText(db.dist, "extension.js"), /\/\*KC\*\//);
});

function findInstalledDist(version) {
	const candidates = [];
	// Optional escape hatch for a version that is not installed:
	// KIMI_CODE_DIST_0_8_2=/path/to/extension/dist
	const env = process.env[`KIMI_CODE_DIST_${version.replace(/[.-]/g, "_")}`];
	if (env) candidates.push(env);
	const base = path.join(os.homedir(), ".vscode", "extensions");
	try {
		for (const name of fs.readdirSync(base)) {
			if (!name.startsWith("moonshot-ai.kimi-code-")) continue;
			const dir = path.join(base, name);
			try {
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
				if (pkg.version === version) candidates.push(path.join(dir, "dist"));
			} catch {
				// Not an extension directory we can read.
			}
		}
	} catch {
		// VS Code may not be installed.
	}
	for (const dist of candidates) {
		const files = {};
		for (const [name, entry] of Object.entries(manifest.versions[version].files)) {
			for (const candidate of [path.join(dist, `${name}.bak-kimi-companion`), path.join(dist, name)]) {
				try {
					const bytes = fs.readFileSync(candidate);
					if (sha256(bytes) === entry.pristineSha256) {
						files[name] = candidate;
						break;
					}
				} catch {
					// Try the next candidate.
				}
			}
		}
		if (Object.keys(files).length === 2) return { dist, files };
	}
	return null;
}

for (const version of ["0.8.2", "0.8.3", "0.8.4"]) {
	test(`real Kimi Code ${version}: check, install, no-op and restore`, async (t) => {
		const source = findInstalledDist(version);
		if (!source) {
			return t.skip(
				`Kimi Code ${version} pristine dist is not installed or readable; set KIMI_CODE_DIST_${version.replace(/[.-]/g, "_")} to an extracted dist`
			);
		}
		const root = tempRoot(t);
		const dist = path.join(root, "dist");
		fs.mkdirSync(dist, { recursive: true });
		for (const name of ["extension.js", "webview.js"]) {
			fs.copyFileSync(source.files[name], path.join(dist, name));
		}
		const args = { extensionPath: root, version, extUnits: REAL_EXT_UNITS, wvUnits: wvUnitsFor(version) };
		const manager = new PatchDistManager({ backupDir: path.join(root, "backup"), manifest });

		const check = await manager.check(args);
		assert.equal(check.ok, true);
		assert.equal(check.state, "original");
		assert.equal(check.canInstall, true);

		const installed = await manager.install(args);
		assert.equal(installed.ok, true);
		assert.equal(installed.state, "patched");
		for (const [name, entry] of Object.entries(manifest.versions[version].files)) {
			assert.equal(hashOf(dist, name), entry.patchedSha256, `${name} matches the manifest patched hash`);
		}

		const again = await manager.install(args);
		assert.equal(again.ok, true);
		assert.equal(again.changed, false);

		const restored = await manager.restore(args);
		assert.equal(restored.ok, true);
		assert.equal(restored.state, "original");
		for (const [name, entry] of Object.entries(manifest.versions[version].files)) {
			assert.equal(hashOf(dist, name), entry.pristineSha256, `${name} is byte-identical to pristine`);
		}
	});
}

function installedDistDir(version) {
	const base = path.join(os.homedir(), ".vscode", "extensions");
	let names = [];
	try {
		names = fs.readdirSync(base);
	} catch {
		return null;
	}
	for (const name of names) {
		if (!name.startsWith("moonshot-ai.kimi-code-")) continue;
		const dir = path.join(base, name);
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
			if (pkg.version === version) return path.join(dir, "dist");
		} catch {
			// Not an extension directory we can read.
		}
	}
	return null;
}

for (const version of ["0.8.3", "0.8.4"]) {
	test(`real ${version} already-patched dist is recognized without a backup`, async (t) => {
		const installedDist = installedDistDir(version);
		if (!installedDist) return t.skip(`Kimi Code ${version} is not installed`);
		const current = {};
		for (const [name, entry] of Object.entries(manifest.versions[version].files)) {
			const bytes = fs.readFileSync(path.join(installedDist, name));
			if (sha256(bytes) !== entry.patchedSha256) return t.skip(`the installed ${version} dist is not currently patched`);
			current[name] = bytes;
		}
		const root = tempRoot(t);
		const dist = path.join(root, "dist");
		fs.mkdirSync(dist, { recursive: true });
		for (const [name, bytes] of Object.entries(current)) fs.writeFileSync(path.join(dist, name), bytes);

		const args = { extensionPath: root, version, extUnits: REAL_EXT_UNITS, wvUnits: wvUnitsFor(version) };
		const manager = new PatchDistManager({ backupDir: path.join(root, "backup"), manifest });
		const check = await manager.check(args);
		assert.equal(check.ok, true);
		assert.equal(check.state, "patched");
		assert.equal(check.canInstall, true);
		assert.equal(check.canRestore, false, "there is no pristine source to restore from");
		assert.ok(check.issues.some((item) => item.code === "backup-missing"));

		const installed = await manager.install(args);
		assert.equal(installed.ok, true);
		assert.equal(installed.changed, false);
		const restored = await manager.restore(args);
		assert.equal(restored.ok, false);
	});
}

test("install revalidates every target immediately before writing", async (t) => {
	const db = setup(t);
	const promises = new Proxy(fs.promises, {
		get(target, property) {
			if (property === "rename") return async (from, to) => {
				if (path.resolve(to) === path.join(db.dist, "extension.js")) {
					writeText(db.dist, "webview.js", "foreign concurrent edit\n");
				}
				return target.rename(from, to);
			};
			const value = target[property];
			return typeof value === "function" ? value.bind(target) : value;
		}
	});
	const wrapped = new Proxy(fs, {
		get(target, property) {
			if (property === "promises") return promises;
			const value = target[property];
			return typeof value === "function" ? value.bind(target) : value;
		}
	});
	const report = await db.manager({ fs: wrapped }).install(db.args);
	assert.equal(report.ok, false);
	assert.ok(report.issues.some((item) => item.code === "stale-state"));
	assert.equal(readText(db.dist, "extension.js"), SYN_PRIS["extension.js"], "the first write is rolled back");
	assert.equal(readText(db.dist, "webview.js"), "foreign concurrent edit\n", "foreign bytes are preserved");
});
