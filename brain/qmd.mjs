/**
 * qmd integration for the brain server.
 *
 * qmd (https://github.com/tobi/qmd) indexes the memory directory and answers
 * keyword (BM25), semantic (vector) and deep (hybrid + LLM rerank) queries.
 * Everything here degrades quietly: when qmd is missing or errors, the brain
 * falls back to its own BM25 search over the same files.
 *
 * Env: QMD_COLLECTION (the flat v0.1 collection name, reported when it is unused),
 *      QMD_COLLECTION_PREFIX (default psm: one collection per tier is `psm-<tier>`),
 *      QMD_UPDATE (background|manual|off), QMD_SEARCH_TIMEOUT_MS, QMD_EMBED_TIMEOUT_MS
 */
import { execFile } from "node:child_process";
import fs from "node:fs";

export const COLLECTION = process.env.QMD_COLLECTION || "pi-scale-memory";
/**
 * One collection per tier: `psm-core`, `psm-shared`, and `psm-<namespace>` per
 * project. qmd filters by collection (`-c`, repeatable) and not by path, so a
 * collection per tier is what makes a scoped search exact rather than a
 * post-filter over other projects' hits.
 */
export const COLLECTION_PREFIX = process.env.QMD_COLLECTION_PREFIX || "psm";

export function collectionFor(ns) {
	return `${COLLECTION_PREFIX}-${ns}`;
}

/** qmd subcommand per mode. `query` is hybrid + rerank, the slow but best one. */
export const MODE_SUBCOMMAND = { keyword: "search", semantic: "vsearch", deep: "query" };

const TIMEOUTS = { keyword: 30_000, semantic: 120_000, deep: 240_000 };
const UPDATE_TIMEOUT_MS = 120_000;
const EMBED_TIMEOUT_MS = Number(process.env.QMD_EMBED_TIMEOUT_MS ?? 600_000);
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 1000;

let available = null;
let checkedAt = 0;
let updateTimer = null;
let updating = false;
/**
 * True from the moment a write lands until the index catches up. Searches wait
 * on this (briefly) so an agent can search for something it just wrote.
 */
let indexDirty = false;
let collectionCache = new Map();
/** Tiers written since the last index pass, so only they need new embeddings. */
let pendingCollections = new Set();
const log = (msg) => console.log(`[qmd] ${msg}`);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** qmd emits spinners and progress bars even with --json; strip ANSI first. */
export function stripAnsi(text) {
	return String(text)
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

export function parseQmdJson(stdout) {
	const trimmed = String(stdout ?? "").trim();
	if (!trimmed) return [];
	if (/^no results found\.?$/i.test(trimmed)) return [];
	const cleaned = stripAnsi(stdout);
	const lines = cleaned.split(/\r?\n/);
	const start = lines.findIndex((l) => {
		const s = l.trimStart();
		return s.startsWith("[") || s.startsWith("{");
	});
	if (start === -1) throw new Error(`could not parse qmd output: ${trimmed.slice(0, 200)}`);
	const text = lines.slice(start).join("\n").trim();
	if (!text) return [];
	return JSON.parse(text);
}

export function clampLimit(value, fallback = 5, max = 20) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(value)));
}

export function normalizeMode(value) {
	if (value === "keyword" || value === "semantic" || value === "deep") return value;
	return "semantic";
}

/** `qmd://collection/MEMORY.md` -> `MEMORY.md`, for any of the named collections. */
export function relativeFile(file, collection) {
	if (!file) return "";
	for (const name of asList(collection)) {
		const prefix = `qmd://${name}/`;
		if (file.startsWith(prefix)) return file.slice(prefix.length);
	}
	return String(file);
}

function asList(value) {
	if (Array.isArray(value)) return value;
	return [value];
}

/** Which of the queried collections a hit came from, so the caller can label its tier. */
export function collectionOf(file, collection) {
	if (!file) return "";
	for (const name of asList(collection)) {
		if (String(file).startsWith(`qmd://${name}/`)) return name;
	}
	return "";
}

export function normalizeHits(raw, collection) {
	if (!Array.isArray(raw)) return [];
	const names = asList(collection);
	return raw.map((hit) => {
		const rawPath = hit.path ?? hit.file;
		let text = hit.content ?? hit.chunk ?? hit.snippet ?? "";
		if (typeof text === "string") text = text.trim();
		let score = hit.score ?? 0;
		if (typeof score !== "number") score = 0;
		return {
			file: relativeFile(rawPath, names),
			collection: collectionOf(rawPath, names),
			score: Number(score.toFixed(3)),
			text: String(text).slice(0, 1200),
			line: hit.line ?? null,
		};
	});
}

export function qmdArgs(mode, collection, query, limit) {
	let sub = MODE_SUBCOMMAND[mode];
	if (!sub) sub = MODE_SUBCOMMAND.semantic;
	const args = [sub, "--json"];
	for (const name of asList(collection)) args.push("-c", name);
	args.push("-n", String(limit), query);
	return args;
}

export function modeTimeoutMs(mode) {
	const configured = Number(process.env.QMD_SEARCH_TIMEOUT_MS);
	if (Number.isInteger(configured) && configured > 0) return configured;
	let timeout = TIMEOUTS[mode];
	if (!timeout) timeout = TIMEOUTS.semantic;
	return timeout;
}

/** Collection names from `qmd collection list` output. */
export function parseCollections(stdout) {
	const names = [];
	for (const line of stripAnsi(stdout).split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s+\(qmd:\/\//);
		if (m) names.push(m[1]);
	}
	return names;
}

/**
 * Collections that nothing searches any more: the flat v0.1 collection and any
 * left over from tests. Startup reports them, because `qmd update` reindexes every
 * collection on the machine whether or not anyone reads it.
 */
export function unusedCollections(names, live = []) {
	const keep = new Set(live);
	return names.filter((name) => !keep.has(name) && (name === COLLECTION || name.startsWith(`${COLLECTION_PREFIX}-test`)));
}

export function updateMode() {
	const value = (process.env.QMD_UPDATE ?? "background").toLowerCase();
	if (value === "off" || value === "manual") return value;
	return "background";
}

// ---------------------------------------------------------------------------
// CLI wrappers
// ---------------------------------------------------------------------------

function run(args, timeoutMs) {
	return new Promise((resolve) => {
		execFile("qmd", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => {
			resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), err });
		});
	});
}

export async function detectQmd() {
	const now = Date.now();
	let ttl = NEGATIVE_TTL_MS;
	if (available === true) ttl = POSITIVE_TTL_MS;
	if (checkedAt !== 0 && now - checkedAt < ttl) return available === true;
	// `collection list` is far lighter than `status`, which probes models/devices.
	const res = await run(["collection", "list"], 15_000);
	available = res.ok;
	checkedAt = Date.now();
	return available;
}

export async function hasCollection(collection = COLLECTION) {
	const now = Date.now();
	const cached = collectionCache.get(collection);
	if (cached) {
		let ttl = NEGATIVE_TTL_MS;
		if (cached.present) ttl = POSITIVE_TTL_MS;
		if (now - cached.checkedAt < ttl) return cached.present;
	}
	const res = await run(["collection", "list"], 15_000);
	let present = false;
	if (res.ok) present = parseCollections(res.stdout).includes(collection);
	// One entry per name: a search checks several tiers, and a single-slot cache
	// would evict each other and re-run `qmd collection list` every time.
	collectionCache.set(collection, { present, checkedAt: Date.now() });
	return present;
}

/** Test hook: forget cached availability/collection state. */
export function resetCaches() {
	available = null;
	checkedAt = 0;
	collectionCache.clear();
	indexDirty = false;
	pendingCollections = new Set();
}

export function isIndexDirty() {
	return indexDirty;
}

/** Wait for a pending re-index, bounded — a search should not hang on the indexer. */
export async function waitForIndex(maxMs) {
	const deadline = Date.now() + maxMs;
	while (indexDirty) {
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, 100));
	}
	return true;
}

/** Create the collection and its path contexts if they are missing. */
export async function ensureCollection(dir, collection = COLLECTION) {
	// A tier with no directory yet has no memory, and `qmd collection add` refuses a
	// missing path. Report it rather than invoking qmd: the caller decides whether a
	// missing collection is fatal (it is not — the other tiers still answer).
	if (!fs.existsSync(dir)) return false;
	if (await hasCollection(collection)) return true;
	const added = await run(["collection", "add", dir, "--name", collection], 30_000);
	if (!added.ok) {
		log(`collection add failed: ${stripAnsi(added.stderr).trim().split("\n").pop()}`);
		return false;
	}
	const contexts = [
		["/daily", "Daily append-only agent work logs organized by date"],
		["/", "Coding-agent memory: decisions, preferences, facts, lessons"],
	];
	for (const [ctxPath, description] of contexts) {
		await run(["context", "add", ctxPath, description, "-c", collection], 15_000);
	}
	// Seed the cache: the check above cached "missing", and without this the next
	// few seconds of searches would keep falling back to BM25 for no reason.
	collectionCache.set(collection, { present: true, checkedAt: Date.now() });
	log(`collection '${collection}' created for ${dir}`);
	return true;
}

/** `qmd update` re-indexes every collection on the machine; there is no per-collection form. */
export async function updateIndex() {
	return run(["update"], UPDATE_TIMEOUT_MS);
}

export async function embedIndex(collection = COLLECTION) {
	return run(["embed", "-c", collection, "--timeout", "10"], EMBED_TIMEOUT_MS);
}

export async function qmdSearch(mode, query, limit, collection = COLLECTION) {
	const res = await run(qmdArgs(mode, collection, query, limit), modeTimeoutMs(mode));	if (!res.ok) {
		const message = stripAnsi(res.stderr).trim() || stripAnsi(res.err?.message ?? "").trim();
		let hint = "";
		if (res.err?.killed) hint = " (qmd timed out; the first semantic/deep query loads models)";
		throw new Error(`${message}${hint}`);
	}
	const parsed = parseQmdJson(res.stdout);
	let list = parsed;
	if (!Array.isArray(parsed)) list = parsed?.results ?? parsed?.hits ?? [];
	return { results: normalizeHits(list, collection), stderr: stripAnsi(res.stderr) };
}

// ---------------------------------------------------------------------------
// Background index refresh
// ---------------------------------------------------------------------------

/**
 * Re-index after a write, debounced and serialized. `qmd update` covers every
 * collection; `qmd embed` does not, so the tiers named here are embedded
 * individually and everything written meanwhile is folded into the same pass.
 */
export function scheduleIndexRefresh(reason = "write", collections = []) {
	if (updateMode() !== "background") return;
	for (const name of collections) pendingCollections.add(name);
	indexDirty = true;
	if (updateTimer) clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		void refreshIndex(reason);
	}, 800);
	updateTimer.unref?.();
}

export async function refreshIndex(reason = "manual", collections = []) {
	for (const name of collections) pendingCollections.add(name);
	if (updating) {
		// Fold this request into a slightly later run rather than skipping it. The
		// pending set survives, so the next pass still embeds what this one missed.
		scheduleIndexRefresh(`${reason}:requeued`);
		return { ok: false, detail: "already running" };
	}
	if (!(await detectQmd())) {
		indexDirty = false;
		pendingCollections.clear();
		return { ok: false, detail: "qmd not available" };
	}
	updating = true;
	const targets = [...pendingCollections];
	pendingCollections.clear();
	try {
		const updated = await updateIndex();
		if (!updated.ok) {
			log(`update failed: ${stripAnsi(updated.stderr).trim().split("\n").pop()}`);
			return { ok: false, detail: "update failed" };
		}
		for (const name of targets) {
			const embedded = await embedIndex(name);
			if (!embedded.ok) {
				log(`embed failed for ${name}: ${stripAnsi(embedded.stderr).trim().split("\n").pop()}`);
				return { ok: true, detail: `re-indexed (${reason}); embeddings pending` };
			}
		}
		const embeddedNote = targets.length ? `; embedded ${targets.length} collection(s)` : "";
		return { ok: true, detail: `re-indexed (${reason})${embeddedNote}` };
	} finally {
		updating = false;
		indexDirty = false;
	}
}

export function isIndexing() {
	return updating;
}
