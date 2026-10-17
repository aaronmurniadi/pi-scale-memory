/**
 * Shared memory-file logic for the brain server and the agent-side cache.
 *
 * Everything here is a pure function of a memory directory, so the same code
 * serves both the authoritative copy on the brain and the offline mirror on an
 * agent. Layout under a memory dir:
 *   MEMORY.md            — curated long-term memory
 *   SCRATCHPAD.md        — checklist
 *   daily/YYYY-MM-DD.md  — append-only daily logs
 */
import fs from "node:fs";
import path from "node:path";

const CONTEXT_CLIP = { scratchpad: 4000, daily: 6000, longTerm: 8000, yesterday: 4000 };

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

/** Same section order as the injected memory block: scratchpad, today, long-term, yesterday. */
export function buildContext(dir) {
	const sections = [];
	const open = loadScratchpad(dir).filter((i) => !i.done);
	if (open.length) {
		sections.push(`## SCRATCHPAD.md (working context)\n\n${clip(serializeScratchpad(open), CONTEXT_CLIP.scratchpad, "start")}`);
	}
	const today = todayStr();
	const todayContent = readSafe(dailyPath(dir, today));
	if (todayContent?.trim()) {
		sections.push(`## Daily log: ${today} (today)\n\n${clip(todayContent, CONTEXT_CLIP.daily, "end")}`);
	}
	const longTerm = readSafe(memoryPath(dir));
	if (longTerm?.trim()) {
		sections.push(`## MEMORY.md (long-term)\n\n${clip(longTerm, CONTEXT_CLIP.longTerm, "start")}`);
	}
	const yesterday = yesterdayStr();
	const yesterdayContent = readSafe(dailyPath(dir, yesterday));
	if (yesterdayContent?.trim()) {
		sections.push(`## Daily log: ${yesterday} (yesterday)\n\n${clip(yesterdayContent, CONTEXT_CLIP.yesterday, "end")}`);
	}
	if (!sections.length) return "";
	return `# Memory\n\n${sections.join("\n\n---\n\n")}`;
}

export function tokenize(s) {
	return (s.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []).filter((t) => t.length > 1);
}

/** BM25 over paragraphs. Shared so the cache ranks exactly like the brain. */
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

/** Every file in the memory dir, for mirroring to an agent cache. */
export function snapshotFiles(dir) {
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
