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

export function pad2(n: number): string;
export function dateStr(d: Date): string;
export function todayStr(): string;
export function yesterdayStr(): string;
export function isDate(s: string | undefined): boolean;
export function memoryPath(dir: string): string;
export function scratchpadPath(dir: string): string;
export function dailyDir(dir: string): string;
export function dailyPath(dir: string, date: string): string;
export function readSafe(p: string): string | null;
export function listDaily(dir: string): string[];
export function markOf(item: ScratchpadItem): string;
export function parseScratchpad(content: string): ScratchpadItem[];
export function serializeScratchpad(items: ScratchpadItem[]): string;
export function loadScratchpad(dir: string): ScratchpadItem[];
export function clip(text: string, maxChars: number, mode: "start" | "end"): string;
export function buildContext(dir: string): string;
export function tokenize(s: string): string[];
export function searchIn(dir: string, query: string, limit: number): SearchHit[];
export function snapshotFiles(dir: string): Record<string, string>;
