#!/usr/bin/env node
/**
 * pi-scale-memory brain server.
 *
 * Run this on the machine tagged `tag:brain`. Agents find it through the tailnet
 * tag and talk to this HTTP API; each agent also mirrors the memory files into a
 * local cache so it can keep reading while offline.
 *
 * Storage layout (see brain/memory.mjs): MEMORY.md, SCRATCHPAD.md, daily/*.md
 *
 * Env: BRAIN_DIR (default ~/.pi-scale-brain), BRAIN_PORT (8787),
 *      BRAIN_HOST (0.0.0.0), BRAIN_TOKEN (optional shared bearer token)
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
	buildContext,
	dailyPath,
	dateStr,
	isDate,
	listDaily,
	loadScratchpad,
	memoryPath,
	pad2,
	readSafe,
	scratchpadPath,
	searchIn,
	serializeScratchpad,
	snapshotFiles,
	todayStr,
} from "./memory.mjs";

const DIR = process.env.BRAIN_DIR || path.join(os.homedir(), ".pi-scale-brain");
const PORT = Number(process.env.BRAIN_PORT || 8787);
const HOST = process.env.BRAIN_HOST || "0.0.0.0";
const TOKEN = process.env.BRAIN_TOKEN || "";
const MAX_BODY = 2 * 1024 * 1024;

fs.mkdirSync(path.join(DIR, "daily"), { recursive: true });

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

function appendBlock(p, block) {
	const existing = readSafe(p) || "";
	let sep = "";
	if (existing.trim()) sep = "\n\n";
	fs.writeFileSync(p, existing + sep + block, "utf-8");
}

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

// --- handlers ---
function handleWrite(body) {
	const { target, content, mode, agent, session } = body;
	if (typeof content !== "string" || !content.trim()) throw httpErr(400, "content required");
	if (target === "daily") {
		const date = dateOrToday(body.date);
		appendBlock(dailyPath(DIR, date), `${tag(agent, session)}\n${content.trim()}`);
		return { ok: true, file: `daily/${date}.md` };
	}
	if (target === "long_term") {
		if (mode === "overwrite") fs.writeFileSync(memoryPath(DIR), content.trim() + "\n", "utf-8");
		else appendBlock(memoryPath(DIR), `${tag(agent, session)}\n${content.trim()}`);
		return { ok: true, file: "MEMORY.md" };
	}
	throw httpErr(400, "unknown target");
}

function handleScratchpad(body) {
	const { action, text, agent } = body;
	const items = loadScratchpad(DIR);
	const save = () => fs.writeFileSync(scratchpadPath(DIR), serializeScratchpad(items), "utf-8");
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
	return { ok: true, items };
}

function handleForget(body) {
	const match = (body.match || "").toLowerCase();
	if (!match) throw httpErr(400, "match required");
	let file = memoryPath(DIR);
	if (body.target === "daily") file = dailyPath(DIR, dateOrToday(body.date));
	const content = readSafe(file);
	if (!content) return { ok: true, removed: 0 };
	const paras = content.split(/\n{2,}/);
	const kept = paras.filter((p) => !p.toLowerCase().includes(match));
	const removedParas = paras.filter((p) => p.toLowerCase().includes(match));
	const removed = removedParas.length;
	if (removed) {
		const recovery = path.join(DIR, "recovery");
		fs.mkdirSync(recovery, { recursive: true });
		const id = `${Date.now()}`;
		fs.writeFileSync(
			path.join(recovery, `${id}.json`),
			JSON.stringify({ file: path.basename(file), removed: removedParas }, null, 2),
		);
		fs.writeFileSync(file, kept.join("\n\n"), "utf-8");
		return { ok: true, removed, recoveryId: id };
	}
	return { ok: true, removed: 0 };
}

function handleRead(q) {
	const target = q.get("target");
	if (target === "list") return { files: listDaily(DIR) };
	if (target === "long_term") return { content: readSafe(memoryPath(DIR)) || "" };
	if (target === "scratchpad") return { content: readSafe(scratchpadPath(DIR)) || "" };
	if (target === "daily") return { content: readSafe(dailyPath(DIR, dateOrToday(q.get("date")))) || "" };
	throw httpErr(400, "unknown target");
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
		if (route === "GET /v1/health") return send(200, { ok: true, role: "brain", date: todayStr() });
		if (route === "GET /v1/context") return send(200, { context: buildContext(DIR) });
		// Full mirror for agent caches: every memory file in one response.
		if (route === "GET /v1/snapshot") {
			return send(200, { takenAt: stamp(), files: snapshotFiles(DIR) });
		}
		if (route === "GET /v1/read") return send(200, handleRead(url.searchParams));
		if (route === "GET /v1/search") {
			const limit = Math.min(Number(url.searchParams.get("limit")) || 5, 20);
			return send(200, { results: searchIn(DIR, url.searchParams.get("q") || "", limit) });
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
