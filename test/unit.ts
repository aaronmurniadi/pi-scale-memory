/**
 * Unit + localhost integration tests: `npm test`.
 * No tailnet is involved — the brain server is exercised over loopback.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
	cacheDir,
	contextWithFallback,
	hasCache,
	metaOf,
	readFromCache,
	readWithFallback,
	searchWithFallback,
	syncCache,
} from "../src/cache.js";
import { BrainClient, localTransport } from "../src/client.js";
import {
	checksumFor,
	compareVersions,
	parsePreauthKey,
	parseUsers,
	parseVersion,
	renderConfig,
	renderPolicy,
	userPaths,
} from "../src/headscale.js";
import { guessServerUrl, joinCommand, readPolicyMode } from "../src/setup.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
let failures = 0;

function check(name: string, fn: () => void) {
	try {
		fn();
		console.log(`  ok   ${name}`);
	} catch (err) {
		failures++;
		console.error(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function checkAsync(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (err) {
		failures++;
		console.error(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** huJSON allows comments; strip them so the structure can be validated as JSON. */
function stripComments(text: string): string {
	return text
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

console.log("headscale helpers");
check("parseVersion reads v-prefixed output", () => {
	assert.equal(parseVersion("headscale version v0.29.5"), "0.29.5");
	assert.equal(parseVersion("headscale version 0.22.3"), "0.22.3");
	assert.equal(parseVersion("no version here"), null);
});
check("compareVersions orders releases", () => {
	assert.equal(compareVersions("0.26.0", "0.26"), 0);
	assert.equal(compareVersions("0.25.1", "0.26"), -1);
	assert.equal(compareVersions("0.29.5", "0.26"), 1);
});
check("checksumFor matches by basename", () => {
	const sums = "abc123  headscale_0.29.5_linux_amd64\nDEF456  ./headscale_0.29.5_linux_amd64.deb\n";
	assert.equal(checksumFor(sums, "headscale_0.29.5_linux_amd64"), "abc123");
	assert.equal(checksumFor(sums, "headscale_0.29.5_linux_amd64.deb"), "def456");
	assert.equal(checksumFor(sums, "other"), null);
});
check("parseUsers reads json and table output", () => {
	const json = JSON.stringify([{ id: "1", name: "alice" }, { id: 2, name: "bob" }]);
	assert.deepEqual(parseUsers(json), [
		{ id: "1", name: "alice" },
		{ id: "2", name: "bob" },
	]);
	const wrapped = JSON.stringify({ users: [{ id: 3, name: "carol" }] });
	assert.deepEqual(parseUsers(wrapped), [{ id: "3", name: "carol" }]);
	const table = "ID | Name  | Email\n1  | alice | a@example.com\n2  | bob   | b@example.com\n";
	assert.deepEqual(parseUsers(table), [
		{ id: "1", name: "alice" },
		{ id: "2", name: "bob" },
	]);
});
check("parsePreauthKey reads json, hskey and legacy forms", () => {
	assert.equal(parsePreauthKey('{"key":"hskey-auth-abc123"}'), "hskey-auth-abc123");
	assert.equal(parsePreauthKey('[{"key":"hskey-auth-zzz"}]'), "hskey-auth-zzz");
	assert.equal(parsePreauthKey("hskey-auth-fff999"), "hskey-auth-fff999");
	assert.equal(parsePreauthKey(`done ${"a".repeat(48)}`), "a".repeat(48));
	assert.equal(parsePreauthKey("no key"), null);
});

console.log("generated policy");
check("policy keeps tagOwners user-based (no wildcard) and only opens the brain port", () => {
	const policy = stripComments(renderPolicy([{ id: "1", name: "alice" }, { id: "2", name: "bob" }], 8787));
	const parsed = JSON.parse(policy);
	assert.deepEqual(parsed.groups["group:agents"], ["alice@", "bob@"]);
	assert.deepEqual(parsed.tagOwners["tag:agent"], ["group:agents"]);
	assert.deepEqual(parsed.tagOwners["tag:brain"], ["group:agents"]);
	assert.deepEqual(parsed.acls, [{ action: "accept", src: ["tag:agent"], dst: ["tag:brain:8787"] }]);
	assert.ok(!policy.includes('"*"'), "policy must not contain a wildcard owner");
});
check("policy tracks the live user list", () => {
	const a = stripComments(renderPolicy([{ id: "1", name: "alice" }], 8787));
	const b = stripComments(renderPolicy([{ id: "1", name: "alice" }, { id: "2", name: "bob" }], 8787));
	assert.notEqual(a, b);
	assert.ok(JSON.parse(b).groups["group:agents"].includes("bob@"));
});

console.log("generated config");
check("config parses and carries the keys headscale requires", () => {
	const paths = userPaths();
	const text = renderConfig(paths, "http://192.168.1.10:8080", "file");
	const parsed = parseYaml(text);
	assert.equal(parsed.server_url, "http://192.168.1.10:8080");
	assert.equal(parsed.listen_addr, "0.0.0.0:8080");
	assert.equal(parsed.noise.private_key_path, paths.noiseKeyPath);
	assert.equal(parsed.prefixes.v4, "100.64.0.0/10");
	assert.equal(parsed.prefixes.v6, "fd7a:115c:a1e0::/48");
	assert.equal(parsed.policy.mode, "file");
	assert.equal(parsed.policy.path, paths.policyPath);
	assert.equal(parsed.unix_socket, paths.socket);
	assert.equal(parsed.database.sqlite.path, path.join(paths.dataDir, "db.sqlite"));
});
check("config follows the url port", () => {
	const parsed = parseYaml(renderConfig(userPaths(), "https://headscale.example.com:9443", "database"));
	assert.equal(parsed.listen_addr, "0.0.0.0:9443");
	assert.equal(parsed.policy.mode, "database");
});
check("readPolicyMode defaults to file and detects database", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-cfg-"));
	const dbPath = path.join(dir, "db.yaml");
	fs.writeFileSync(dbPath, "server_url: http://x:8080\npolicy:\n  mode: database\n  path: /tmp/a.hujson\n");
	assert.equal(readPolicyMode(dbPath), "database");
	const filePath = path.join(dir, "file.yaml");
	fs.writeFileSync(filePath, "server_url: http://x:8080\npolicy:\n  mode: file\n");
	assert.equal(readPolicyMode(filePath), "file");
	assert.equal(readPolicyMode(path.join(dir, "missing.yaml")), "file");
	const legacy = path.join(dir, "legacy.yaml");
	fs.writeFileSync(legacy, "server_url: http://x:8080\npolicy:\n  mode: db\n");
	assert.equal(readPolicyMode(legacy), "database");
});
check("guessServerUrl produces a valid url", () => {
	const url = new URL(guessServerUrl("8080"));
	assert.match(url.protocol, /^http:$/);
	assert.ok(url.port === "8080");
});
check("joinCommand matches the tailscale CLI", () => {
	assert.equal(
		joinCommand("https://headscale.example.com", "hskey-auth-abc"),
		"tailscale up --login-server https://headscale.example.com --auth-key hskey-auth-abc",
	);
});

// ---------------------------------------------------------------------------
// brain server over loopback (the exact path the brain role uses)
// ---------------------------------------------------------------------------

async function startBrain(dir: string, port: number) {
	const server = path.join(ROOT, "brain", "server.mjs");
	const child = spawn(process.execPath, [server], {
		env: { ...process.env, BRAIN_DIR: dir, BRAIN_PORT: String(port), BRAIN_HOST: "127.0.0.1" },
		stdio: "ignore",
	});
	const deadline = Date.now() + 10000;
	for (;;) {
		try {
			const res = await localTransport()("127.0.0.1", port, { method: "GET", path: "/v1/health", headers: {} });
			if (res.status === 200) return child;
		} catch {
			/* not up yet */
		}
		if (Date.now() > deadline) {
			child.kill("SIGKILL");
			throw new Error("brain server did not start");
		}
		await new Promise((r) => setTimeout(r, 200));
	}
}

console.log("brain client over loopback");
await checkAsync("write/read/search/scratchpad/forget round-trip", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-brain-"));
	const port = await freePort();
	const child = await startBrain(dir, port);
	const client = new BrainClient({
		host: "127.0.0.1",
		port,
		token: "",
		agentId: "test-agent",
		transport: localTransport(),
	});
	try {
		await client.health();
		assert.equal(await client.context(), "");

		const longTerm = await client.writeOrQueue({
			path: "/v1/write",
			body: { target: "long_term", content: "chose #postgres", agent: "test-agent" },
		});
		assert.equal(longTerm.queued, false);
		assert.equal(longTerm.result.file, "MEMORY.md");

		const daily = await client.writeOrQueue({
			path: "/v1/write",
			body: { target: "daily", content: "fixed [[auth]]", agent: "test-agent" },
		});
		assert.match(daily.result.file, /^daily\/\d{4}-\d{2}-\d{2}\.md$/);

		const context = await client.context();
		assert.match(context, /chose #postgres/);
		assert.match(context, /fixed \[\[auth\]\]/);

		const hits = await client.search("#postgres", 5);
		assert.ok(hits.length >= 1, "search should find the long-term note");
		assert.equal(hits[0].file, "MEMORY.md");

		const read = await client.read("long_term");
		assert.match(read.content, /chose #postgres/);
		const list = await client.read("list");
		assert.equal(list.files.length, 1);

		const added = await client.writeNow({ path: "/v1/scratchpad", body: { action: "add", text: "todo one" } });
		assert.equal(added.items.length, 1);
		assert.equal(added.items[0].done, false);
		const done = await client.writeNow({ path: "/v1/scratchpad", body: { action: "done", text: "todo" } });
		assert.equal(done.items[0].done, true);
		const cleared = await client.writeNow({ path: "/v1/scratchpad", body: { action: "clear_done" } });
		assert.equal(cleared.items.length, 0);

		const snap = await client.snapshot();
		assert.ok(snap.takenAt.length > 0);
		assert.match(snap.files["MEMORY.md"], /chose #postgres/);
		assert.equal(Object.keys(snap.files).filter((f) => f.startsWith("daily/")).length, 1);

		const forgot = await client.forget({ match: "postgres" });
		assert.equal(forgot.removed, 1);
		assert.ok(fs.existsSync(path.join(dir, "recovery", `${forgot.recoveryId}.json`)));
		const after = await client.context();
		assert.ok(!after.includes("postgres"), "the forgotten note must be gone");
		assert.match(after, /fixed \[\[auth\]\]/, "the daily entry must survive");
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

await checkAsync("a write to a dead brain is queued, not lost", async () => {
	const client = new BrainClient({
		host: "127.0.0.1",
		port: 1,
		token: "",
		agentId: "test-agent",
		transport: localTransport(),
	});
	const res = await client.writeOrQueue({ path: "/v1/write", body: { target: "daily", content: "queued note" } });
	assert.equal(res.queued, true);
	assert.equal(client.pending, 1);
});

console.log("agent offline cache");
await checkAsync("mirrors the brain, then serves reads while offline", async () => {
	const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-brainsrc-"));
	const port = await freePort();
	const child = await startBrain(brainDir, port);
	const cache = cacheDir(fs.mkdtempSync(path.join(os.tmpdir(), "psm-cache-")));
	const live = new BrainClient({
		host: "127.0.0.1",
		port,
		token: "",
		agentId: "test-agent",
		transport: localTransport(),
	});
	const dead = new BrainClient({
		host: "127.0.0.1",
		port: 1,
		token: "",
		agentId: "test-agent",
		transport: localTransport(),
	});
	try {
		await live.writeNow({ path: "/v1/write", body: { target: "long_term", content: "cache me #alpha", agent: "a" } });
		await live.writeNow({ path: "/v1/write", body: { target: "daily", content: "today note #beta", agent: "a" } });
		await live.writeNow({ path: "/v1/scratchpad", body: { action: "add", text: "cache todo" } });

		assert.equal(hasCache(cache), false);
		const meta = await syncCache(live, cache);
		assert.equal(meta.files, 3, "MEMORY.md, SCRATCHPAD.md and one daily log");
		assert.ok(meta.takenAt.length > 0);
		assert.equal(metaOf(cache)?.files, 3);
		assert.equal(hasCache(cache), true);
		assert.ok(fs.existsSync(path.join(cache, "daily")));

		// offline: reads and search come from the mirror
		const offlineRead = await readWithFallback(dead, cache, "long_term");
		assert.equal(offlineRead.source, "cache");
		assert.match(String((offlineRead.value as { content: string }).content), /cache me #alpha/);

		const offlineSearch = await searchWithFallback(dead, cache, "#alpha", 5);
		assert.equal(offlineSearch.source, "cache");
		assert.equal((offlineSearch.value[0] as { file: string }).file, "MEMORY.md");

		const offlineContext = await contextWithFallback(dead, cache);
		assert.equal(offlineContext.source, "cache");
		assert.match(offlineContext.value, /cache me #alpha/);
		assert.match(offlineContext.value, /cache todo/);

		// a live brain still wins over the mirror
		const onlineRead = await readWithFallback(live, cache, "long_term");
		assert.equal(onlineRead.source, "brain");
		const onlineSearch = await searchWithFallback(live, cache, "#alpha", 5);
		assert.equal(onlineSearch.source, "brain");
		assert.equal((await contextWithFallback(live, cache)).source, "brain");

		// never synced and offline: the fallback must not invent an empty answer
		const empty = cacheDir(fs.mkdtempSync(path.join(os.tmpdir(), "psm-cache-empty-")));
		await assert.rejects(() => readWithFallback(dead, empty, "long_term"));

		// deletions on the brain propagate
		await live.forget({ match: "cache me" });
		await syncCache(live, cache);
		assert.equal(await readFromCache(cache, "long_term").content, "");

		// a cache dir with no meta.json counts as "no cache"
		fs.rmSync(path.join(cache, "meta.json"), { force: true });
		assert.equal(hasCache(cache), false);
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(brainDir, { recursive: true, force: true });
		fs.rmSync(cache, { recursive: true, force: true });
	}
});

await checkAsync("cache sync ignores paths outside the memory layout", async () => {
	const cache = cacheDir(fs.mkdtempSync(path.join(os.tmpdir(), "psm-cache-evil-")));
	const fake = {
		brainName: "fake-brain",
		snapshot: async () => ({
			takenAt: "2026-10-18 09:00:00",
			files: {
				"MEMORY.md": "legit\n",
				"../../escape.md": "nope\n",
				"daily/2026-10-18.md": "ok\n",
				"daily/not-a-date.md": "nope\n",
			},
		}),
	} as unknown as BrainClient;
	try {
		const meta = await syncCache(fake, cache);
		assert.equal(meta.files, 2);
		assert.ok(fs.existsSync(path.join(cache, "MEMORY.md")));
		assert.ok(fs.existsSync(path.join(cache, "daily", "2026-10-18.md")));
		assert.ok(!fs.existsSync(path.join(cache, "not-a-date.md")));
		assert.ok(!fs.existsSync(path.join(path.dirname(cache), "escape.md")));
	} finally {
		fs.rmSync(cache, { recursive: true, force: true });
	}
});

console.log("extension registration");
await checkAsync("the extension registers its commands and tools", async () => {
	const mod = await import("../index.js");
	const commands: string[] = [];
	const tools: string[] = [];
	const events: string[] = [];
	const stub = {
		on(event: string) {
			events.push(event);
			return () => {};
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	};
	mod.default(stub as never);
	assert.deepEqual(
		commands.sort(),
		["brain", "generate-preauth", "join-tailnet", "self-tag", "setup-headscale"],
	);
	assert.deepEqual(
		tools.sort(),
		["memory_forget", "memory_read", "memory_search", "memory_write", "scratchpad"],
	);
	assert.ok(events.includes("session_start"), "session_start must be handled");
	assert.ok(events.includes("before_agent_start"), "the memory snapshot must be injected");
});

console.log("");
if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
console.log("all tests passed");
