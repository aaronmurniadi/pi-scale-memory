/**
 * Agent-side mirror of the brain's memory files.
 *
 * The brain stays authoritative: reads and searches hit it first, and the cache
 * is only consulted when it is unreachable. The mirror reuses the brain's own
 * context builder and BM25 ranking (brain/memory.mjs), so an offline answer is
 * ranked and trimmed exactly like an online one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildContext, dailyPath, listDaily, readSafe, searchIn } from "../brain/memory.mjs";
import type { BrainClient, SearchResponse } from "./client.js";
import { CONFIG_DIR } from "./config.js";

export type MemorySource = "brain" | "cache";

export interface CacheMeta {
	takenAt: string;
	brain: string;
	files: number;
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
		return { takenAt: String(raw.takenAt ?? ""), brain: String(raw.brain ?? ""), files: Number(raw.files ?? 0) };
	} catch {
		return null;
	}
}

export function hasCache(dir: string): boolean {
	return metaOf(dir) !== null;
}

/** Pull the full memory tree from the brain and mirror it. Deletions propagate. */
export async function syncCache(client: BrainClient, dir: string): Promise<CacheMeta> {
	const snap = await client.snapshot();
	const files: Record<string, string> = snap.files ?? {};
	fs.mkdirSync(path.join(dir, "daily"), { recursive: true });

	const kept = new Set<string>();
	for (const name of Object.keys(files)) {
		// A compromised or buggy brain must not be able to write outside the cache dir.
		if (!ALLOWED.test(name)) continue;
		const dest = path.join(dir, name);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, files[name], "utf-8");
		kept.add(name);
	}

	for (const date of listDaily(dir)) {
		const name = `daily/${date}.md`;
		if (kept.has(name)) continue;
		fs.rmSync(dailyPath(dir, date), { force: true });
	}
	for (const name of ["MEMORY.md", "SCRATCHPAD.md"]) {
		if (kept.has(name)) continue;
		fs.rmSync(path.join(dir, name), { force: true });
	}

	const meta: CacheMeta = {
		takenAt: String(snap.takenAt ?? ""),
		brain: client.brainName,
		files: kept.size,
	};
	fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), "utf-8");
	return meta;
}

/** Same shape as the brain's /v1/read, served from the mirror. */
export function readFromCache(dir: string, target: string, date?: string): Record<string, unknown> {
	if (target === "list") {
		return { files: listDaily(dir) };
	}
	if (target === "long_term") {
		return { content: readSafe(path.join(dir, "MEMORY.md")) ?? "" };
	}
	if (target === "scratchpad") {
		return { content: readSafe(path.join(dir, "SCRATCHPAD.md")) ?? "" };
	}
	if (target === "daily") {
		let day = date ?? "";
		if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = todayLocal();
		return { content: readSafe(dailyPath(dir, day)) ?? "" };
	}
	throw new Error(`unknown target: ${target}`);
}

function todayLocal(): string {
	const d = new Date();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

export async function readWithFallback(
	client: BrainClient | null,
	dir: string,
	target: string,
	date?: string,
): Promise<Sourced<Record<string, unknown>>> {
	let failure: unknown = null;
	if (client) {
		try {
			const res = await client.read(target, date);
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
	return { source: "cache", takenAt: meta?.takenAt ?? null, value: readFromCache(dir, target, date) };
}

export interface CacheSearch extends SearchResponse {
	source: MemorySource;
	takenAt: string | null;
}

/**
 * The brain answers with qmd when it is installed. The offline mirror only has
 * its own BM25 index, so cached results are reported as engine "bm25".
 */
export async function searchWithFallback(
	client: BrainClient | null,
	dir: string,
	query: string,
	limit: number,
	mode?: string,
): Promise<CacheSearch> {
	let failure: unknown = null;
	if (client) {
		try {
			const res = await client.search(query, limit, mode);
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
		takenAt: meta?.takenAt ?? null,
		engine: "bm25",
		mode: "keyword",
		results: searchIn(dir, query, limit),
	};
}

/** Session-start snapshot: live context when reachable, otherwise the mirror. */
export async function contextWithFallback(client: BrainClient | null, dir: string): Promise<Sourced<string>> {
	let failure: unknown = null;
	if (client) {
		try {
			return { source: "brain", takenAt: null, value: await client.context() };
		} catch (err) {
			failure = err;
		}
	}
	if (!hasCache(dir)) {
		if (failure) throw failure;
		return { source: "cache", takenAt: null, value: "" };
	}
	const meta = metaOf(dir);
	return { source: "cache", takenAt: meta?.takenAt ?? null, value: buildContext(dir) };
}
