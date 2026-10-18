/**
 * Agent-side mirror of the brain's memory files.
 *
 * The brain stays authoritative: reads and searches hit it first, and the cache is
 * only consulted when it is unreachable. The mirror keeps the brain's own layout
 * (core/, shared/, ns/<id>/) under the cache dir, so the context builder and the
 * BM25 ranker in brain/memory.mjs work on a mirror exactly as they do on the brain.
 *
 * An agent mirrors the two cross-project tiers plus the project it is working in,
 * never every project: the download and the offline surface both stay bounded.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	buildContext,
	CORE,
	coreDir,
	dailyPath,
	DEFAULT_NS,
	isShared,
	isValidNs,
	listDaily,
	memoryPath,
	readSafe,
	scratchpadPath,
	searchTiers,
	SHARED,
	sharedDir,
	tierDir,
} from "../brain/memory.mjs";
import type { BrainClient, SearchResponse, SearchScope, Snapshot } from "./client.js";
import { CONFIG_DIR } from "./config.js";

export type MemorySource = "brain" | "cache";

export interface CacheMeta {
	takenAt: string;
	brain: string;
	files: number;
	/** The project mirrored alongside core and shared. */
	ns: string | null;
	/** When each tier was last refreshed, so an older project copy is not labelled as fresh. */
	nsTakenAt: Record<string, string>;
}

export interface Sourced<T> {
	source: MemorySource;
	/** When the mirror was taken. null for live brain reads. */
	takenAt: string | null;
	value: T;
}

const ALLOWED = /^(MEMORY\.md|SCRATCHPAD\.md|daily\/\d{4}-\d{2}-\d{2}\.md)$/;

export function cacheDir(base = CONFIG_DIR): string {
	return path.join(base, "cache");
}

function metaPath(dir: string): string {
	return path.join(dir, "meta.json");
}

export function metaOf(dir: string): CacheMeta | null {
	try {
		const raw = JSON.parse(fs.readFileSync(metaPath(dir), "utf-8"));
		const nsTakenAt: Record<string, string> = {};
		if (raw.nsTakenAt && typeof raw.nsTakenAt === "object") {
			for (const [key, value] of Object.entries(raw.nsTakenAt)) nsTakenAt[key] = String(value);
		}
		return {
			takenAt: String(raw.takenAt ?? ""),
			brain: String(raw.brain ?? ""),
			files: Number(raw.files ?? 0),
			ns: raw.ns ? String(raw.ns) : null,
			nsTakenAt,
		};
	} catch {
		return null;
	}
}

/** When this tier's copy was taken: its own timestamp when it has one, else the last sync. */
function staleAt(meta: CacheMeta | null, ns: string | null): string | null {
	if (!meta) return null;
	let key = ns ?? "";
	if (ns === CORE) key = CORE;
	else if (isShared(ns ?? "")) key = SHARED;
	return meta.nsTakenAt[key] ?? meta.takenAt;
}

export function hasCache(dir: string): boolean {
	return metaOf(dir) !== null;
}

/** Write one tier's whitelisted files, and drop any it no longer has. */
function writeTier(dir: string, files: Record<string, string>): number {
	fs.mkdirSync(path.join(dir, "daily"), { recursive: true });
	const kept = new Set<string>();
	for (const name of Object.keys(files)) {
		// A compromised or buggy brain must not be able to write outside the tier dir.
		if (!ALLOWED.test(name)) continue;
		const dest = path.join(dir, name);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, files[name], "utf-8");
		kept.add(name);
	}
	for (const date of listDaily(dir)) {
		if (!kept.has(`daily/${date}.md`)) fs.rmSync(dailyPath(dir, date), { force: true });
	}
	for (const name of ["MEMORY.md", "SCRATCHPAD.md"]) {
		if (!kept.has(name)) fs.rmSync(path.join(dir, name), { force: true });
	}
	return kept.size;
}

/** Pull the cross-project tiers and one project from the brain. Deletions propagate. */
export async function syncCache(client: BrainClient, dir: string, ns: string | null = null): Promise<CacheMeta> {
	const snap: Snapshot = await client.snapshot(ns);
	fs.mkdirSync(dir, { recursive: true });

	const previous = metaOf(dir);
	const takenAt = String(snap.takenAt ?? "");
	// Everything refreshed in this pass shares one timestamp. A project this session
	// is not in keeps its own, so an old copy is never labelled as freshly taken.
	const nsTakenAt: Record<string, string> = { ...(previous?.nsTakenAt ?? {}), [CORE]: takenAt, [SHARED]: takenAt };

	let count = writeTier(coreDir(dir), snap.core?.files ?? {});
	count += writeTier(sharedDir(dir), snap.shared?.files ?? {});

	const project = snap.project;
	if (project && isValidNs(project.id) && !isShared(project.id)) {
		count += writeTier(tierDir(dir, project.id), project.files ?? {});
		nsTakenAt[project.id] = takenAt;
		// Other projects stay mirrored on purpose: several sessions on one machine
		// share this cache directory, and evicting a project another session is
		// working in would leave that session reading an empty project tier offline.
	}

	const meta: CacheMeta = {
		takenAt,
		brain: client.brainName,
		files: count,
		ns: project?.id ?? null,
		nsTakenAt,
	};
	fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), "utf-8");
	return meta;
}

/** Which tier a namespace id points at, for the mirror. */
function scopeOfNs(ns: string | null): string {
	if (ns === CORE) return CORE;
	if (ns && isShared(ns)) return SHARED;
	return "project";
}

/** The mirror directory a scope reads from. */
function dirForScope(dir: string, scope: string, ns: string | null): string {
	if (scope === CORE) return coreDir(dir);
	if (scope === SHARED) return sharedDir(dir);
	if (scope === "legacy") return tierDir(dir, DEFAULT_NS);
	if (ns && isValidNs(ns) && !isShared(ns)) return tierDir(dir, ns);
	return "";
}

/** Same shape as the brain's /v1/read, served from the mirror. */
export function readFromCache(dir: string, target: string, ns: string | null, date?: string): Record<string, unknown> {
	const tierDirPath = dirForScope(dir, scopeOfNs(ns), ns);
	if (!tierDirPath) throw new Error("no project memory is mirrored yet");
	if (target === "list") return { files: listDaily(tierDirPath) };
	if (target === "long_term") return { content: readSafe(memoryPath(tierDirPath)) ?? "" };
	if (target === "scratchpad") return { content: readSafe(scratchpadPath(tierDirPath)) ?? "" };
	if (target === "daily") {
		let day = date ?? "";
		if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = todayLocal();
		return { content: readSafe(dailyPath(tierDirPath, day)) ?? "" };
	}
	throw new Error(`unknown target: ${target}`);
}

function todayLocal(): string {
	const d = new Date();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

export interface TierReadOptions {
	ns?: string | null;
	scope?: string;
	date?: string;
}

export async function readWithFallback(
	client: BrainClient | null,
	dir: string,
	target: string,
	opts: TierReadOptions = {},
): Promise<Sourced<Record<string, unknown>>> {
	const ns = opts.ns ?? null;
	let failure: unknown = null;
	if (client) {
		try {
			const res = await client.read(target, { ns, date: opts.date });
			return { source: "brain", takenAt: null, value: res };
		} catch (err) {
			failure = err;
		}
	}
	if (!hasCache(dir)) {
		if (failure) throw failure;
		throw new Error("brain is not connected and there is no cached memory yet");
	}
	const meta = metaOf(dir);
	return { source: "cache", takenAt: staleAt(meta, ns), value: readFromCache(dir, target, ns, opts.date) };
}

export interface CacheSearch extends SearchResponse {
	source: MemorySource;
	takenAt: string | null;
}

/**
 * The brain answers with qmd when it is installed. The offline mirror only has its
 * own BM25 index, so cached results are reported as engine "bm25".
 */
export async function searchWithFallback(
	client: BrainClient | null,
	dir: string,
	query: string,
	limit: number,
	opts: { mode?: string; ns?: string | null; scope?: SearchScope } = {},
): Promise<CacheSearch> {
	const ns = opts.ns ?? null;
	const scope = opts.scope ?? "all";
	let failure: unknown = null;
	if (client) {
		try {
			const res = await client.search(query, limit, opts.mode, { ns, scope });
			return { ...res, source: "brain", takenAt: null };
		} catch (err) {
			failure = err;
		}
	}
	if (!hasCache(dir)) {
		if (failure) throw failure;
		throw new Error("brain is not connected and there is no cached memory yet");
	}
	const meta = metaOf(dir);
	return {
		source: "cache",
		takenAt: staleAt(meta, ns),
		engine: "bm25",
		mode: "keyword",
		scope,
		results: searchTiers(dir, ns, query, limit, scope),
	};
}

/** Session-start snapshot: live context when reachable, otherwise the mirror. */
export async function contextWithFallback(
	client: BrainClient | null,
	dir: string,
	ns: string | null = null,
): Promise<Sourced<string>> {
	let failure: unknown = null;
	if (client) {
		try {
			return { source: "brain", takenAt: null, value: await client.context(ns) };
		} catch (err) {
			failure = err;
		}
	}
	if (!hasCache(dir)) {
		if (failure) throw failure;
		return { source: "cache", takenAt: null, value: "" };
	}
	const meta = metaOf(dir);
	return { source: "cache", takenAt: staleAt(meta, ns), value: buildContext(dir, ns) };
}
