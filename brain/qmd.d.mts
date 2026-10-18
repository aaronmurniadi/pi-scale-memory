/** Types for brain/qmd.mjs. */

export type SearchMode = "keyword" | "semantic" | "deep";

export interface QmdHit {
	file: string;
	score: number;
	text: string;
	line: number | null;
	/** Which of the queried collections answered, so the caller can label the tier. */
	collection: string;
}

export interface QmdResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	err?: unknown;
}

export const COLLECTION: string;
export const COLLECTION_PREFIX: string;
export const MODE_SUBCOMMAND: Record<SearchMode, string>;

/** `psm-<ns>`: one collection per tier, since qmd filters by collection, not path. */
export function collectionFor(ns: string): string;

export function stripAnsi(text: unknown): string;
export function parseQmdJson(stdout: string): unknown;
export function clampLimit(value: number | undefined, fallback?: number, max?: number): number;
export function normalizeMode(value: string | null | undefined): SearchMode;
export function relativeFile(file: string | undefined, collection: string | string[]): string;
export function collectionOf(file: string | undefined, collection: string | string[]): string;
export function normalizeHits(raw: unknown, collection: string | string[]): QmdHit[];
export function qmdArgs(mode: string, collection: string | string[], query: string, limit: number): string[];
export function modeTimeoutMs(mode: string): number;
export function parseCollections(stdout: string): string[];
export function unusedCollections(names: string[], live?: string[]): string[];
export function updateMode(): "background" | "manual" | "off";

export function detectQmd(): Promise<boolean>;
export function hasCollection(collection?: string): Promise<boolean>;
export function ensureCollection(dir: string, collection?: string): Promise<boolean>;
export function updateIndex(): Promise<QmdResult>;
export function embedIndex(collection?: string): Promise<QmdResult>;
export function qmdSearch(
	mode: string,
	query: string,
	limit: number,
	collection?: string | string[],
): Promise<{ results: QmdHit[]; stderr: string }>;

export function scheduleIndexRefresh(reason?: string, collections?: string[]): void;
export function refreshIndex(reason?: string, collections?: string[]): Promise<{ ok: boolean; detail: string }>;
export function isIndexing(): boolean;
export function isIndexDirty(): boolean;
export function waitForIndex(maxMs: number): Promise<boolean>;
export function resetCaches(): void;
