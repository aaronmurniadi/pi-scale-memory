/**
 * Shared memory-file logic for the brain server and the agent-side cache.
 *
 * Three tiers share one layout, so the same functions serve the brain's
 * authoritative copy and an agent's offline mirror of it:
 *
 *   core/MEMORY.md              human-authored; written only by /core-memory
 *   shared/MEMORY.md            agent-managed memory that applies to every project
 *   ns/<id>/MEMORY.md           one git repository (see src/namespace.ts)
 *   ns/<id>/SCRATCHPAD.md       its working checklist
 *   ns/<id>/daily/YYYY-MM-DD.md its append-only log
 *   ns/<id>/recovery/*.json     pre-delete copies
 *
 * The core and shared tiers hold exactly one file each. A scratchpad needs to be
 * ticked off and a daily log is a log, so both are project concepts: core refuses
 * every agent write, and shared is a curated file rather than a growing stream.
 *
 * Every tier is injected into the system prompt, so the context builder works to
 * a budget and drops the least valuable sections first (yesterday before today,
 * everything before core). Sizes are measured in characters; tokens are reported
 * as a rough char/4 estimate.
 */
import fs from "node:fs";
import path from "node:path";

export const CORE = "core";
export const SHARED = "shared";
/** Namespace for memory written before tiering existed, and for callers that name none. */
export const DEFAULT_NS = "legacy";

/** Char budgets per injected section. Total is the ceiling for the whole block. */
export const BUDGETS = { core: 2_000, shared: 3_000, longTerm: 8_000, scratchpad: 4_000, today: 6_000, yesterday: 4_000 };
export const TOTAL_CONTEXT_CHARS = 12_000;

/** Two entries this similar are the same note written twice; the newer replaces the older. */
const DEDUP_SIMILARITY = 0.8;

const NS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function pad2(n) {
	return String(n).padStart(2, "0");
}

export function dateStr(d) {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayStr() {
	return dateStr(new Date());
}

export function yesterdayStr() {
	return dateStr(new Date(Date.now() - 86400000));
}

export function isDate(s) {
	return /^\d{4}-\d{2}-\d{2}$/.test(s || "");
}

/**
 * A namespace id is a directory name, so it is validated rather than escaped.
 * `core` is not a namespace: it is reached only through /v1/core.
 */
export function isValidNs(id) {
	if (typeof id !== "string") return false;
	if (!NS_PATTERN.test(id)) return false;
	return id !== CORE;
}

export function isShared(id) {
	return id === SHARED;
}

export function approxTokens(text) {
	return Math.ceil(String(text ?? "").length / 4);
}

export function coreDir(root) {
	return path.join(root, CORE);
}

export function sharedDir(root) {
	return path.join(root, SHARED);
}

export function nsDir(root, ns) {
	return path.join(root, "ns", ns);
}

/** The directory backing a namespace id, shared included. */
export function tierDir(root, ns) {
	if (isShared(ns)) return sharedDir(root);
	return nsDir(root, ns);
}

export function memoryPath(dir) {
	return path.join(dir, "MEMORY.md");
}

export function scratchpadPath(dir) {
	return path.join(dir, "SCRATCHPAD.md");
}

export function dailyDir(dir) {
	return path.join(dir, "daily");
}

export function dailyPath(dir, date) {
	return path.join(dailyDir(dir), `${date}.md`);
}

export function recoveryDir(dir) {
	return path.join(dir, "recovery");
}

export function readSafe(p) {
	try {
		return fs.readFileSync(p, "utf-8");
	} catch {
		return null;
	}
}

export function listDaily(dir) {
	try {
		return fs
			.readdirSync(dailyDir(dir))
			.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
			.map((f) => f.slice(0, -3))
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

export function markOf(item) {
	if (item.done) return "x";
	return " ";
}

export function parseScratchpad(content) {
	const items = [];
	for (const line of content.split("\n")) {
		const m = line.match(/^- \[([ xX])\] (.*)$/);
		if (m) items.push({ done: m[1] !== " ", text: m[2] });
	}
	return items;
}

export function serializeScratchpad(items) {
	return items.map((i) => `- [${markOf(i)}] ${i.text}`).join("\n") + "\n";
}

export function loadScratchpad(dir) {
	return parseScratchpad(readSafe(scratchpadPath(dir)) || "");
}

export function clip(text, maxChars, mode) {
	if (text.length <= maxChars) return text;
	if (mode === "end") return `...[truncated]\n${text.slice(-maxChars)}`;
	return `${text.slice(0, maxChars)}\n[truncated]...`;
}

// ---------------------------------------------------------------------------
// Writing: append, or replace the entry this one restates
// ---------------------------------------------------------------------------

/** Text with stamps, punctuation and case removed, for "is this the same note?" checks. */
export function normalizeText(text) {
	return String(text ?? "")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export function tokenize(s) {
	return (s.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []).filter((t) => t.length > 1);
}

/** Jaccard overlap of two token sets: 1 is identical, 0 shares nothing. */
export function similarity(a, b) {
	const left = new Set(a);
	const right = new Set(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const t of left) if (right.has(t)) shared++;
	return shared / (left.size + right.size - shared);
}

/**
 * Write one entry to a MEMORY.md-style file.
 *
 * Agents restate themselves constantly ("brain is on port 8787" arrives twice from
 * two sessions). Appending both dilutes the prompt forever, so an entry that
 * restates an existing paragraph replaces it in place and the caller is told.
 * Pass `dedup: false` for files where repetition is meaningful.
 */
export function writeEntry(file, block, text, opts = {}) {
	const dedup = opts.dedup !== false;
	const threshold = opts.threshold ?? DEDUP_SIMILARITY;
	const existing = readSafe(file);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (!existing || !existing.trim()) {
		fs.writeFileSync(file, `${block}\n`, "utf-8");
		return { deduped: false, created: true };
	}
	if (dedup) {
		const paras = existing.split(/\n{2,}/);
		const incoming = tokenize(normalizeText(text));
		let bestIdx = -1;
		let bestScore = 0;
		for (let i = 0; i < paras.length; i++) {
			const score = similarity(tokenize(normalizeText(paras[i])), incoming);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		if (bestIdx >= 0 && bestScore >= threshold) {
			paras[bestIdx] = block;
			fs.writeFileSync(file, `${paras.join("\n\n")}\n`, "utf-8");
			return { deduped: true, replaced: bestIdx, score: Number(bestScore.toFixed(2)) };
		}
	}
	fs.writeFileSync(file, `${existing.replace(/\s*$/, "")}\n\n${block}\n`, "utf-8");
	return { deduped: false };
}

/** Append to an append-only file (daily logs), no dedup: repetition there is history. */
export function appendBlock(file, block) {
	const existing = readSafe(file) || "";
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let sep = "";
	if (existing.trim()) sep = "\n\n";
	fs.writeFileSync(file, existing + sep + block + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

/** Size below which a section is not worth keeping at all. */
const SECTION_FLOOR = 400;

function section(label, raw, budget, mode = "end") {
	if (!raw || !raw.trim()) return null;
	return { label, raw, mode, text: clip(raw, budget, mode) };
}

function readSection(label, file, budget, mode = "end") {
	return section(label, readSafe(file), budget, mode);
}

function renderSection(s) {
	let suffix = "";
	if (s.text.length !== s.raw.length) suffix = ` (truncated to ${s.text.length} of ${s.raw.length} chars)`;
	return `## ${s.label}${suffix} [${s.text.length} chars, ~${approxTokens(s.text)} tokens]\n\n${s.text}`;
}

/**
 * The injected memory block: core, shared, then the project's own memory.
 *
 * Each section starts at its own budget. When the whole block exceeds the ceiling,
 * the least valuable section is given whatever room is left before it is dropped,
 * and is only dropped when that room could not hold a useful fragment. Dropping a
 * section whole while half the budget sits idle is what used to evict the current
 * project's memory in favour of cross-project conventions.
 *
 * Sections are ordered core, shared, project memory, scratchpad, today, yesterday,
 * so core and shared are never dropped and are never the section being shrunk, and
 * the project's own memory outranks its logs and checklist.
 */
export function buildContext(root, ns) {
	const today = todayStr();
	const plan = [];
	plan.push(readSection("Core memory (human-authored, all projects)", memoryPath(coreDir(root)), BUDGETS.core));
	plan.push(readSection("Shared memory (agent-managed, all projects)", memoryPath(sharedDir(root)), BUDGETS.shared));

	if (ns && isValidNs(ns) && !isShared(ns)) {
		const dir = nsDir(root, ns);
		plan.push(readSection(`Project memory (${ns})`, memoryPath(dir), BUDGETS.longTerm));
		const open = loadScratchpad(dir).filter((i) => !i.done);
		if (open.length) {
			plan.push(section(`Scratchpad (${ns})`, serializeScratchpad(open), BUDGETS.scratchpad, "start"));
		}
		plan.push(readSection(`Daily log: ${today} (today, ${ns})`, dailyPath(dir, today), BUDGETS.today));
		plan.push(readSection(`Daily log: ${yesterdayStr()} (yesterday, ${ns})`, dailyPath(dir, yesterdayStr()), BUDGETS.yesterday));
	}

	const kept = plan.filter(Boolean);
	while (kept.length > 2) {
		const head = kept.slice(0, -1).reduce((sum, s) => sum + s.text.length, 0);
		const tail = kept[kept.length - 1];
		const room = TOTAL_CONTEXT_CHARS - head;
		if (room >= tail.text.length) break;
		if (room >= SECTION_FLOOR) {
			tail.text = clip(tail.raw, room, tail.mode);
			break;
		}
		kept.pop();
	}
	if (kept.length === 0) return "";

	return `# Memory\n\n${kept.map(renderSection).join("\n\n---\n\n")}`;
}

/** Rough size of each tier, for /memory ns: how much prompt budget is in use. */
export function tierSizes(root, ns) {
	const sizes = {
		core: (readSafe(memoryPath(coreDir(root))) ?? "").length,
		shared: (readSafe(memoryPath(sharedDir(root))) ?? "").length,
	};
	if (ns && isValidNs(ns) && !isShared(ns)) {
		const dir = nsDir(root, ns);
		sizes.project = (readSafe(memoryPath(dir)) ?? "").length;
		sizes.scratchpad = (readSafe(scratchpadPath(dir)) ?? "").length;
		sizes.daily = listDaily(dir).reduce((sum, date) => sum + (readSafe(dailyPath(dir, date)) ?? "").length, 0);
	}
	return sizes;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** BM25 over paragraphs of one directory's files. */
export function searchIn(dir, query, limit) {
	const terms = tokenize(query);
	if (!terms.length) return [];
	const docs = [];
	const files = [
		["MEMORY.md", readSafe(memoryPath(dir))],
		["SCRATCHPAD.md", readSafe(scratchpadPath(dir))],
	];
	for (const date of listDaily(dir)) files.push([`daily/${date}.md`, readSafe(dailyPath(dir, date))]);
	for (const [file, content] of files) {
		if (!content) continue;
		for (const para of content.split(/\n{2,}/)) {
			const tokens = tokenize(para);
			if (tokens.length) docs.push({ file, text: para.trim(), tokens });
		}
	}
	const N = docs.length;
	if (N === 0) return [];
	const avg = docs.reduce((a, d) => a + d.tokens.length, 0) / N;
	const df = new Map();
	const unique = [...new Set(terms)];
	for (const t of unique) df.set(t, docs.filter((d) => d.tokens.includes(t)).length);
	const k1 = 1.2;
	const b = 0.75;
	const scored = [];
	for (const d of docs) {
		let score = 0;
		for (const t of unique) {
			const f = d.tokens.filter((x) => x === t).length;
			if (!f) continue;
			const n = df.get(t) || 0;
			const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tokens.length) / avg));
		}
		if (score > 0) scored.push({ file: d.file, score: Number(score.toFixed(3)), text: clip(d.text, 1200, "start") });
	}
	scored.sort((a, c) => c.score - a.score);
	return scored.slice(0, limit);
}

/** The directory each tier searches, in the order results are ranked. */
export function scopeDirs(root, ns, scope) {
	const wanted = [];
	if (scope === "core" || scope === "all") wanted.push([CORE, coreDir(root)]);
	if (scope === "shared" || scope === "all") wanted.push([SHARED, sharedDir(root)]);
	if (scope === "project" || scope === "all") {
		if (ns && isValidNs(ns) && !isShared(ns)) wanted.push(["project", nsDir(root, ns)]);
	}
	if (scope === "legacy") wanted.push([DEFAULT_NS, nsDir(root, DEFAULT_NS)]);
	return wanted;
}

/** BM25 across tiers, each hit labelled with the tier it came from. */
export function searchTiers(root, ns, query, limit, scope = "all") {
	const merged = [];
	for (const [tier, dir] of scopeDirs(root, ns, scope)) {
		for (const hit of searchIn(dir, query, limit)) merged.push({ ...hit, tier });
	}
	merged.sort((a, b) => b.score - a.score);
	return merged.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Mirroring and migration
// ---------------------------------------------------------------------------

/** Every file in one memory directory, for mirroring to an agent cache. */
export function snapshotTier(dir) {
	const files = {};
	for (const name of ["MEMORY.md", "SCRATCHPAD.md"]) {
		const content = readSafe(path.join(dir, name));
		if (content !== null) files[name] = content;
	}
	for (const date of listDaily(dir)) {
		const content = readSafe(dailyPath(dir, date));
		if (content !== null) files[`daily/${date}.md`] = content;
	}
	return files;
}

function moveFile(from, to) {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	try {
		fs.renameSync(from, to);
	} catch {
		const content = readSafe(from);
		if (content === null) return false;
		fs.writeFileSync(to, content, "utf-8");
		fs.rmSync(from, { force: true });
	}
	return true;
}

/**
 * One-time move of the v0.1 flat layout into tiers.
 *
 * MEMORY.md and any open scratchpad items become the shared tier, because both are
 * cross-project agent-managed notes and core takes no agent writes. The originals,
 * and the old daily logs, are archived under the legacy namespace, which nothing
 * injects and which can be read by pinning it (/memory ns legacy).
 *
 * Idempotent: the flat files are moved away, so a second run finds nothing, and a
 * crash between the shared write and the move cannot duplicate content because the
 * shared append is deduplicated.
 */
export function migrateFlat(root) {
	const flatMemory = path.join(root, "MEMORY.md");
	const flatScratch = path.join(root, "SCRATCHPAD.md");
	const flatDaily = path.join(root, "daily");
	const present = [flatMemory, flatScratch, flatDaily].filter((p) => fs.existsSync(p));
	if (present.length === 0) return { migrated: false, moved: [] };

	const moved = [];
	fs.mkdirSync(nsDir(root, DEFAULT_NS), { recursive: true });

	if (fs.existsSync(flatMemory)) {
		const content = readSafe(flatMemory);
		if (content && content.trim()) {
			writeEntry(
				memoryPath(sharedDir(root)),
				content.trim(),
				content,
				{ dedup: true },
			);
			moved.push("MEMORY.md -> shared/MEMORY.md");
		}
		moveFile(flatMemory, path.join(nsDir(root, DEFAULT_NS), "MEMORY.md"));
	}

	if (fs.existsSync(flatScratch)) {
		const content = readSafe(flatScratch) ?? "";
		const open = parseScratchpad(content).filter((i) => !i.done);
		if (open.length) {
			const block = `### Carried over from the flat scratchpad\n\n${open.map((i) => `- ${i.text}`).join("\n")}`;
			const text = open.map((i) => i.text).join("\n");
			writeEntry(memoryPath(sharedDir(root)), block, text, { dedup: true });
			moved.push(`${open.length} open scratchpad item(s) -> shared/MEMORY.md`);
		}
		moveFile(flatScratch, path.join(nsDir(root, DEFAULT_NS), "SCRATCHPAD.md"));
	}

	if (fs.existsSync(flatDaily)) {
		let count = 0;
		for (const entry of fs.readdirSync(flatDaily)) {
			if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(entry)) continue;
			if (moveFile(path.join(flatDaily, entry), dailyPath(nsDir(root, DEFAULT_NS), entry.slice(0, -3)))) count++;
		}
		fs.rmSync(flatDaily, { recursive: true, force: true });
		moved.push(`${count} daily log(s) -> ns/${DEFAULT_NS}/daily/`);
	}

	return { migrated: true, moved };
}
