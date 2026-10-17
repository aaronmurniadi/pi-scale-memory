#!/usr/bin/env node
/**
 * pi-scale-memory brain server.
 *
 * Run this on the machine tagged `tag:brain` in your tailnet. Agents find the
 * machine through the tailnet tag and talk to this HTTP API. Storage layout
 * mirrors pi-memory:
 *   <dir>/MEMORY.md, <dir>/SCRATCHPAD.md, <dir>/daily/YYYY-MM-DD.md
 *
 * Env: BRAIN_DIR (default ~/.pi-scale-brain), BRAIN_PORT (8787),
 *      BRAIN_HOST (0.0.0.0), BRAIN_TOKEN (optional shared bearer token)
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DIR = process.env.BRAIN_DIR || path.join(os.homedir(), ".pi-scale-brain");
const PORT = Number(process.env.BRAIN_PORT || 8787);
const HOST = process.env.BRAIN_HOST || "0.0.0.0";
const TOKEN = process.env.BRAIN_TOKEN || "";
const MEMORY_FILE = path.join(DIR, "MEMORY.md");
const SCRATCHPAD_FILE = path.join(DIR, "SCRATCHPAD.md");
const DAILY_DIR = path.join(DIR, "daily");
const MAX_BODY = 2 * 1024 * 1024;

fs.mkdirSync(DAILY_DIR, { recursive: true });

const pad2 = (n) => String(n).padStart(2, "0");
const dateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => dateStr(new Date());
const yesterday = () => dateStr(new Date(Date.now() - 86400000));
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const dailyPath = (date) => path.join(DAILY_DIR, `${date}.md`);

function readSafe(p) {
	try {
		return fs.readFileSync(p, "utf-8");
	} catch {
		return null;
	}
}

function appendBlock(p, block) {
	const existing = readSafe(p) || "";
	let sep = "";
	if (existing.trim()) sep = "\n\n";
	fs.writeFileSync(p, existing + sep + block, "utf-8");
}

function tag(agent, session) {
	let who = agent || "agent";
	if (session) who += `:${session}`;
	return `<!-- ${stamp()} [${who}] -->`;
}

function dateOrToday(d) {
	if (isDate(d)) return d;
	return today();
}

// --- scratchpad (same format as pi-memory) ---
function parseScratchpad(content) {
	const items = [];
	for (const line of content.split("\n")) {
		const m = line.match(/^- \[([ xX])\] (.*)$/);
		if (m) items.push({ done: m[1] !== " ", text: m[2] });
	}
	return items;
}
function markOf(item) {
	if (item.done) return "x";
	return " ";
}
function serializeScratchpad(items) {
	return items.map((i) => `- [${markOf(i)}] ${i.text}`).join("\n") + "\n";
}
function loadScratchpad() {
	return parseScratchpad(readSafe(SCRATCHPAD_FILE) || "");
}

function listDaily() {
	return fs
		.readdirSync(DAILY_DIR)
		.filter((f) => f.endsWith(".md"))
		.map((f) => f.slice(0, -3))
		.sort()
		.reverse();
}

// --- context snapshot ---
function clip(text, maxChars, mode) {
	if (text.length <= maxChars) return text;
	if (mode === "end") return `...[truncated]\n${text.slice(-maxChars)}`;
	return `${text.slice(0, maxChars)}\n[truncated]...`;
}

function buildContext() {
	const sections = [];
	const open = loadScratchpad().filter((i) => !i.done);
	if (open.length) sections.push(`## SCRATCHPAD.md (working context)\n\n${clip(serializeScratchpad(open), 4000, "start")}`);
	const t = readSafe(dailyPath(today()));
	if (t?.trim()) sections.push(`## Daily log: ${today()} (today)\n\n${clip(t, 6000, "end")}`);
	const lt = readSafe(MEMORY_FILE);
	if (lt?.trim()) sections.push(`## MEMORY.md (long-term)\n\n${clip(lt, 8000, "start")}`);
	const y = readSafe(dailyPath(yesterday()));
	if (y?.trim()) sections.push(`## Daily log: ${yesterday()} (yesterday)\n\n${clip(y, 4000, "end")}`);
	if (!sections.length) return "";
	return `# Memory\n\n${sections.join("\n\n---\n\n")}`;
}

// --- search (BM25 over paragraphs) ---
function tokenize(s) {
	return (s.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []).filter((t) => t.length > 1);
}

function search(query, limit) {
	const q = tokenize(query);
	if (!q.length) return [];
	const docs = [];
	const files = [["MEMORY.md", readSafe(MEMORY_FILE)], ["SCRATCHPAD.md", readSafe(SCRATCHPAD_FILE)]];
	for (const d of listDaily()) files.push([`daily/${d}.md`, readSafe(dailyPath(d))]);
	for (const [file, content] of files) {
		if (!content) continue;
		for (const para of content.split(/\n{2,}/)) {
			const tokens = tokenize(para);
			if (tokens.length) docs.push({ file, text: para.trim(), tokens });
		}
	}
	const N = docs.length;
	const avg = docs.reduce((a, d) => a + d.tokens.length, 0) / Math.max(N, 1);
	const df = new Map();
	for (const t of new Set(q)) df.set(t, docs.filter((d) => d.tokens.includes(t)).length);
	const k1 = 1.2;
	const b = 0.75;
	const scored = [];
	for (const d of docs) {
		let score = 0;
		for (const t of new Set(q)) {
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

// --- handlers ---
function handleWrite(body) {
	const { target, content, mode, agent, session } = body;
	if (typeof content !== "string" || !content.trim()) throw httpErr(400, "content required");
	if (target === "daily") {
		const date = dateOrToday(body.date);
		appendBlock(dailyPath(date), `${tag(agent, session)}\n${content.trim()}`);
		return { ok: true, file: `daily/${date}.md` };
	}
	if (target === "long_term") {
		if (mode === "overwrite") fs.writeFileSync(MEMORY_FILE, content.trim() + "\n", "utf-8");
		else appendBlock(MEMORY_FILE, `${tag(agent, session)}\n${content.trim()}`);
		return { ok: true, file: "MEMORY.md" };
	}
	throw httpErr(400, "unknown target");
}

function handleScratchpad(body) {
	const { action, text, agent } = body;
	const items = loadScratchpad();
	const save = () => fs.writeFileSync(SCRATCHPAD_FILE, serializeScratchpad(items), "utf-8");
	const needle = (text || "").toLowerCase();
	if (action === "add") {
		if (!needle) throw httpErr(400, "text required");
		items.push({ done: false, text: `${text.trim()} <!-- ${stamp()} [${agent || "agent"}] -->` });
		save();
	} else if (action === "done" || action === "undo") {
		const want = action === "done";
		const it = items.find((i) => i.done !== want && i.text.toLowerCase().includes(needle));
		if (!it) throw httpErr(404, "no matching item");
		it.done = want;
		save();
	} else if (action === "clear_done") {
		const kept = items.filter((i) => !i.done);
		items.length = 0;
		items.push(...kept);
		save();
	} else if (action !== "list") {
		throw httpErr(400, "unknown action");
	}
	return { ok: true, items };
}

function handleForget(body) {
	const match = (body.match || "").toLowerCase();
	if (!match) throw httpErr(400, "match required");
	let file = MEMORY_FILE;
	if (body.target === "daily") file = dailyPath(dateOrToday(body.date));
	const content = readSafe(file);
	if (!content) return { ok: true, removed: 0 };
	const paras = content.split(/\n{2,}/);
	const kept = paras.filter((p) => !p.toLowerCase().includes(match));
	const removed = paras.length - kept.length;
	if (removed) {
		const recovery = path.join(DIR, "recovery");
		fs.mkdirSync(recovery, { recursive: true });
		const id = `${Date.now()}`;
		fs.writeFileSync(path.join(recovery, `${id}.json`), JSON.stringify({ file: path.basename(file), removed: paras.filter((p) => p.toLowerCase().includes(match)) }, null, 2));
		fs.writeFileSync(file, kept.join("\n\n"), "utf-8");
		return { ok: true, removed, recoveryId: id };
	}
	return { ok: true, removed: 0 };
}

function handleRead(q) {
	const target = q.get("target");
	if (target === "list") return { files: listDaily() };
	if (target === "long_term") return { content: readSafe(MEMORY_FILE) || "" };
	if (target === "scratchpad") return { content: readSafe(SCRATCHPAD_FILE) || "" };
	if (target === "daily") {
		const date = q.get("date");
		return { content: readSafe(dailyPath(dateOrToday(date))) || "" };
	}
	throw httpErr(400, "unknown target");
}

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

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

const server = http.createServer(async (req, res) => {
	const send = (status, obj) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(obj));
	};
	try {
		if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) throw httpErr(401, "unauthorized");
		const url = new URL(req.url, "http://brain");
		const route = `${req.method} ${url.pathname}`;
		if (route === "GET /v1/health") return send(200, { ok: true, role: "brain", date: today() });
		if (route === "GET /v1/context") return send(200, { context: buildContext() });
		if (route === "GET /v1/read") return send(200, handleRead(url.searchParams));
		if (route === "GET /v1/search") {
			const limit = Math.min(Number(url.searchParams.get("limit")) || 5, 20);
			return send(200, { results: search(url.searchParams.get("q") || "", limit) });
		}
		if (route === "POST /v1/write") return send(200, handleWrite(await readBody(req)));
		if (route === "POST /v1/scratchpad") return send(200, handleScratchpad(await readBody(req)));
		if (route === "POST /v1/forget") return send(200, handleForget(await readBody(req)));
		throw httpErr(404, "not found");
	} catch (e) {
		send(e.status || 500, { error: e.message });
	}
});

server.listen(PORT, HOST, () => console.log(`pi-scale-memory brain listening on ${HOST}:${PORT}, dir=${DIR}`));
