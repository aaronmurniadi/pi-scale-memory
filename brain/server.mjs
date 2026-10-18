#!/usr/bin/env node
/**
 * pi-scale-memory brain server.
 *
 * Run this on the machine that hosts the memory. Agents find it by asking peers on
 * the memory port whether they are the brain, and mirror the memory into a local
 * cache so they can keep reading while offline.
 *
 * Three tiers live under BRAIN_DIR (see brain/memory.mjs for the layout):
 *   core    human-authored, written only through /v1/core by /core-memory
 *   shared  agent-managed cross-project memory
 *   project one namespace per git repository, resolved by the agent
 *
 * Search: qmd (keyword / semantic / deep) when installed, otherwise the built-in
 * BM25 search over the same files. See brain/qmd.mjs. One collection per tier is
 * what makes a scoped search exact, since qmd filters by collection and not path.
 *
 * It binds loopback by default: the brain's own userspace tailscale node
 * publishes it to the tailnet with `tailscale serve`.
 *
 * Env: BRAIN_DIR (default ~/.pi-scale-brain), BRAIN_PORT (8787),
 *      BRAIN_HOST (127.0.0.1), BRAIN_TOKEN (optional shared bearer token)
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
	appendBlock,
	buildContext,
	CORE,
	coreDir,
	dailyPath,
	dateStr,
	DEFAULT_NS,
	isDate,
	isShared,
	isValidNs,
	listDaily,
	loadScratchpad,
	memoryPath,
	migrateFlat,
	nsDir,
	pad2,
	readSafe,
	recoveryDir,
	scratchpadPath,
	SHARED,
	searchTiers,
	serializeScratchpad,
	sharedDir,
	snapshotTier,
	tierDir,
	tierSizes,
	todayStr,
	writeEntry,
} from "./memory.mjs";
import {
	clampLimit,
	collectionFor,
	detectQmd,
	ensureCollection,
	isIndexDirty,
	isIndexing,
	normalizeMode,
	parseCollections,
	qmdSearch,
	refreshIndex,
	scheduleIndexRefresh,
	stripAnsi,
	unusedCollections,
	updateMode,
	waitForIndex,
} from "./qmd.mjs";

const DIR = process.env.BRAIN_DIR || path.join(os.homedir(), ".pi-scale-brain");
const PORT = Number(process.env.BRAIN_PORT || 8787);
const HOST = process.env.BRAIN_HOST || "127.0.0.1";
const TOKEN = process.env.BRAIN_TOKEN || "";
const MAX_BODY = 2 * 1024 * 1024;
/** Identifies this API: agents probe peers for it instead of trusting a tag. */
const SERVICE = "pi-scale-memory";
const SEARCH_MODE = normalizeMode(process.env.QMD_SEARCH_MODE);
/** How long a search waits for an in-flight re-index so it sees the latest write. */
const INDEX_WAIT_MS = Number(process.env.QMD_INDEX_WAIT_MS ?? 5_000);
const SCOPES = [CORE, SHARED, "project"];
const REGISTRY = path.join(DIR, "registry.json");

/** Search state reported by /v1/health so agents can label their results. */
const searchState = { engine: "bm25", mode: SEARCH_MODE, ready: false, note: null };
/** Collections the brain believes exist: what /v1/health reports and /memory search prints. */
const knownCollections = new Set();

fs.mkdirSync(path.join(DIR, "ns"), { recursive: true });
fs.mkdirSync(coreDir(DIR), { recursive: true });
fs.mkdirSync(sharedDir(DIR), { recursive: true });

// ---------------------------------------------------------------------------
// One-time move of the flat v0.1 layout into tiers
// ---------------------------------------------------------------------------

const migration = migrateFlat(DIR);
if (migration.migrated) {
	console.log(`[migrate] flat memory moved into tiers: ${migration.moved.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function stamp() {
	const d = new Date();
	return `${dateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function tag(agent, session) {
	let who = agent || "agent";
	if (session) who += `:${session}`;
	return `<!-- ${stamp()} [${who}] -->`;
}

function dateOrToday(d) {
	if (isDate(d)) return d;
	return todayStr();
}

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

/**
 * Serialize writes to a file. Several agents can write the same tier at once, and
 * every read-modify-write here (scratchpad, forget, dedup) would otherwise lose
 * one of them. Keyed on the file, so different tiers still write in parallel.
 */
const locks = new Map();
async function withLock(key, fn) {
	const previous = locks.get(key) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	// Nothing ever rejects on the chain, so the next caller can simply wait on it.
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	locks.set(key, settled);
	try {
		return await run;
	} finally {
		if (locks.get(key) === settled) locks.delete(key);
	}
}

// ---------------------------------------------------------------------------
// Namespace resolution
// ---------------------------------------------------------------------------

/** Where a read may point: a project tier, shared, or core. */
function resolveRead(rawNs, target) {
	const raw = rawNs || DEFAULT_NS;
	if (raw === CORE) {
		if (target !== "long_term") throw httpErr(400, "core memory has no scratchpad and no daily log");
		return { ns: CORE, tier: CORE, dir: coreDir(DIR) };
	}
	if (!isValidNs(raw)) throw httpErr(400, `invalid ns '${raw}'`);
	if (isShared(raw) && target !== "long_term" && target !== "list") {
		throw httpErr(400, `the shared tier holds MEMORY.md only; it has no ${target}`);
	}
	return { ns: raw, tier: isShared(raw) ? SHARED : "project", dir: tierDir(DIR, raw) };
}

/**
 * Where a write may point. Core is structurally unreachable from here: the only
 * route that touches core/MEMORY.md is /v1/core, which only /core-memory calls.
 */
function resolveWrite(rawNs, target) {
	const raw = rawNs || DEFAULT_NS;
	if (raw === CORE) throw httpErr(400, "core memory is written only through /v1/core (the /core-memory command)");
	if (!isValidNs(raw)) throw httpErr(400, `invalid ns '${raw}'`);
	if (isShared(raw) && target !== "long_term") {
		throw httpErr(400, `the shared tier holds MEMORY.md only; it has no ${target}`);
	}
	return { ns: raw, tier: isShared(raw) ? SHARED : "project", dir: tierDir(DIR, raw) };
}

// ---------------------------------------------------------------------------
// Registry: which project namespaces exist, and what they belong to
// ---------------------------------------------------------------------------

function loadRegistry() {
	try {
		const raw = JSON.parse(fs.readFileSync(REGISTRY, "utf-8"));
		if (raw && typeof raw === "object" && raw.namespaces && typeof raw.namespaces === "object") return raw;
	} catch {
		/* first run, or a corrupt file that is not worth failing over */
	}
	return { version: 2, namespaces: {} };
}

function saveRegistry(reg) {
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2), "utf-8");
}

/** Record that a namespace was used, and what the agent says it belongs to. */
function touchNs(ns, info = {}) {
	if (!isValidNs(ns) || isShared(ns)) return;
	const reg = loadRegistry();
	const entry = reg.namespaces[ns] ?? { firstSeen: stamp(), agents: [] };
	entry.lastSeen = stamp();
	if (info.nsKey) entry.key = String(info.nsKey);
	if (info.nsLabel) entry.label = String(info.nsLabel);
	if (info.agent && !entry.agents.includes(info.agent)) entry.agents = [...entry.agents, info.agent].slice(-10);
	reg.namespaces[ns] = entry;
	saveRegistry(reg);
}

function listNsIds() {
	try {
		return fs.readdirSync(path.join(DIR, "ns")).filter((name) => isValidNs(name)).sort();
	} catch {
		return [];
	}
}

function dirStats(dir) {
	const memory = readSafe(memoryPath(dir)) ?? "";
	const scratchpad = readSafe(scratchpadPath(dir)) ?? "";
	const dates = listDaily(dir);
	let dailyBytes = 0;
	let lastWrite = "";
	for (const date of dates) {
		dailyBytes += (readSafe(dailyPath(dir, date)) ?? "").length;
	}
	const mtimeOf = (p) => {
		try {
			return fs.statSync(p).mtime.toISOString();
		} catch {
			return "";
		}
	};
	for (const p of [memoryPath(dir), scratchpadPath(dir), dailyPath(dir, dates[0] ?? "")]) {
		const m = mtimeOf(p);
		if (m > lastWrite) lastWrite = m;
	}
	return { memory: memory.length, scratchpad: scratchpad.length, daily: dailyBytes, dailyFiles: dates.length, lastWrite };
}

function handleNamespaces(activeNs) {
	const reg = loadRegistry();
	const namespaces = listNsIds().map((id) => {
		const dir = nsDir(DIR, id);
		const stats = dirStats(dir);
		const entry = reg.namespaces[id] ?? {};
		return {
			id,
			label: entry.label ?? entry.key ?? id,
			key: entry.key ?? null,
			archived: id === DEFAULT_NS,
			agents: entry.agents ?? [],
			lastSeen: entry.lastSeen ?? null,
			...stats,
		};
	});
	return {
		active: activeNs ?? null,
		default: DEFAULT_NS,
		core: dirStats(coreDir(DIR)),
		shared: dirStats(sharedDir(DIR)),
		namespaces,
	};
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleWrite(body) {
	const { target, content, mode, agent, session, nsKey, nsLabel } = body;
	if (typeof content !== "string" || !content.trim()) throw httpErr(400, "content required");
	const { ns, dir } = resolveWrite(body.ns, target);
	touchNs(ns, { agent, nsKey, nsLabel });

	if (target === "daily") {
		const date = dateOrToday(body.date);
		const file = dailyPath(dir, date);
		await withLock(file, () => appendBlock(file, `${tag(agent, session)}\n${content.trim()}`));
		return { ok: true, ns, file: `${ns}/daily/${date}.md` };
	}
	if (target === "long_term") {
		const file = memoryPath(dir);
		if (mode === "overwrite") {
			await withLock(file, () => {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, `${content.trim()}\n`, "utf-8");
			});
			return { ok: true, ns, file: `${ns}/MEMORY.md`, overwritten: true };
		}
		const out = await withLock(file, () =>
			writeEntry(file, `${tag(agent, session)}\n${content.trim()}`, content, { dedup: body.dedup !== false }),
		);
		return { ok: true, ns, file: `${ns}/MEMORY.md`, deduped: Boolean(out.deduped) };
	}
	throw httpErr(400, "unknown target");
}

async function handleScratchpad(body) {
	const { action, text, agent } = body;
	const { ns, dir } = resolveWrite(body.ns, "scratchpad");
	touchNs(ns, { agent });
	const file = scratchpadPath(dir);
	return withLock(file, () => {
		const items = loadScratchpad(dir);
		const save = () => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, serializeScratchpad(items), "utf-8");
		};
		const needle = (text || "").toLowerCase();
		if (action === "add") {
			if (!needle) throw httpErr(400, "text required");
			items.push({ done: false, text: `${text.trim()} <!-- ${stamp()} [${agent || "agent"}] -->` });
			save();
		} else if (action === "done" || action === "undo") {
			const want = action === "done";
			const item = items.find((i) => i.done !== want && i.text.toLowerCase().includes(needle));
			if (!item) throw httpErr(404, "no matching item");
			item.done = want;
			save();
		} else if (action === "clear_done") {
			const kept = items.filter((i) => !i.done);
			items.length = 0;
			items.push(...kept);
			save();
		} else if (action !== "list") {
			throw httpErr(400, "unknown action");
		}
		return { ok: true, ns, items };
	});
}

/** Remove paragraphs, keeping a copy under recovery/ so a mistake is recoverable. */
function removeParagraphs(file, dir, match) {
	const content = readSafe(file);
	if (!content) return { removed: 0 };
	const paras = content.split(/\n{2,}/);
	const removedParas = paras.filter((p) => p.toLowerCase().includes(match));
	if (removedParas.length === 0) return { removed: 0 };
	const recovery = recoveryDir(dir);
	fs.mkdirSync(recovery, { recursive: true });
	const id = `${Date.now()}`;
	fs.writeFileSync(
		path.join(recovery, `${id}.json`),
		JSON.stringify({ file: path.basename(file), removed: removedParas }, null, 2),
	);
	fs.writeFileSync(file, paras.filter((p) => !p.toLowerCase().includes(match)).join("\n\n"), "utf-8");
	return { removed: removedParas.length, recoveryId: id };
}

async function handleForget(body) {
	const match = (body.match || "").toLowerCase();
	if (!match) throw httpErr(400, "match required");
	const target = body.target === "daily" ? "daily" : "long_term";
	if (body.ns === CORE || body.target === CORE) {
		throw httpErr(400, "core memory is edited only through /core-memory (append) and /core-memory --remove");
	}
	const { ns, dir } = resolveWrite(body.ns, target);
	const file = target === "daily" ? dailyPath(dir, dateOrToday(body.date)) : memoryPath(dir);
	const out = await withLock(file, () => removeParagraphs(file, dir, match));
	return { ok: true, ns, ...out };
}

/** Core is a single human-authored file; this endpoint is its only writer. */
async function handleCore(body) {
	const dir = coreDir(DIR);
	const file = memoryPath(dir);
	const action = body.action || "append";
	if (action === "append") {
		if (typeof body.content !== "string" || !body.content.trim()) throw httpErr(400, "content required");
		const out = await withLock(file, () =>
			writeEntry(file, `<!-- ${stamp()} -->\n${body.content.trim()}`, body.content, { dedup: body.dedup !== false }),
		);
		return { ok: true, action, deduped: Boolean(out.deduped) };
	}
	if (action === "remove") {
		const match = (body.match || "").toLowerCase();
		if (!match) throw httpErr(400, "match required");
		const out = await withLock(file, () => removeParagraphs(file, dir, match));
		return { ok: true, action, ...out };
	}
	if (action === "list") return { ok: true, action, content: readSafe(file) ?? "" };
	throw httpErr(400, "unknown action");
}

function handleRead(q) {
	const target = q.get("target");
	const { ns, dir } = resolveRead(q.get("ns"), target);
	if (target === "list") return { ns, files: listDaily(dir) };
	if (target === "long_term") return { ns, content: readSafe(memoryPath(dir)) || "" };
	if (target === "scratchpad") return { ns, content: readSafe(scratchpadPath(dir)) || "" };
	if (target === "daily") return { ns, content: readSafe(dailyPath(dir, dateOrToday(q.get("date")))) || "" };
	throw httpErr(400, "unknown target");
}

/** Merge one project namespace into another, for a repo that was renamed or forked. */
async function handleMerge(body) {
	const from = String(body.from ?? "");
	const into = String(body.into ?? "");
	for (const id of [from, into]) {
		if (!isValidNs(id) || isShared(id)) throw httpErr(400, `invalid namespace '${id}'`);
	}
	if (from === into) throw httpErr(400, "nothing to merge");
	if (!fs.existsSync(nsDir(DIR, from))) throw httpErr(404, `no namespace '${from}'`);
	fs.mkdirSync(nsDir(DIR, into), { recursive: true });

	const fromDir = nsDir(DIR, from);
	const intoDir = nsDir(DIR, into);
	const moved = { memory: 0, scratchpad: 0, daily: 0 };

	const memory = readSafe(memoryPath(fromDir));
	if (memory?.trim()) {
		const out = await withLock(memoryPath(intoDir), () => writeEntry(memoryPath(intoDir), memory.trim(), memory, { dedup: true }));
		moved.memory = out.deduped ? 0 : 1;
	}
	for (const date of listDaily(fromDir)) {
		const dest = dailyPath(intoDir, date);
		// The destination is locked like every other write: another agent may be
		// appending to that same day while the merge runs.
		const wrote = await withLock(dest, () => {
			if (fs.existsSync(dest)) return false;
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, readSafe(dailyPath(fromDir, date)) ?? "", "utf-8");
			return true;
		});
		if (wrote) moved.daily++;
	}
	const scratch = readSafe(scratchpadPath(fromDir));
	if (scratch?.trim()) {
		const items = loadScratchpad(fromDir);
		await withLock(scratchpadPath(intoDir), () => {
			const target = loadScratchpad(intoDir);
			for (const item of items) {
				if (target.some((t) => t.text === item.text)) continue;
				target.push(item);
			}
			fs.mkdirSync(intoDir, { recursive: true });
			fs.writeFileSync(scratchpadPath(intoDir), serializeScratchpad(target), "utf-8");
		});
		moved.scratchpad = items.length;
	}
	fs.rmSync(fromDir, { recursive: true, force: true });

	const reg = loadRegistry();
	const entry = reg.namespaces[into] ?? { firstSeen: stamp(), agents: [] };
	entry.aliases = [...new Set([...(entry.aliases ?? []), from, ...(reg.namespaces[from]?.aliases ?? [])])];
	entry.lastSeen = stamp();
	reg.namespaces[into] = entry;
	delete reg.namespaces[from];
	saveRegistry(reg);
	return { ok: true, from, into, moved };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Which tiers a scope covers, each with its collection and directory. */
function normalizeScope(value) {
	if (value === "core" || value === "shared" || value === "project" || value === "legacy") return value;
	return "all";
}

function scopeTiers(ns, scope) {
	const tiers = [];
	if (scope === "core" || scope === "all") tiers.push({ tier: CORE, ns: CORE, collection: collectionFor(CORE), dir: coreDir(DIR) });
	if (scope === "shared" || scope === "all") tiers.push({ tier: SHARED, ns: SHARED, collection: collectionFor(SHARED), dir: sharedDir(DIR) });
	if (scope === "project" || scope === "all") {
		if (ns && isValidNs(ns) && !isShared(ns)) {
			tiers.push({ tier: "project", ns, collection: collectionFor(ns), dir: nsDir(DIR, ns) });
		}
	}
	if (scope === "legacy") tiers.push({ tier: "project", ns: DEFAULT_NS, collection: collectionFor(DEFAULT_NS), dir: nsDir(DIR, DEFAULT_NS) });
	return tiers;
}

/**
 * One search request: qmd when it is usable, BM25 otherwise. Never throws for a
 * missing or failing qmd — the caller always gets results, the tiers searched, and
 * the engine that answered.
 */
async function runSearch(query, mode, limit, ns, scope) {
	const tiers = scopeTiers(ns, scope);
	const labels = new Map(tiers.map((t) => [t.collection, t.tier]));
	const fallback = (note) => {
		searchState.engine = "bm25";
		searchState.note = note ?? null;
		const results = searchTiers(DIR, ns, query, limit, scope);
		return { engine: "bm25", mode: "keyword", scope, tiers: tiers.map((t) => t.tier), results, note };
	};

	if (!query.trim() || tiers.length === 0) return fallback(undefined);
	if (!(await detectQmd())) return fallback(undefined);

	// A collection per tier is what keeps scoping exact. qmd fails the whole query
	// when any named collection is missing, so only tiers that really have one are
	// named: a project with no memory yet must not cost the agent its core and
	// shared results, which is exactly the "have we done this before?" search.
	const available = [];
	for (const t of tiers) {
		if (await ensureCollection(t.dir, t.collection)) {
			available.push(t);
			knownCollections.add(t.collection);
		}
	}
	if (available.length === 0) return fallback("no qmd collection for the tiers in scope yet");
	if (isIndexDirty()) await waitForIndex(INDEX_WAIT_MS);

	try {
		const names = available.map((t) => t.collection);
		const { results } = await qmdSearch(mode, query, limit, names);
		searchState.engine = "qmd";
		searchState.ready = true;
		searchState.note = null;
		const tagged = results.map((hit) => ({ ...hit, tier: labels.get(hit.collection) ?? "project" }));
		if (tagged.length === 0) {
			// qmd's index can still be behind a very recent write. BM25 reads the
			// files directly, so prefer a real hit over an empty answer.
			const direct = searchTiers(DIR, ns, query, limit, scope);
			if (direct.length > 0) {
				searchState.engine = "bm25";
				searchState.note = "qmd index is catching up";
				return { engine: "bm25", mode: "keyword", scope, tiers: tiers.map((t) => t.tier), results: direct, note: "qmd index is catching up" };
			}
		}
		return { engine: "qmd", mode, scope, tiers: tiers.map((t) => t.tier), results: tagged };
	} catch (err) {
		let message = String(err);
		if (err instanceof Error) message = err.message;
		console.log(`[search] qmd ${mode} failed, using bm25: ${stripAnsi(message).trim().slice(0, 200)}`);
		return fallback(`qmd failed: ${stripAnsi(message).trim().slice(0, 160)}`);
	}
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(httpErr(413, "body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
			} catch {
				reject(httpErr(400, "invalid JSON"));
			}
		});
		req.on("error", reject);
	});
}

/** Keep the qmd index current for the tier that was just written. */
async function indexAfterWrite(ns) {
	if (updateMode() !== "background") return;
	try {
		const target = isShared(ns) ? SHARED : ns;
		const dir = tierDir(DIR, target);
		const collection = collectionFor(target);
		if (await ensureCollection(dir, collection)) knownCollections.add(collection);
		scheduleIndexRefresh(`write:${ns}`, [collection]);
	} catch {
		/* the index is best-effort; the files are already written */
	}
}

const server = http.createServer(async (req, res) => {
	const send = (status, obj) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(obj));
	};
	try {
		if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) throw httpErr(401, "unauthorized");
		const url = new URL(req.url, "http://brain");
		const route = `${req.method} ${url.pathname}`;
		if (route === "GET /v1/health") {
			return send(200, {
				ok: true,
				service: SERVICE,
				role: "brain",
				host: os.hostname(),
				date: todayStr(),
				scopes: SCOPES,
				defaultNs: DEFAULT_NS,
				core: true,
				search: { ...searchState, collections: [...knownCollections], indexing: isIndexing(), update: updateMode() },
			});
		}
		if (route === "GET /v1/context") {
			const raw = url.searchParams.get("ns");
			let ns = null;
			if (raw === CORE) ns = null;
			else if (raw && isValidNs(raw) && !isShared(raw)) ns = raw;
			return send(200, { ns, context: buildContext(DIR, ns), sizes: tierSizes(DIR, ns) });
		}
		// Full mirror for agent caches: the two cross-project tiers plus one project.
		if (route === "GET /v1/snapshot") {
			const raw = url.searchParams.get("ns");
			const ns = raw && isValidNs(raw) && !isShared(raw) ? raw : null;
			const project = ns ? { id: ns, files: snapshotTier(nsDir(DIR, ns)) } : null;
			return send(200, {
				takenAt: stamp(),
				ns,
				core: { files: snapshotTier(coreDir(DIR)) },
				shared: { files: snapshotTier(sharedDir(DIR)) },
				project,
			});
		}
		if (route === "GET /v1/read") return send(200, handleRead(url.searchParams));
		if (route === "GET /v1/search") {
			const limit = clampLimit(Number(url.searchParams.get("limit")) || 5);
			const mode = normalizeMode(url.searchParams.get("mode") ?? SEARCH_MODE);
			const query = url.searchParams.get("q") || "";
			const ns = url.searchParams.get("ns") || "";
			const scope = normalizeScope(url.searchParams.get("scope"));
			return send(200, await runSearch(query, mode, limit, ns, scope));
		}
		if (route === "GET /v1/namespaces") {
			const active = url.searchParams.get("ns") || null;
			return send(200, handleNamespaces(active));
		}
		if (route === "GET /v1/core") return send(200, { content: readSafe(memoryPath(coreDir(DIR))) ?? "" });
		if (route === "POST /v1/write") {
			const body = await readBody(req);
			const out = await handleWrite(body);
			await indexAfterWrite(out.ns);
			return send(200, out);
		}
		if (route === "POST /v1/scratchpad") {
			const out = await handleScratchpad(await readBody(req));
			await indexAfterWrite(out.ns);
			return send(200, out);
		}
		if (route === "POST /v1/forget") {
			const body = await readBody(req);
			const out = await handleForget(body);
			await indexAfterWrite(out.ns);
			return send(200, out);
		}
		if (route === "POST /v1/core") {
			const out = await handleCore(await readBody(req));
			await indexAfterWrite(CORE);
			return send(200, out);
		}
		if (route === "POST /v1/ns/merge") {
			const out = await handleMerge(await readBody(req));
			return send(200, out);
		}
		throw httpErr(404, "not found");
	} catch (e) {
		send(e.status || 500, { error: e.message });
	}
});

server.listen(PORT, HOST, () => console.log(`pi-scale-memory brain listening on ${HOST}:${PORT}, dir=${DIR}`));

/** Wire up qmd once at startup: one collection per tier, then the index. */
async function initSearch() {
	if (!(await detectQmd())) {
		console.log("[search] qmd not found; using built-in bm25 search");
		return;
	}
	const tiers = [
		{ tier: CORE, dir: coreDir(DIR), collection: collectionFor(CORE) },
		{ tier: SHARED, dir: sharedDir(DIR), collection: collectionFor(SHARED) },
	];
	for (const id of listNsIds()) {
		tiers.push({ tier: id, dir: nsDir(DIR, id), collection: collectionFor(id) });
	}
	let ready = 0;
	for (const t of tiers) {
		if (await ensureCollection(t.dir, t.collection)) {
			ready++;
			knownCollections.add(t.collection);
		}
	}
	if (ready === 0) {
		console.log("[search] could not create a qmd collection; using bm25");
		return;
	}
	searchState.ready = true;

	const listing = await unusedCollectionsNames();
	if (listing.length) {
		console.log(`[search] collections from the flat layout are no longer searched: ${listing.join(", ")} (remove with: qmd collection remove <name>)`);
	}
	if (updateMode() !== "background") {
		console.log(`[search] qmd collections in use (${tiers.length}), automatic indexing ${updateMode()}`);
		return;
	}
	const result = await refreshIndex("startup", tiers.map((t) => t.collection));
	let state = "pending";
	if (result.ok) state = "ready";
	console.log(`[search] qmd collections indexed — ${result.detail} (${state})`);
}

async function unusedCollectionsNames() {
	try {
		const stdout = await new Promise((resolve) => {
			execFile(
				"qmd",
				["collection", "list"],
				{ timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
				(_err, out) => resolve(String(out ?? "")),
			);
		});
		const live = [collectionFor(CORE), collectionFor(SHARED), ...listNsIds().map(collectionFor)];
		return unusedCollections(parseCollections(stdout), live);
	} catch {
		return [];
	}
}

initSearch().catch((err) => console.log(`[search] init failed: ${err.message}`));
