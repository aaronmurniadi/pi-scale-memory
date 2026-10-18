/** Types for brain/memory.mjs so the extension can reuse the exact same logic. */

export interface ScratchpadItem {
	done: boolean;
	text: string;
}

export interface SearchHit {
	file: string;
	score: number;
	text: string;
}

export interface TieredHit extends SearchHit {
	tier: string;
}

/** Tier ids. Core is not a namespace: /v1/core is its only writer. */
export const CORE: "core";
export const SHARED: "shared";
export const DEFAULT_NS: string;

export const BUDGETS: { core: number; shared: number; longTerm: number; scratchpad: number; today: number; yesterday: number };
export const TOTAL_CONTEXT_CHARS: number;

export function pad2(n: number): string;
export function dateStr(d: Date): string;
export function todayStr(): string;
export function yesterdayStr(): string;
export function isDate(s: string | undefined): boolean;
export function isValidNs(id: unknown): boolean;
export function isShared(id: string): boolean;
export function approxTokens(text: unknown): number;

export function coreDir(root: string): string;
export function sharedDir(root: string): string;
export function nsDir(root: string, ns: string): string;
export function tierDir(root: string, ns: string): string;
export function memoryPath(dir: string): string;
export function scratchpadPath(dir: string): string;
export function dailyDir(dir: string): string;
export function dailyPath(dir: string, date: string): string;
export function recoveryDir(dir: string): string;
export function readSafe(p: string): string | null;
export function listDaily(dir: string): string[];
export function markOf(item: ScratchpadItem): string;
export function parseScratchpad(content: string): ScratchpadItem[];
export function serializeScratchpad(items: ScratchpadItem[]): string;
export function loadScratchpad(dir: string): ScratchpadItem[];
export function clip(text: string, maxChars: number, mode: "start" | "end"): string;

export function normalizeText(text: unknown): string;
export function tokenize(s: string): string[];
export function similarity(a: string[], b: string[]): number;
export function writeEntry(
	file: string,
	block: string,
	text: string,
	opts?: { dedup?: boolean; threshold?: number },
): { deduped: boolean; created?: boolean; replaced?: number; score?: number };
export function appendBlock(file: string, block: string): void;

export function buildContext(root: string, ns?: string | null): string;
export function tierSizes(root: string, ns?: string | null): Record<string, number>;

export function searchIn(dir: string, query: string, limit: number): SearchHit[];
export function scopeDirs(root: string, ns: string | null, scope: string): [string, string][];
export function searchTiers(root: string, ns: string | null, query: string, limit: number, scope?: string): TieredHit[];

export function snapshotTier(dir: string): Record<string, string>;
export function migrateFlat(root: string): { migrated: boolean; moved: string[] };
