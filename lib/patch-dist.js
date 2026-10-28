"use strict";

// Transactional patcher for the installed Kimi Code dist.
// Everything here is offline: the only side effects are the backup directory and,
// on install/restore, the two dist files passed in by the caller.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

const MANIFEST_PATH = path.join(__dirname, "..", "resources", "patch-manifest.json");
const SCHEMA = 1;
const LOCK_NAME = ".kimi-companion-patch.lock";
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_TIMEOUT_MS = 30 * 1000;
const LOCK_RETRY_MS = 50;
const LOCK_CONTENDED = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);
const BACKUP_META = "backup.json";
const FILE_SPECS = [
	{ name: "extension.js", units: "ext" },
	{ name: "webview.js", units: "wv" }
];
const PARSE_CACHE_MAX = 16;

const parseCache = new Map();

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(report, code, message, extra = {}, severity = "error") {
	const item = { code, message, severity, ...extra };
	// Callers that only render issues (extension.js joins them into log lines)
	// should get the message, while tests can still inspect code/severity.
	Object.defineProperty(item, "toString", {
		value() {
			return this.message;
		},
		enumerable: false
	});
	report.issues.push(item);
}

function baseReport(version) {
	return {
		ok: false,
		state: "unknown",
		version: version || null,
		canInstall: false,
		canRestore: false,
		issues: [],
		files: {},
		backup: null,
		distDir: null
	};
}

function operationError(message, cause, report) {
	const err = new Error(message, cause ? { cause } : undefined);
	err.code = "KC_OPERATION";
	if (report) err.report = report;
	return err;
}

function lockBusyError() {
	const err = new Error("the patch backup directory is locked by another process");
	err.code = "KC_LOCKED";
	return err;
}

function normalizeUnits(units, label) {
	if (!Array.isArray(units)) throw new TypeError(`${label} must be an array`);
	const seen = new Set();
	return units.map((unit, index) => {
		if (!isObject(unit)) throw new TypeError(`${label}[${index}] must be an object`);
		for (const key of ["marker", "old", "repl"]) {
			if (typeof unit[key] !== "string" || unit[key].length === 0) {
				throw new TypeError(`${label}[${index}].${key} must be a non-empty string`);
			}
		}
		if (seen.has(unit.marker)) throw new TypeError(`${label}: duplicate marker ${unit.marker}`);
		seen.add(unit.marker);
		return { marker: unit.marker, old: unit.old, repl: unit.repl };
	});
}

function unitsFingerprint(extUnits, wvUnits) {
	const canonical = (units) => units.map((unit) => [unit.marker, unit.old, unit.repl]);
	return sha256(JSON.stringify({ ext: canonical(extUnits), wv: canonical(wvUnits) }));
}

// Every unit must apply exactly once, in order. The result carries the SHA-256 of
// each intermediate stage so a file left by an older, non-transactional patcher
// can be classified as a proven partial instead of "foreign".
function applyUnits(source, units, file) {
	let text = source;
	const stages = [sha256(source)];
	const applied = [];
	for (const unit of units) {
		if (text.includes(unit.marker)) {
			return {
				ok: false,
				issue: {
					code: "unit-marker-present",
					message: `${file}: ${unit.marker} is already present in the pristine source`,
					file,
					marker: unit.marker
				}
			};
		}
		const occurrences = text.split(unit.old).length - 1;
		if (occurrences !== 1) {
			return {
				ok: false,
				issue: {
					code: "anchor-missing",
					message: `${file}: anchor for ${unit.marker} found ${occurrences} times, expected exactly once`,
					file,
					marker: unit.marker,
					occurrences
				}
			};
		}
		// A function replacer keeps "$&"-like sequences in the replacement literal.
		text = text.replace(unit.old, () => unit.repl);
		applied.push(unit.marker);
		stages.push(sha256(text));
	}
	return { ok: true, text, sha256: sha256(text), stages, applied };
}

function isModuleError(err) {
	const message = String((err && err.message) || "");
	return (
		message.includes("Cannot use import statement outside a module") ||
		message.includes("Cannot use 'import.meta' outside a module") ||
		message.includes("Unexpected token 'export'") ||
		message.includes("await is only valid in async functions and the top level bodies of modules")
	);
}

// vm.Script cannot parse static imports, and vm.SourceTextModule needs a CLI flag
// that VS Code's extension host does not pass. The 0.8.x extensions are ESM with
// one-line import declarations, one export list, and import.meta; this transform
// keeps line numbers and lets vm.Script check the rest of the file.
function transformEsm(source) {
	return source
		.split(/\r?\n/)
		.map((line) => {
			if (/^\s*import\s[^\n]*;\s*$/.test(line)) return "";
			if (/^\s*export\s*\{[^\n]*\}\s*;?\s*$/.test(line)) return "";
			if (/^\s*export\s+default\s+/.test(line)) {
				return line.replace(/^(\s*)export\s+default\s+/, "$1void ");
			}
			if (/^\s*export\s+(?=(const|let|var|function|class|async)\b)/.test(line)) {
				return line.replace(/^(\s*)export\s+/, "$1");
			}
			return line;
		})
		.join("\n")
		.replace(/\bimport\.meta\b/g, "({})");
}

function parseScript(text, filename, hash = sha256(text)) {
	const key = `${hash}\0${filename}`;
	const cached = parseCache.get(key);
	if (cached) return cached;
	let result;
	try {
		new vm.Script(text, { filename });
		result = { ok: true, mode: "script" };
	} catch (err) {
		if (!isModuleError(err)) {
			result = { ok: false, mode: "script", error: err.message };
		} else {
			const transformed = transformEsm(text);
			try {
				new vm.Script(transformed, { filename });
				result = { ok: true, mode: "esm-transform" };
			} catch (first) {
				try {
					new vm.Script(`(async () => {\n${transformed}\n})();`, { filename });
					result = { ok: true, mode: "esm-transform-async" };
				} catch {
					result = { ok: false, mode: "esm-transform", error: first.message };
				}
			}
		}
	}
	if (parseCache.size >= PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value);
	parseCache.set(key, result);
	return result;
}

async function renameWithRetry(io, from, to) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await io.promises.rename(from, to);
		} catch (err) {
			const retryable = err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES");
			if (!retryable || attempt >= 2) throw err;
			await delay(40 * (attempt + 1));
		}
	}
}

async function atomicWrite(io, filePath, bytes, mode = 0o644) {
	const dir = path.dirname(filePath);
	const tmp = path.join(dir, `.${path.basename(filePath)}.kc-${process.pid}-${crypto.randomUUID()}.tmp`);
	let handle = null;
	try {
		handle = await io.promises.open(tmp, "wx", mode);
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = null;
		await renameWithRetry(io, tmp, filePath);
		try {
			const dirHandle = await io.promises.open(dir, "r");
			try {
				await dirHandle.sync();
			} finally {
				await dirHandle.close();
			}
		} catch {
			// Directory fsync is a POSIX nicety; Windows cannot sync a directory handle.
		}
	} catch (err) {
		if (handle) {
			try {
				await handle.close();
			} catch {
				// ignore
			}
		}
		try {
			await io.promises.unlink(tmp);
		} catch {
			// ignore
		}
		throw err;
	}
}

class PatchDistManager {
	constructor(options = {}) {
		if (!options || typeof options.backupDir !== "string" || options.backupDir.length === 0) {
			throw new TypeError("backupDir is required");
		}
		this.backupDir = path.resolve(options.backupDir);
		this.io = options.fs || fs;
		this.lockStaleMs = Number.isFinite(options.lockStaleMs) ? options.lockStaleMs : LOCK_STALE_MS;
		this.lockTimeoutMs = Number.isFinite(options.lockTimeoutMs) ? options.lockTimeoutMs : LOCK_TIMEOUT_MS;
		this.lockRetryMs = Number.isFinite(options.lockRetryMs) ? options.lockRetryMs : LOCK_RETRY_MS;
		this.manifestPath = options.manifestPath || MANIFEST_PATH;
		this.manifest = null;
		this.manifestError = null;
		if (isObject(options.manifest)) {
			this.manifest = options.manifest;
		} else {
			try {
				this.manifest = JSON.parse(this.io.readFileSync(this.manifestPath, "utf8"));
			} catch (err) {
				this.manifestError = err;
			}
		}
	}

	async check(args) {
		return this.#run("check", args);
	}

	async install(args) {
		return this.#withLock("install", args);
	}

	async restore(args) {
		return this.#withLock("restore", args);
	}

	#validateArgs(args) {
		if (!isObject(args)) throw new TypeError("check/install/restore require an arguments object");
		if (typeof args.extensionPath !== "string" || args.extensionPath.length === 0) {
			throw new TypeError("extensionPath is required");
		}
		if (typeof args.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(args.version)) {
			throw new TypeError(`invalid version: ${args.version}`);
		}
		const extUnits = normalizeUnits(args.extUnits, "extUnits");
		const wvUnits = normalizeUnits(args.wvUnits, "wvUnits");
		const extensionPath = path.resolve(args.extensionPath);
		const distDir = path.basename(extensionPath) === "dist" ? extensionPath : path.join(extensionPath, "dist");
		return {
			args,
			version: args.version,
			extensionPath,
			distDir,
			units: { ext: extUnits, wv: wvUnits }
		};
	}

	#manifestEntry(version, report) {
		if (this.manifestError) {
			issue(report, "manifest-invalid", `cannot read ${this.manifestPath}: ${this.manifestError.message}`, {
				path: this.manifestPath
			});
			return null;
		}
		if (!isObject(this.manifest) || this.manifest.schema !== SCHEMA || !isObject(this.manifest.versions)) {
			issue(report, "manifest-invalid", "patch manifest has an unsupported shape", { path: this.manifestPath });
			return null;
		}
		const entry = this.manifest.versions[version];
		if (!isObject(entry) || !isObject(entry.files)) {
			issue(report, "version-unknown", `Kimi Code ${version} is not covered by the patch manifest`, { version });
			return null;
		}
		const hex = /^[a-f0-9]{64}$/;
		for (const spec of FILE_SPECS) {
			const meta = entry.files[spec.name];
			const valid =
				isObject(meta) &&
				typeof meta.pristineSha256 === "string" &&
				hex.test(meta.pristineSha256) &&
				Number.isInteger(meta.pristineSize) &&
				meta.pristineSize >= 0 &&
				typeof meta.patchedSha256 === "string" &&
				hex.test(meta.patchedSha256) &&
				Number.isInteger(meta.patchedSize) &&
				meta.patchedSize >= 0;
			if (!valid) {
				issue(report, "manifest-invalid", `patch manifest entry for ${version}/${spec.name} is incomplete`, {
					version,
					file: spec.name
				});
				return null;
			}
		}
		return entry;
	}

	async #readTarget(filePath, report) {
		try {
			const stat = await this.io.promises.stat(filePath);
			const bytes = await this.io.promises.readFile(filePath);
			return { exists: true, bytes, sha256: sha256(bytes), size: bytes.length, mode: stat.mode & 0o777 };
		} catch (err) {
			if (err && err.code === "ENOENT") {
				return { exists: false, bytes: null, sha256: null, size: 0, mode: 0o644 };
			}
			throw operationError(`cannot read ${filePath}: ${err.message}`, err, report);
		}
	}

	async #inspectStore(version, entry, report) {
		const dir = path.join(this.backupDir, version);
		const publicInfo = {
			dir,
			version,
			exists: false,
			valid: false,
			reason: null,
			source: null,
			files: [],
			legacy: null,
			migrated: false
		};
		let raw = null;
		try {
			raw = await this.io.promises.readFile(path.join(dir, BACKUP_META), "utf8");
			publicInfo.exists = true;
		} catch (err) {
			if (!err || err.code !== "ENOENT") {
				throw operationError(`cannot read backup metadata in ${dir}: ${err.message}`, err, report);
			}
			try {
				const names = await this.io.promises.readdir(dir);
				if (names.length > 0) {
					publicInfo.exists = true;
					publicInfo.reason = "metadata-missing";
				}
			} catch {
				// No backup directory at all.
			}
			return { valid: false, exists: publicInfo.exists, reason: publicInfo.reason, files: null, public: publicInfo };
		}

		let meta;
		try {
			meta = JSON.parse(raw);
		} catch {
			publicInfo.reason = "metadata-corrupt";
			return { valid: false, exists: true, reason: publicInfo.reason, files: null, public: publicInfo };
		}
		if (!isObject(meta) || meta.schema !== SCHEMA || meta.version !== version || !isObject(meta.files)) {
			publicInfo.reason = "metadata-invalid";
			return { valid: false, exists: true, reason: publicInfo.reason, files: null, public: publicInfo };
		}

		const files = {};
		for (const spec of FILE_SPECS) {
			const expected = entry.files[spec.name];
			const recorded = meta.files[spec.name];
			const filePath = path.join(dir, spec.name);
			const item = { name: spec.name, path: filePath, exists: false, valid: false, sha256: null, size: 0 };
			publicInfo.files.push(item);
			if (
				!isObject(recorded) ||
				recorded.sha256 !== expected.pristineSha256 ||
				recorded.size !== expected.pristineSize
			) {
				item.reason = "metadata-hash-mismatch";
				publicInfo.reason = `${spec.name}: metadata does not match the manifest`;
				continue;
			}
			let bytes;
			try {
				bytes = await this.io.promises.readFile(filePath);
				item.exists = true;
			} catch (err) {
				if (!err || err.code !== "ENOENT") {
					throw operationError(`cannot read backup ${filePath}: ${err.message}`, err, report);
				}
				item.reason = "file-missing";
				publicInfo.reason = `${spec.name}: backup file is missing`;
				continue;
			}
			const hash = sha256(bytes);
			item.sha256 = hash;
			item.size = bytes.length;
			if (hash !== expected.pristineSha256 || bytes.length !== expected.pristineSize) {
				item.reason = "hash-mismatch";
				publicInfo.reason = `${spec.name}: backup bytes are not pristine`;
				continue;
			}
			item.valid = true;
			files[spec.name] = bytes;
		}

		const valid = publicInfo.reason === null && FILE_SPECS.every((spec) => files[spec.name]);
		publicInfo.valid = valid;
		if (valid) publicInfo.source = "store";
		return { valid, exists: true, reason: publicInfo.reason, files: valid ? files : null, public: publicInfo };
	}

	async #inspectLegacy(distDir, entry, report) {
		const files = {};
		const publicInfo = { exists: false, valid: false, complete: false, files: [], reasons: [] };
		for (const spec of FILE_SPECS) {
			const expected = entry.files[spec.name];
			const filePath = path.join(distDir, `${spec.name}.bak-kimi-companion`);
			const item = { name: spec.name, path: filePath, exists: false, valid: false, sha256: null, size: 0 };
			publicInfo.files.push(item);
			let bytes;
			try {
				bytes = await this.io.promises.readFile(filePath);
				item.exists = true;
				publicInfo.exists = true;
			} catch (err) {
				if (!err || err.code !== "ENOENT") {
					throw operationError(`cannot read legacy backup ${filePath}: ${err.message}`, err, report);
				}
				item.reason = "file-missing";
				continue;
			}
			const hash = sha256(bytes);
			item.sha256 = hash;
			item.size = bytes.length;
			if (hash !== expected.pristineSha256 || bytes.length !== expected.pristineSize) {
				item.reason = "hash-mismatch";
				publicInfo.reasons.push(`${spec.name}: legacy backup is not pristine`);
				continue;
			}
			item.valid = true;
			files[spec.name] = bytes;
		}
		publicInfo.complete = FILE_SPECS.every((spec) => files[spec.name]);
		publicInfo.valid = publicInfo.complete;
		return { complete: publicInfo.complete, files: publicInfo.complete ? files : null, public: publicInfo };
	}

	#markers(text, units) {
		let applied = 0;
		for (const unit of units) if (text.includes(unit.marker)) applied++;
		return { applied, total: units.length };
	}

	async #analyze(args) {
		const validated = this.#validateArgs(args);
		const report = baseReport(validated.version);
		report.distDir = validated.distDir;
		const entry = this.#manifestEntry(validated.version, report);
		if (!entry) return { report, args: validated, rawArgs: validated.args, entry: null };

		const fingerprint = unitsFingerprint(validated.units.ext, validated.units.wv);
		const manifestFingerprint = typeof this.manifest.unitsSha256 === "string" ? this.manifest.unitsSha256 : null;
		const fingerprintMatches = manifestFingerprint === fingerprint;
		report.units = {
			fingerprint,
			manifest: manifestFingerprint,
			matches: fingerprintMatches
		};
		if (!fingerprintMatches) {
			issue(report, "manifest-mismatch", "the manifest fingerprint does not match the current patch units", {
				expected: manifestFingerprint,
				actual: fingerprint
			});
		}

		const current = {};
		for (const spec of FILE_SPECS) {
			current[spec.name] = await this.#readTarget(path.join(validated.distDir, spec.name), report);
		}

		const store = await this.#inspectStore(validated.version, entry, report);
		const legacy = await this.#inspectLegacy(validated.distDir, entry, report);
		const source = store.valid
			? { kind: "store", files: store.files }
			: legacy.complete
				? { kind: "legacy", files: legacy.files }
				: null;

		report.backup = store.public;
		report.backup.legacy = legacy.public;
		if (source && source.kind === "legacy") report.backup.source = "legacy";

		if (store.exists && !store.valid) {
			issue(
				report,
				"backup-invalid",
				`the backup for ${validated.version} is unusable: ${store.reason || "unknown reason"}`,
				{ path: store.public.dir },
				source ? "warning" : "error"
			);
		}
		if (legacy.public.exists && !legacy.complete) {
			issue(report, "legacy-invalid", `a legacy .bak-kimi-companion backup is incomplete or not pristine`, {
				path: validated.distDir
			}, "warning");
		}

		const records = {};
		const expectedByFile = {};
		let allPristine = true;
		let allPatched = true;
		let anyProgress = false;
		let anyForeign = false;
		let anyMissing = false;
		let anyUnproven = false;

		for (const spec of FILE_SPECS) {
			const meta = entry.files[spec.name];
			const file = current[spec.name];
			const record = {
				path: path.join(validated.distDir, spec.name),
				exists: file.exists,
				size: file.size,
				sha256: file.sha256,
				status: "foreign",
				markers: { applied: 0, total: validated.units[spec.units].length }
			};
			records[spec.name] = record;
			if (!file.exists) {
				record.status = "missing";
				issue(report, "file-missing", `${spec.name} is missing from ${validated.distDir}`, { file: spec.name });
				anyMissing = true;
				allPristine = false;
				allPatched = false;
				continue;
			}

			const pristine = file.sha256 === meta.pristineSha256 && file.size === meta.pristineSize;
			const pristineBytes = source ? source.files[spec.name] : pristine ? file.bytes : null;
			let expected = null;
			if (pristineBytes) {
				const applied = applyUnits(pristineBytes.toString("utf8"), validated.units[spec.units], spec.name);
				if (!applied.ok) {
					issue(report, applied.issue.code, applied.issue.message, {
						file: applied.issue.file,
						marker: applied.issue.marker,
						occurrences: applied.issue.occurrences
					});
				} else {
					expected = {
						text: applied.text,
						bytes: Buffer.from(applied.text, "utf8"),
						sha256: applied.sha256,
						stages: applied.stages,
						applied: applied.applied
					};
					expectedByFile[spec.name] = expected;
					if (fingerprintMatches && expected.sha256 !== meta.patchedSha256) {
						issue(
							report,
							"manifest-mismatch",
							`applying the current units to ${spec.name} does not match the manifest's patched hash`,
							{ file: spec.name, expected: meta.patchedSha256, actual: expected.sha256 }
						);
					}
					const parsed = parseScript(expected.text, spec.name, expected.sha256);
					if (!parsed.ok) {
						issue(report, "parse-error", `${spec.name}: ${parsed.error}`, { file: spec.name });
					}
				}
			}

			const targetHash = expected ? expected.sha256 : fingerprintMatches ? meta.patchedSha256 : null;
			record.targetSha256 = targetHash;
			if (pristine) {
				record.status = "pristine";
				allPatched = false;
			} else if (targetHash && file.sha256 === targetHash) {
				record.status = "patched";
				record.markers.applied = record.markers.total;
				anyProgress = true;
			} else if (expected && expected.stages.includes(file.sha256)) {
				record.status = "partial";
				record.stage = expected.stages.indexOf(file.sha256);
				record.stages = expected.stages.length - 1;
				record.markers.applied = record.stage;
				anyProgress = true;
				allPristine = false;
				allPatched = false;
			} else {
				const markers = this.#markers(file.bytes.toString("utf8"), validated.units[spec.units]);
				record.markers = markers;
				if (markers.applied > 0) {
					record.status = "partial";
					record.unproven = true;
					anyUnproven = true;
					anyProgress = true;
				} else {
					record.status = "foreign";
					anyForeign = true;
					issue(
						report,
						"foreign-bytes",
						`${spec.name} does not match a known pristine or patched hash`,
						{ file: spec.name }
					);
				}
				allPristine = false;
				allPatched = false;
			}
			if (record.status !== "pristine") allPristine = false;
			if (record.status !== "patched") allPatched = false;
		}

		let state;
		if (anyMissing || anyForeign) state = "foreign";
		else if (allPristine) state = "original";
		else if (allPatched) state = "patched";
		else if (anyProgress) state = "partial";
		else state = "foreign";

		if (!source && store.exists && !store.valid && (state === "patched" || state === "partial")) {
			state = "backup-invalid";
		}
		if (state === "original") {
			// An unusable old backup does not make a pristine dist unhealthy: install
			// can recreate the backup from the verified files themselves.
			const item = report.issues.find((entry) => entry.code === "backup-invalid");
			if (item) item.severity = "warning";
		}
		if (!source && !store.exists && (state === "patched" || state === "partial")) {
			issue(
				report,
				"backup-missing",
				`no verified pristine backup for ${validated.version}; restore will not be available`,
				{},
				"warning"
			);
		}
		if (anyUnproven) {
			issue(report, "predecessor-unproven", "the dist looks partially patched but does not match a known stage", {}, "error");
		}

		const needsWrite = FILE_SPECS.filter((spec) => records[spec.name].status !== "patched");
		const parseOk = !report.issues.some((item) => item.code === "parse-error");
		const manifestOk = !report.issues.some((item) => item.code === "manifest-mismatch");
		const writable = needsWrite.every((spec) => expectedByFile[spec.name]);
		let canInstall = false;
		if (state === "patched") {
			canInstall = true;
		} else if (state !== "unknown" && state !== "foreign") {
			canInstall = writable && parseOk && manifestOk;
		}
		if (state === "backup-invalid" && !writable) canInstall = false;
		if (anyUnproven) canInstall = false;

		const canRestore =
			Boolean(source) &&
			!anyMissing &&
			!anyForeign &&
			!anyUnproven &&
			(state === "patched" || state === "partial");

		report.state = state;
		report.canInstall = canInstall;
		report.canRestore = canRestore;
		report.files = records;
		return {
			report,
			args: validated,
			rawArgs: validated.args,
			entry,
			current,
			store,
			legacy,
			source,
			expectedByFile
		};
	}

	async #writeBackup(version, files, extensionPath) {
		const dir = path.join(this.backupDir, version);
		await this.io.promises.mkdir(dir, { recursive: true });
		const meta = {
			schema: SCHEMA,
			version,
			createdAt: new Date().toISOString(),
			source: extensionPath,
			files: {}
		};
		for (const spec of FILE_SPECS) {
			const bytes = files[spec.name];
			await atomicWrite(this.io, path.join(dir, spec.name), bytes, 0o600);
			meta.files[spec.name] = { sha256: sha256(bytes), size: bytes.length };
		}
		// Metadata is the commit marker: without it a half-written backup is ignored.
		await atomicWrite(
			this.io,
			path.join(dir, BACKUP_META),
			Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8"),
			0o600
		);
		return meta;
	}

	#backupReady(ctx) {
		const { report, source } = ctx;
		report.backup.valid = true;
		report.backup.exists = true;
		report.backup.reason = null;
		report.backup.source = "store";
		report.backup.files = FILE_SPECS.map((spec) => {
			const bytes = source ? source.files[spec.name] : ctx.current[spec.name].bytes;
			return {
				name: spec.name,
				path: path.join(this.backupDir, ctx.args.version, spec.name),
				exists: true,
				valid: true,
				sha256: bytes ? sha256(bytes) : null,
				size: bytes ? bytes.length : 0
			};
		});
	}

	async #rollback(distDir, written, report) {
		const result = { ok: true, files: [], foreign: [] };
		for (const item of written.slice().reverse()) {
			const filePath = path.join(distDir, item.name);
			try {
				const current = await this.io.promises.readFile(filePath);
				const hash = sha256(current);
				if (hash === item.prior.sha256) {
					result.files.push({ name: item.name, restored: true, action: "already-prior" });
					continue;
				}
				if (hash !== item.expectedSha) {
					result.ok = false;
					result.foreign.push(item.name);
					result.files.push({ name: item.name, restored: false, action: "foreign-change-preserved" });
					continue;
				}
				await atomicWrite(this.io, filePath, item.prior.bytes, item.prior.mode);
				const after = await this.io.promises.readFile(filePath);
				const restored = sha256(after) === item.prior.sha256;
				if (!restored) {
					result.ok = false;
					result.files.push({ name: item.name, restored: false, action: "restore-failed" });
				} else {
					result.files.push({ name: item.name, restored: true, action: "restored" });
				}
			} catch (err) {
				result.ok = false;
				result.files.push({ name: item.name, restored: false, action: "error", error: err.message });
			}
		}
		if (result.foreign.length > 0) {
			issue(
				report,
				"rollback-skipped-foreign",
				`left foreign changes untouched in: ${result.foreign.join(", ")}`,
				{ files: result.foreign }
			);
		}
		return result;
	}

	async #install(ctx) {
		const { report, args, entry, current, source, store, expectedByFile } = ctx;
		const finish = (ok, changed) => {
			report.ok = ok;
			report.changed = changed;
			return report;
		};
		if (!report.canInstall) return finish(false, false);

		const needsWrite = FILE_SPECS.filter((spec) => report.files[spec.name].status !== "patched");
		let backupReady = store.valid;
		let migrated = false;

		if (!backupReady && needsWrite.length > 0) {
			try {
				if (source) {
					await this.#writeBackup(args.version, source.files, args.extensionPath);
					migrated = source.kind === "legacy";
					backupReady = true;
					this.#backupReady({ ...ctx, source });
				} else if (report.state === "original") {
					const pristineFiles = {};
					for (const spec of FILE_SPECS) pristineFiles[spec.name] = current[spec.name].bytes;
					await this.#writeBackup(args.version, pristineFiles, args.extensionPath);
					backupReady = true;
					this.#backupReady({ ...ctx, source: { files: pristineFiles } });
				} else {
					issue(
						report,
						"backup-missing",
						"cannot build a complete pristine backup for a partially patched dist; completing the patch without one",
						{},
						"warning"
					);
				}
			} catch (err) {
				issue(report, "backup-write-failed", `cannot write the backup: ${err.message}`, {
					path: path.join(this.backupDir, args.version)
				});
				return finish(false, false);
			}
		}

		if (needsWrite.length === 0) {
			// Already patched. A verified legacy backup is still worth migrating so
			// restore becomes available again.
			if (!backupReady && source) {
				try {
					await this.#writeBackup(args.version, source.files, args.extensionPath);
					backupReady = true;
					migrated = source.kind === "legacy";
					this.#backupReady(ctx);
				} catch (err) {
					issue(report, "backup-write-failed", `cannot migrate the legacy backup: ${err.message}`, {}, "warning");
				}
			}
			if (migrated) report.backup.migrated = true;
			report.state = "patched";
			report.canInstall = true;
			report.canRestore = backupReady;
			return finish(true, false);
		}

		for (const spec of needsWrite) {
			if (!expectedByFile[spec.name]) {
				issue(report, "predecessor-unproven", `cannot prove the pristine content of ${spec.name}`, {
					file: spec.name
				});
				return finish(false, false);
			}
		}

		const written = [];
		try {
			for (const spec of needsWrite) {
				const expected = expectedByFile[spec.name];
				const filePath = path.join(args.distDir, spec.name);
				const prior = {
					bytes: current[spec.name].bytes,
					sha256: current[spec.name].sha256,
					mode: current[spec.name].mode || 0o644
				};
				const latest = await this.#readTarget(filePath, report);
				if (latest.exists !== current[spec.name].exists || latest.sha256 !== prior.sha256) {
					const err = new Error(`${spec.name} changed after the install preflight`);
					err.kcCode = "stale-state";
					throw err;
				}
				await atomicWrite(this.io, filePath, expected.bytes, prior.mode);
				written.push({ name: spec.name, expectedSha: expected.sha256, prior });
			}

			for (const spec of FILE_SPECS) {
				const record = report.files[spec.name];
				const filePath = path.join(args.distDir, spec.name);
				const bytes = await this.io.promises.readFile(filePath);
				const hash = sha256(bytes);
				const target = expectedByFile[spec.name] ? expectedByFile[spec.name].sha256 : record.targetSha256;
				if (!target || hash !== target) {
					const err = new Error(`${spec.name} did not reach the expected hash after writing`);
					err.kcCode = "postcheck-failed";
					throw err;
				}
				if (expectedByFile[spec.name]) {
					const text = bytes.toString("utf8");
					for (const unit of args.units[spec.units]) {
						if (!text.includes(unit.marker)) {
							const err = new Error(`${spec.name}: marker ${unit.marker} is missing after writing`);
							err.kcCode = "postcheck-markers";
							throw err;
						}
					}
					const parsed = parseScript(text, spec.name, hash);
					if (!parsed.ok) {
						const err = new Error(`${spec.name}: ${parsed.error}`);
						err.kcCode = "postcheck-parse";
						throw err;
					}
				}
			}
		} catch (err) {
			const rollback = await this.#rollback(args.distDir, written, report);
			issue(
				report,
				err.kcCode || "write-failed",
				`install failed: ${err.message}`,
				{ file: err.file || null, cause: err.code || null }
			);
			report.rollback = rollback;
			if (!rollback.ok && rollback.foreign.length === 0) {
				throw operationError("install failed and rollback could not restore the previous bytes", err, report);
			}
			const after = await this.#analyze(ctx.rawArgs);
			report.state = after.report.state;
			report.canInstall = after.report.canInstall;
			report.canRestore = after.report.canRestore;
			report.files = after.report.files;
			report.backup = after.report.backup;
			return finish(false, false);
		}

		for (const spec of FILE_SPECS) {
			const record = report.files[spec.name];
			if (expectedByFile[spec.name]) {
				record.sha256 = expectedByFile[spec.name].sha256;
				record.size = expectedByFile[spec.name].bytes.length;
			}
			record.status = "patched";
		}
		if (migrated) report.backup.migrated = true;
		report.state = "patched";
		report.canInstall = true;
		report.canRestore = backupReady;
		return finish(true, written.length > 0);
	}

	async #restore(ctx) {
		const { report, args, source, store, current } = ctx;
		const finish = (ok, changed) => {
			report.ok = ok;
			report.changed = changed;
			return report;
		};
		if (report.state === "original") {
			report.ok = true;
			report.changed = false;
			return report;
		}
		if (!report.canRestore || !source) {
			issue(report, "restore-unavailable", "no verified pristine backup is available to restore from", {
				state: report.state
			});
			return finish(false, false);
		}

		for (const spec of FILE_SPECS) {
			const bytes = source.files[spec.name];
			const parsed = parseScript(bytes.toString("utf8"), spec.name, sha256(bytes));
			if (!parsed.ok) {
				issue(report, "parse-error", `${spec.name}: pristine backup does not parse: ${parsed.error}`, {
					file: spec.name
				});
				return finish(false, false);
			}
		}

		let backupReady = store.valid;
		if (!backupReady && source.kind === "legacy") {
			try {
				await this.#writeBackup(args.version, source.files, args.extensionPath);
				backupReady = true;
				report.backup.migrated = true;
				this.#backupReady(ctx);
			} catch (err) {
				issue(report, "backup-write-failed", `cannot migrate the legacy backup: ${err.message}`, {}, "warning");
			}
		}

		const written = [];
		try {
			for (const spec of FILE_SPECS) {
				const targetBytes = source.files[spec.name];
				const targetHash = sha256(targetBytes);
				if (current[spec.name].exists && current[spec.name].sha256 === targetHash) continue;
				const filePath = path.join(args.distDir, spec.name);
				const prior = {
					bytes: current[spec.name].bytes,
					sha256: current[spec.name].sha256,
					mode: current[spec.name].mode || 0o644
				};
				const latest = await this.#readTarget(filePath, report);
				if (latest.exists !== current[spec.name].exists || latest.sha256 !== prior.sha256) {
					const err = new Error(`${spec.name} changed after the restore preflight`);
					err.kcCode = "stale-state";
					throw err;
				}
				await atomicWrite(this.io, filePath, targetBytes, prior.mode);
				written.push({ name: spec.name, expectedSha: targetHash, prior });
			}

			for (const spec of FILE_SPECS) {
				const filePath = path.join(args.distDir, spec.name);
				const bytes = await this.io.promises.readFile(filePath);
				const hash = sha256(bytes);
				const target = sha256(source.files[spec.name]);
				if (hash !== target) {
					const err = new Error(`${spec.name} did not reach the pristine hash after restore`);
					err.kcCode = "postcheck-failed";
					throw err;
				}
				const parsed = parseScript(bytes.toString("utf8"), spec.name, hash);
				if (!parsed.ok) {
					const err = new Error(`${spec.name}: ${parsed.error}`);
					err.kcCode = "postcheck-parse";
					throw err;
				}
			}
		} catch (err) {
			const rollback = await this.#rollback(args.distDir, written, report);
			issue(report, err.kcCode || "write-failed", `restore failed: ${err.message}`, {
				file: err.file || null,
				cause: err.code || null
			});
			report.rollback = rollback;
			if (!rollback.ok && rollback.foreign.length === 0) {
				throw operationError("restore failed and rollback could not restore the previous bytes", err, report);
			}
			const after = await this.#analyze(ctx.rawArgs);
			report.state = after.report.state;
			report.canInstall = after.report.canInstall;
			report.canRestore = after.report.canRestore;
			report.files = after.report.files;
			report.backup = after.report.backup;
			return finish(false, false);
		}

		for (const spec of FILE_SPECS) {
			const record = report.files[spec.name];
			record.sha256 = sha256(source.files[spec.name]);
			record.size = source.files[spec.name].length;
			record.status = "pristine";
			record.targetSha256 = record.sha256;
		}
		report.state = "original";
		report.canInstall =
			FILE_SPECS.every((spec) => ctx.expectedByFile[spec.name]) &&
			!report.issues.some((item) => item.code === "parse-error" || item.code === "manifest-mismatch");
		report.canRestore = false;
		report.backup.valid = backupReady || store.valid;
		return finish(true, written.length > 0);
	}

	async #run(operation, args) {
		let report = baseReport(args && args.version);
		try {
			const ctx = await this.#analyze(args);
			report = ctx.report;
			if (operation === "check") {
				const blocking = report.issues.some((item) => item.severity === "error");
				report.ok = !blocking && (report.state === "original" || report.state === "patched");
				return report;
			}
			throw new Error(`unsupported operation ${operation}`);
		} catch (err) {
			if (err && !err.report) err.report = report;
			throw err;
		}
	}

	async #lockIsStale(lockPath) {
		let raw;
		try {
			raw = await this.io.promises.readFile(lockPath, "utf8");
		} catch {
			return false;
		}
		let info = null;
		try {
			info = JSON.parse(raw);
		} catch {
			// A writer may have created an empty file a moment ago; only an old
			// malformed lock is considered stale.
			try {
				const stat = await this.io.promises.stat(lockPath);
				return Date.now() - stat.mtimeMs > this.lockStaleMs;
			} catch {
				return false;
			}
		}
		if (isObject(info) && Number.isInteger(info.pid)) {
			if (info.pid === process.pid) {
				// Our own PID does not prove the operation is still alive: a second copy
				// of the module may own the lock. Only an old lock is considered stale.
				try {
					const stat = await this.io.promises.stat(lockPath);
					return Date.now() - stat.mtimeMs > this.lockStaleMs;
				} catch {
					return false;
				}
			}
			try {
				process.kill(info.pid, 0);
			} catch (err) {
				if (err && err.code === "ESRCH") return true;
				if (err && err.code !== "EPERM") return true;
			}
			// A live or inaccessible PID may be hung or reused; age still bounds the lock.
		}
		try {
			const stat = await this.io.promises.stat(lockPath);
			return Date.now() - stat.mtimeMs > this.lockStaleMs;
		} catch {
			return false;
		}
	}

	async #acquireLock() {
		await this.io.promises.mkdir(this.backupDir, { recursive: true });
		const lockPath = path.join(this.backupDir, LOCK_NAME);
		const token = crypto.randomUUID();
		const payload = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() });
		const deadline = Date.now() + this.lockTimeoutMs;
		for (;;) {
			try {
				await this.io.promises.writeFile(lockPath, payload, { flag: "wx", encoding: "utf8" });
				return async () => {
					try {
						const raw = await this.io.promises.readFile(lockPath, "utf8");
						if (JSON.parse(raw).token === token) await this.io.promises.unlink(lockPath);
					} catch {
						// The lock is already gone or belongs to someone else.
					}
				};
			} catch (err) {
				// Windows reports a create racing with the previous holder's unlink as
				// EPERM/EACCES rather than EEXIST, so every contention code retries.
				if (!err || !LOCK_CONTENDED.has(err.code)) throw err;
				if (Date.now() < deadline && (await this.#lockIsStale(lockPath))) {
					try {
						await this.io.promises.unlink(lockPath);
					} catch {
						// Someone else won the race; keep waiting for the winner.
					}
					continue;
				}
				if (Date.now() >= deadline) throw lockBusyError();
				await delay(this.lockRetryMs);
			}
		}
	}

	async #withLock(operation, args) {
		const report = baseReport(args && args.version);
		let release = null;
		const key = this.backupDir;
		try {
			try {
				release = await this.#acquireLock();
			} catch (err) {
				if (err && err.code === "KC_LOCKED") {
					report.state = "busy";
					issue(report, "locked", err.message, { path: key });
					return report;
				}
				throw operationError(`cannot acquire the patch lock: ${err.message}`, err, report);
			}
			const ctx = await this.#analyze(args);
			if (operation === "install") return await this.#install(ctx);
			return await this.#restore(ctx);
		} catch (err) {
			if (err && !err.report) err.report = report;
			throw err;
		} finally {
			if (release) await release();
		}
	}
}

module.exports = {
	PatchDistManager,
	_test: {
		MANIFEST_PATH,
		FILE_SPECS,
		sha256,
		unitsFingerprint,
		applyUnits,
		parseScript,
		transformEsm
	}
};
