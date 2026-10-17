/**
 * Unit tests plus a few localhost integration tests: `npm test`.
 * No tailnet is involved. The brain server and the brain-server lifecycle are
 * exercised over loopback; anything needing a real tailnet is out of scope here.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	authKeyBody,
	authKeyPath,
	parseCreatedKey,
} from "../src/apikeys.js";
import { ensureBrainServer, stopBrainServer } from "../src/brain-server.js";
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
	clampLimit,
	normalizeHits,
	normalizeMode,
	parseCollections,
	parseQmdJson,
	qmdArgs,
	relativeFile,
	stripAnsi,
} from "../brain/qmd.mjs";
import { missingTagWarning, parseSystemStatus } from "../src/tailnet.js";
import { findPackageSource, inspectInstall } from "../src/update.js";
import { parseDurationSeconds } from "../index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
/** Keep brain-server state (pid file, log) out of the real pi config dir. */
process.env.PI_SCALE_MEMORY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "psm-cfgdir-"));

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

function qmdInstalled(): boolean {
	return spawnSync("qmd", ["--version"], { encoding: "utf-8" }).status === 0;
}

function removeCollection(name: string): void {
	spawnSync("qmd", ["collection", "remove", name], { encoding: "utf-8" });
}

function testCollection(): string {
	return `psm-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
}

async function startBrain(dir: string, port: number, collection: string) {
	const server = path.join(ROOT, "brain", "server.mjs");
	const child = spawn(process.execPath, [server], {
		env: {
			...process.env,
			BRAIN_DIR: dir,
			BRAIN_PORT: String(port),
			BRAIN_HOST: "127.0.0.1",
			QMD_COLLECTION: collection,
			QMD_UPDATE: "off",
		},
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

console.log("tailscale helpers");
check("parseSystemStatus and missingTagWarning agree on the tag", () => {
	assert.equal(parseSystemStatus("not json"), null);
	const tagged = parseSystemStatus(
		JSON.stringify({ BackendState: "Running", Self: { DNSName: "b.tail.ts.net.", Tags: ["tag:brain"] } }),
	);
	assert.equal(missingTagWarning(tagged, "tag:brain"), null);

	const untagged = parseSystemStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "b.tail.ts.net." } }));
	const warning = missingTagWarning(untagged, "tag:brain");
	assert.match(String(warning), /reports tags: none/);
	assert.match(String(warning), /pre-auth key must be tagged tag:brain/);

	const other = parseSystemStatus(JSON.stringify({ BackendState: "Running", Self: { Tags: ["tag:agent"] } }));
	assert.match(String(missingTagWarning(other, "tag:brain")), /reports tags: tag:agent/);
	assert.match(String(missingTagWarning(null, "tag:brain")), /Could not read tailscale status/);
});

console.log("tailscale api keys");
check("authKeyBody matches the documented request shape", () => {
	const body = authKeyBody({
		apiToken: "tskey-api-x",
		tags: ["tag:agent"],
		reusable: true,
		ephemeral: true,
		preauthorized: true,
		expirySeconds: 7776000,
	}) as any;
	assert.deepEqual(body.capabilities.devices.create, {
		reusable: true,
		ephemeral: true,
		preauthorized: true,
		tags: ["tag:agent"],
	});
	assert.equal(body.expirySeconds, 7776000);
});
check("authKeyPath addresses the token's own tailnet by default", () => {
	assert.equal(authKeyPath("-"), "/api/v2/tailnet/-/keys");
	assert.equal(authKeyPath("example.com"), "/api/v2/tailnet/example.com/keys");
	assert.equal(authKeyPath("a b"), "/api/v2/tailnet/a%20b/keys");
});
check("parseCreatedKey reads the created key", () => {
	const parsed = parseCreatedKey(
		JSON.stringify({
			id: "k1",
			key: "tskey-auth-abc",
			expires: "2026-01-01T00:00:00Z",
			capabilities: { devices: { create: { reusable: true, ephemeral: false, tags: ["tag:agent"] } } },
		}),
	);
	assert.equal(parsed.key, "tskey-auth-abc");
	assert.equal(parsed.reusable, true);
	assert.equal(parsed.ephemeral, false);
	assert.deepEqual(parsed.tags, ["tag:agent"]);
});

console.log("durations");
check("parseDurationSeconds understands the units used by the API", () => {
	assert.equal(parseDurationSeconds("90d"), 7776000);
	assert.equal(parseDurationSeconds("24h"), 86400);
	assert.equal(parseDurationSeconds("30m"), 1800);
	assert.equal(parseDurationSeconds("45s"), 45);
	assert.equal(parseDurationSeconds("2w"), 1209600);
	assert.equal(parseDurationSeconds("300"), 300);
	assert.equal(parseDurationSeconds("soon"), null);
	assert.equal(parseDurationSeconds("0d"), null);
	assert.equal(parseDurationSeconds("-5h"), null);
});

console.log("self-update");
check("this checkout is detected as git with a version", async () => {
	const info = await inspectInstall(ROOT);
	assert.equal(info.kind, "git");
	assert.ok(info.commit && info.commit.length >= 7);
	assert.ok(info.branch && info.branch.length > 0);
	assert.equal(typeof info.version, "string");
});
check("inspectInstall falls back to pi packages for a non-git dir", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-nogit-"));
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-scale-memory", version: "9.9.9" }));
	const info = await inspectInstall(dir);
	assert.equal(info.version, "9.9.9");
	assert.equal(typeof info.kind, "string");
	fs.rmSync(dir, { recursive: true, force: true });
});
check("findPackageSource matches strings and objects", () => {
	assert.equal(findPackageSource({ packages: ["npm:pi-cache-optimizer", "npm:pi-scale-memory"] }), "npm:pi-scale-memory");
	assert.equal(findPackageSource({ packages: [{ source: "git:github.com/aaronmurniadi/pi-scale-memory" }] }), "git:github.com/aaronmurniadi/pi-scale-memory");
	assert.equal(findPackageSource({ packages: ["npm:other"] }), null);
	assert.equal(findPackageSource({}), null);
});

console.log("qmd plumbing");
check("parseQmdJson survives progress noise and empty output", () => {
	assert.deepEqual(parseQmdJson(""), []);
	assert.deepEqual(parseQmdJson("No results found."), []);
	const noisy = "\u001b[?25lEmbedding 2 queries...\n\u001b[?25h\n[\n  {\"file\": \"qmd://c/MEMORY.md\"}\n]\n";
	assert.deepEqual(parseQmdJson(noisy), [{ file: "qmd://c/MEMORY.md" }]);
	assert.throws(() => parseQmdJson("total nonsense"));
});
check("normalizeHits flattens qmd's field names", () => {
	const hits = normalizeHits(
		[
			{ file: "qmd://pi-scale-memory/MEMORY.md", score: 0.6412, snippet: "  hello  ", line: 3 },
			{ path: "qmd://pi-scale-memory/daily/2026-10-18.md", content: "note" },
			{ file: "qmd://other/x.md", chunk: "best" },
		],
		"pi-scale-memory",
	);
	assert.equal(hits[0].file, "MEMORY.md");
	assert.equal(hits[0].score, 0.641);
	assert.equal(hits[0].text, "hello");
	assert.equal(hits[0].line, 3);
	assert.equal(hits[1].file, "daily/2026-10-18.md");
	assert.equal(hits[1].score, 0);
	assert.equal(hits[2].file, "qmd://other/x.md", "a foreign collection stays untouched");
});
check("relativeFile strips only the matching collection", () => {
	assert.equal(relativeFile("qmd://c/a/b.md", "c"), "a/b.md");
	assert.equal(relativeFile("qmd://d/a.md", "c"), "qmd://d/a.md");
	assert.equal(relativeFile("", "c"), "");
});
check("qmdArgs builds the right subcommand per mode", () => {
	assert.deepEqual(qmdArgs("keyword", "col", "postgres", 3), ["search", "--json", "-c", "col", "-n", "3", "postgres"]);
	assert.deepEqual(qmdArgs("semantic", "col", "q", 5), ["vsearch", "--json", "-c", "col", "-n", "5", "q"]);
	assert.deepEqual(qmdArgs("deep", "col", "q", 5), ["query", "--json", "-c", "col", "-n", "5", "q"]);
	assert.equal(qmdArgs("bogus", "col", "q", 5)[0], "vsearch", "an unknown mode must not become a broken invocation");
});
check("clampLimit and normalizeMode reject nonsense", () => {
	assert.equal(clampLimit(undefined), 5);
	assert.equal(clampLimit(Number.NaN), 5);
	assert.equal(clampLimit(0), 1);
	assert.equal(clampLimit(1000), 20);
	assert.equal(clampLimit(7), 7);
	assert.equal(normalizeMode("deep"), "deep");
	assert.equal(normalizeMode("garbage"), "semantic");
	assert.equal(normalizeMode(undefined), "semantic");
});
check("parseCollections reads the collection list", () => {
	const out = stripAnsi("Collections (2):\n\npi-memory (qmd://pi-memory/)\n  Pattern:  **/*.md\npsmtest (qmd://psmtest/)\n");
	assert.deepEqual(parseCollections(out), ["pi-memory", "psmtest"]);
	assert.deepEqual(parseCollections(""), []);
});

console.log("brain server over loopback");
await checkAsync("write/read/search/scratchpad/forget round-trip", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-brain-"));
	const port = await freePort();
	const collection = testCollection();
	const child = await startBrain(dir, port, collection);
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
		assert.ok(hits.results.length >= 1, "search should find the long-term note");
		assert.equal(hits.results[0].file, "MEMORY.md");

		const read = await client.read("long_term");
		assert.match(read.content, /chose #postgres/);
		const list = await client.read("list");
		assert.equal(list.files.length, 1);

		const snap = await client.snapshot();
		assert.ok(snap.takenAt.length > 0);
		assert.match(snap.files["MEMORY.md"], /chose #postgres/);

		const added = await client.writeNow({ path: "/v1/scratchpad", body: { action: "add", text: "todo one" } });
		assert.equal(added.items.length, 1);
		assert.equal(added.items[0].done, false);
		const done = await client.writeNow({ path: "/v1/scratchpad", body: { action: "done", text: "todo" } });
		assert.equal(done.items[0].done, true);
		const cleared = await client.writeNow({ path: "/v1/scratchpad", body: { action: "clear_done" } });
		assert.equal(cleared.items.length, 0);

		const forgot = await client.forget({ match: "postgres" });
		assert.equal(forgot.removed, 1);
		assert.ok(fs.existsSync(path.join(dir, "recovery", `${forgot.recoveryId}.json`)));
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(dir, { recursive: true, force: true });
		removeCollection(collection);
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

await checkAsync("the brain server lifecycle starts, reports and stops", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-lifecycle-"));
	const port = await freePort();
	const collection = testCollection();
	const messages: string[] = [];
	try {
		const started = await ensureBrainServer(
			ROOT,
			{ port, token: "secret-token", env: { BRAIN_DIR: dir, BRAIN_HOST: "127.0.0.1", QMD_COLLECTION: collection, QMD_UPDATE: "off" } },
			(m) => messages.push(m),
		);
		assert.equal(started.ok, true, `ensureBrainServer: ${started.detail}`);
		assert.equal(started.started, true);
		assert.ok(messages.length >= 1);

		// A server started this way enforces the token it was given.
		const anonymous = await localTransport()("127.0.0.1", port, { method: "GET", path: "/v1/health", headers: {} });
		assert.equal(anonymous.status, 401, "a public brain must reject anonymous calls");
		const authorized = await localTransport()("127.0.0.1", port, {
			method: "GET",
			path: "/v1/health",
			headers: { authorization: "Bearer secret-token" },
		});
		assert.equal(authorized.status, 200);

		// Calling it again with the same token adopts the running server.
		const again = await ensureBrainServer(
			ROOT,
			{ port, token: "secret-token", env: { BRAIN_DIR: dir } },
			() => {},
		);
		assert.equal(again.ok, true);
		assert.equal(again.started, false);

		// A different token on the same port is a conflict worth reporting.
		const conflict = await ensureBrainServer(
			ROOT,
			{ port, token: "other-token", env: { BRAIN_DIR: dir } },
			() => {},
		);
		assert.equal(conflict.ok, false);
		assert.match(conflict.detail, /different token/);
	} finally {
		await stopBrainServer();
		removeCollection(collection);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

console.log("agent offline cache");
await checkAsync("mirrors the brain, then serves reads while offline", async () => {
	const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-brainsrc-"));
	const port = await freePort();
	const collection = testCollection();
	const child = await startBrain(brainDir, port, collection);
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
		assert.equal(metaOf(cache)?.files, 3);

		const offlineRead = await readWithFallback(dead, cache, "long_term");
		assert.equal(offlineRead.source, "cache");
		assert.match(String((offlineRead.value as { content: string }).content), /cache me #alpha/);

		const offlineSearch = await searchWithFallback(dead, cache, "#alpha", 5);
		assert.equal(offlineSearch.source, "cache");
		assert.equal(offlineSearch.engine, "bm25");
		assert.equal(offlineSearch.results[0].file, "MEMORY.md");

		const offlineContext = await contextWithFallback(dead, cache);
		assert.equal(offlineContext.source, "cache");
		assert.match(offlineContext.value, /cache todo/);

		const onlineRead = await readWithFallback(live, cache, "long_term");
		assert.equal(onlineRead.source, "brain");
		const onlineSearch = await searchWithFallback(live, cache, "#alpha", 5);
		assert.equal(onlineSearch.source, "brain");
		assert.ok(onlineSearch.results.length >= 1);
		assert.equal((await contextWithFallback(live, cache)).source, "brain");

		const empty = cacheDir(fs.mkdtempSync(path.join(os.tmpdir(), "psm-cache-empty-")));
		await assert.rejects(() => readWithFallback(dead, empty, "long_term"));

		await live.forget({ match: "cache me" });
		await syncCache(live, cache);
		assert.equal(await readFromCache(cache, "long_term").content, "");
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(brainDir, { recursive: true, force: true });
		fs.rmSync(cache, { recursive: true, force: true });
		removeCollection(collection);
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
		assert.ok(!fs.existsSync(path.join(cache, "not-a-date.md")));
		assert.ok(!fs.existsSync(path.join(path.dirname(cache), "escape.md")));
	} finally {
		fs.rmSync(cache, { recursive: true, force: true });
	}
});

if (qmdInstalled()) {
	await checkAsync("qmd answers semantic and keyword searches through the brain", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-qmd-"));
		const port = await freePort();
		const collection = testCollection();
		fs.writeFileSync(
			path.join(dir, "MEMORY.md"),
			"# Memory\n\nWe chose postgres for the billing database because of JSON support.\n",
		);
		const child = await startBrain(dir, port, collection);
		const client = new BrainClient({ host: "127.0.0.1", port, token: "", agentId: "test-agent", transport: localTransport() });
		try {
			let ready = false;
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const h = await client.health();
				if (h.search?.ready === true && h.search.collection === collection) {
					ready = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 250));
			}
			assert.ok(ready, "the brain should report its qmd collection ready");

			const embedded = spawnSync("qmd", ["embed", "-c", collection, "--timeout", "5"], {
				encoding: "utf-8",
				timeout: 240000,
			});
			if (embedded.status !== 0) {
				const detail = String(embedded.stderr).trim().split("\n").pop() ?? "";
				if (/Collection not found/i.test(detail)) throw new Error(`embed failed: ${detail}`);
				console.log(`  skip qmd search: embeddings unavailable (${detail})`);
				return;
			}

			const semantic = await client.search("which database did we pick for billing", 3, "semantic");
			assert.equal(semantic.engine, "qmd");
			assert.equal(semantic.mode, "semantic");
			assert.ok(semantic.results.length >= 1, "semantic search should find the note");
			assert.equal(semantic.results[0].file, "MEMORY.md");
			assert.match(semantic.results[0].text, /postgres/);

			const keyword = await client.search("postgres", 3, "keyword");
			assert.equal(keyword.engine, "qmd");
			assert.ok(keyword.results.length >= 1);
		} finally {
			child.kill("SIGKILL");
			fs.rmSync(dir, { recursive: true, force: true });
			removeCollection(collection);
		}
	});
} else {
	console.log("  skip qmd search test: qmd is not installed");
}

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
	assert.deepEqual(commands.sort(), [
		"brain",
		"generate-preauth",
		"join-tailnet-agent",
		"join-tailnet-brain",
		"self-tag",
		"update-pi-scale-memory",
	]);
	assert.deepEqual(tools.sort(), [
		"memory_forget",
		"memory_read",
		"memory_search",
		"memory_write",
		"scratchpad",
	]);
	assert.ok(events.includes("session_start"));
	assert.ok(events.includes("before_agent_start"));
});

fs.rmSync(process.env.PI_SCALE_MEMORY_CONFIG_DIR as string, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
console.log("all tests passed");
