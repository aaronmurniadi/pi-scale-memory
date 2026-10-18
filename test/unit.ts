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
import { agentUpArgs, parsePeers, run, tailscaleInstalled } from "../src/tailnet.js";
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
import { ensureBrainNode, nodeStatus, stopBrainNode } from "../src/tailnet-node.js";
import {
	brainNodeHostname,
	parseNodeStatus,
	serveArgs,
	tagRejected,
	tagRejectedHelp,
	upArgs,
} from "../src/tailnet-node.js";
import { findBrain, isBrainResponse, rankCandidates } from "../src/discovery.js";
import { describeReset, planReset, staleTempDirs } from "../src/reset.js";
import {
	installCommand,
	isOnPath,
	noCandidateHelp,
	pickCandidate,
	resolveBinDir,
} from "../src/qmd-install.js";
import { configDir } from "../src/config.js";
import type { BrainPeer } from "../src/tailnet.js";
import { findPackageSource, inspectInstall } from "../src/update.js";

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

console.log("the brain's own tailnet node");
check("the node hostname is stable and does not collide with the host", () => {
	assert.equal(brainNodeHostname("NV00016680"), "pi-brain-nv00016680");
	assert.equal(brainNodeHostname("aaron-mac.local"), "pi-brain-aaron-mac");
	assert.equal(brainNodeHostname("Weird Name!"), "pi-brain-weird-name");
	assert.equal(brainNodeHostname(""), "pi-brain");
	assert.equal(brainNodeHostname("   "), "pi-brain");
	assert.equal(brainNodeHostname("NV00016680"), brainNodeHostname("NV00016680"), "restarts must reuse the name");
});
check("parseNodeStatus reads the fields the brain needs", () => {
	const status = parseNodeStatus(
		JSON.stringify({
			BackendState: "Running",
			Self: {
				HostName: "pi-brain-mac",
				DNSName: "pi-brain-mac.tail1a2b.ts.net.",
				Tags: ["tag:brain"],
				TailscaleIPs: ["fd7a:115c:a1e0::1", "100.101.102.103"],
			},
		}),
	);
	assert.ok(status);
	assert.equal(status.backendState, "Running");
	assert.equal(status.hostname, "pi-brain-mac");
	assert.equal(status.dnsName, "pi-brain-mac.tail1a2b.ts.net");
	assert.deepEqual(status.tags, ["tag:brain"]);
	assert.equal(status.ip, "100.101.102.103", "the IPv4 address is the one agents use");
	assert.equal(parseNodeStatus("not json"), null);
	assert.equal(parseNodeStatus("{}")?.backendState, "Unknown");
});
check("peers are read without relying on tags", () => {
	const raw = JSON.stringify({
		Self: { HostName: "me" },
		Peer: {
			a: { HostName: "brain-1", Tags: ["tag:brain"], Online: true, TailscaleIPs: ["100.64.0.5"] },
			b: { HostName: "agent-2", Online: true, TailscaleIPs: ["fd7a::1", "100.64.0.6"] },
			c: { HostName: "offline-box", Online: false, TailscaleIPs: ["100.64.0.7"] },
			d: { HostName: "no-ips" },
		},
	});
	const peers = parsePeers(raw);
	assert.equal(peers.length, 3, "peers without an address are skipped");
	assert.deepEqual(peers[0], { name: "brain-1", ip: "100.64.0.5", online: true });
	assert.equal(peers[1].ip, "100.64.0.6", "the IPv4 address is preferred");
	assert.equal(peers[1].online, true);
	assert.equal(peers[2].online, false);
	assert.deepEqual(parsePeers("not json"), []);
	assert.deepEqual(parsePeers("{}"), []);
});

console.log("finding the brain by asking it");
check("only this extension's brain is accepted", () => {
	assert.equal(isBrainResponse(200, JSON.stringify({ ok: true, service: "pi-scale-memory", role: "brain" })), true);
	assert.equal(isBrainResponse(200, JSON.stringify({ ok: true, role: "brain" })), false, "service must match");
	assert.equal(isBrainResponse(200, JSON.stringify({ ok: true, service: "pi-scale-memory" })), false, "role must match");
	assert.equal(isBrainResponse(200, JSON.stringify({ service: "something-else", role: "brain" })), false);
	assert.equal(isBrainResponse(401, JSON.stringify({ error: "unauthorized" })), false, "a token-protected brain cannot be identified without the token");
	assert.equal(isBrainResponse(200, "not json"), false);
	assert.equal(isBrainResponse(200, ""), false);
});
check("candidates are ranked online first, tags play no part", () => {
	const peers: BrainPeer[] = [
		{ name: "offline-plain", ip: "1", online: false },
		{ name: "online-b", ip: "2", online: true },
		{ name: "offline-tagged", ip: "3", online: false },
		{ name: "online-a", ip: "4", online: true },
	];
	assert.deepEqual(rankCandidates(peers).map((p) => p.name), [
		"online-a",
		"online-b",
		"offline-plain",
		"offline-tagged",
	]);
	assert.deepEqual(rankCandidates([]), []);
	assert.deepEqual(rankCandidates(structuredClone(peers)).map((p) => p.name), rankCandidates(peers).map((p) => p.name));
});
await checkAsync("every peer is asked, and the answering one wins", async () => {
	const peers: BrainPeer[] = [
		{ name: "a", ip: "10.0.0.1", online: true },
		{ name: "b", ip: "10.0.0.2", online: true },
		{ name: "c", ip: "10.0.0.3", online: true },
	];
	const asked: string[] = [];
	const found = await findBrain(peers, async (host) => {
		asked.push(host);
		return host === "10.0.0.2";
	});
	assert.equal(found.host, "10.0.0.2");
	assert.equal(found.probed, 3, "all peers are asked, not just until the first answer");
	assert.deepEqual(asked.sort(), ["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
	assert.equal(found.brains.length, 1);
});
await checkAsync("no responder, and several responders, are both reported", async () => {
	const peers: BrainPeer[] = [
		{ name: "a", ip: "10.0.0.1", online: true },
		{ name: "b", ip: "10.0.0.2", online: true },
	];
	const none = await findBrain(peers, async () => false);
	assert.equal(none.host, null);
	assert.equal(none.probed, 2);
	assert.deepEqual(none.brains, []);

	const both = await findBrain(peers, async () => true);
	assert.equal(both.brains.length, 2, "ambiguity must be visible to the caller");
	assert.equal(both.host, "10.0.0.1");
});
await checkAsync("a pinned host is tried first and falls back to the scan", async () => {
	const peers: BrainPeer[] = [{ name: "a", ip: "10.0.0.1", online: true }];
	const asked: string[] = [];
	const pinned = await findBrain(
		peers,
		async (host) => {
			asked.push(host);
			return true;
		},
		{ host: "10.9.9.9" },
	);
	assert.equal(pinned.host, "10.9.9.9");
	assert.deepEqual(asked, ["10.9.9.9"], "a pinned host must not trigger a full scan");

	asked.length = 0;
	const fallback = await findBrain(
		peers,
		async (host) => {
			asked.push(host);
			return host === "10.0.0.1";
		},
		{ host: "10.9.9.9" },
	);
	assert.equal(fallback.host, "10.0.0.1");
	assert.equal(fallback.pinnedFailed, true, "the caller needs to know the pin was wrong");
	assert.deepEqual(asked, ["10.9.9.9", "10.0.0.1"]);
});
await checkAsync("a peer that throws does not sink the search", async () => {
	const peers: BrainPeer[] = [
		{ name: "broken", ip: "10.0.0.1", online: true },
		{ name: "good", ip: "10.0.0.2", online: true },
	];
	const found = await findBrain(peers, async (host) => {
		if (host === "10.0.0.1") return false;
		return true;
	});
	assert.equal(found.host, "10.0.0.2");
});
check("no join path advertises a tag", () => {
	const brain = upArgs("tskey-auth-x", "pi-brain-mac");
	assert.equal(brain[0], "up");
	assert.ok(brain.includes("--auth-key=tskey-auth-x"));
	assert.ok(brain.includes("--hostname=pi-brain-mac"));
	assert.ok(brain.includes("--accept-dns=false"), "the host's DNS must not be touched");
	assert.ok(brain.includes("--accept-routes=false"));
	assert.ok(!brain.some((a: string) => a.startsWith("--advertise-tags")), "the brain must not ask for a tag");

	const agent = agentUpArgs("pi-agent-mac-abc123", "tskey-auth-y");
	assert.equal(agent[0], "up");
	assert.ok(agent.includes("--auth-key=tskey-auth-y"));
	assert.ok(agent.includes("--hostname=pi-agent-mac-abc123"));
	assert.ok(!agent.some((a: string) => a.startsWith("--advertise-tags")), "the agent must not ask for a tag");

	const withServer = agentUpArgs("pi-agent-mac", "tskey-auth-y", "https://headscale.example.com");
	assert.ok(withServer.includes("--login-server=https://headscale.example.com"));
	assert.ok(!agentUpArgs("pi-agent-mac", "k").some((a: string) => a.startsWith("--login-server")), "no login server by default");
});
check("a rejected tag is recognised and explained", () => {
	// The exact message a key carrying a tag the tailnet will not accept produces.
	assert.equal(tagRejected("backend error: requested tag [tag:brain] are invalid or not permitted"), true);
	assert.equal(tagRejected("requested tags [tag:a tag:b] are invalid or not permitted"), true);
	assert.equal(tagRejected("Failed to connect to local tailscaled"), false);

	const help = tagRejectedHelp(["tag:agent"]);
	assert.match(help, /does not use tags/, "it should say this extension needs no tags");
	assert.match(help, /key with no tags/, "the simplest fix is a key carrying no tag");
	assert.match(help, /applied: tag:agent/, "it should name the tags the key carried");
	assert.match(help, /tagOwners/, "the alternative is permitting the tag");
	assert.match(help, /admin console/, "it should say where to do it");
	assert.ok(!tagRejectedHelp().includes("applied:"), "nothing observed, nothing claimed");
});
check("serve publishes the memory port to the tailnet over loopback", () => {
	assert.deepEqual(serveArgs(8787), ["serve", "--bg", "--tcp=8787", "tcp://127.0.0.1:8787"]);
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

if (await tailscaleInstalled()) {
	await checkAsync("the brain node is userspace-only and leaves the host daemon alone", async () => {
		const hostBefore = await run("tailscale", ["status", "--json"], { timeoutMs: 20000 });
		let before: any = null;
		if (hostBefore.ok || hostBefore.stdout.trim()) {
			try {
				before = JSON.parse(hostBefore.stdout);
			} catch {
				before = null;
			}
		}

		try {
			const node = await ensureBrainNode({ port: 8787 });
			assert.equal(node.ok, false, "without a pre-auth key this node cannot join");
			assert.match(node.detail, /not joined|pre-auth key/);

			// Our own socket answers, and it is a different node from the host's.
			const status = await nodeStatus();
			assert.ok(status, "the private socket must answer status");
			assert.equal(status.backendState, "NeedsLogin");

			if (before) {
				const hostAfter = await run("tailscale", ["status", "--json"], { timeoutMs: 20000 });
				let after: any = null;
				try {
					after = JSON.parse(hostAfter.stdout);
				} catch {
					after = null;
				}
				assert.ok(after, "the host daemon must still answer");
				assert.equal(after.BackendState, before.BackendState, "the host daemon's state must not change");
				assert.equal(after.Self?.NodeID, before.Self?.NodeID, "the host must still be the same node");
				assert.equal(
					Object.keys(after.Peer ?? {}).length,
					Object.keys(before.Peer ?? {}).length,
					"the host's peers must not change",
				);
			}
		} finally {
			await stopBrainNode();
		}
	});
} else {
	console.log("  skip brain node test: tailscale is not installed");
}

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

console.log("installing qmd");
check("the binary directory is derived per platform", () => {
	assert.equal(resolveBinDir("/home/u/.local", "darwin"), "/home/u/.local/bin");
	assert.equal(resolveBinDir("/home/u/.local", "linux"), "/home/u/.local/bin");
	assert.equal(resolveBinDir("C:\\Users\\u\\node", "win32"), "C:\\Users\\u\\node");
});
check("only a prefix whose bin dir is on PATH is chosen", () => {
	const entries = ["/usr/bin", "/home/u/.local/bin"];
	assert.equal(isOnPath("/home/u/.local/bin", entries), true);
	assert.equal(isOnPath("/home/u/.local", entries), false);

	const offPath = { prefix: "/nvm/v22", binDir: "/nvm/v22/bin", onPath: false, writable: true };
	const readOnly = { prefix: "/usr/local", binDir: "/usr/local/bin", onPath: true, writable: false };
	const usable = { prefix: "/home/u/.local", binDir: "/home/u/.local/bin", onPath: true, writable: true };
	// An install into the npm default prefix that is not on PATH would appear to
	// succeed and still not resolve, which is the trap this avoids.
	assert.equal(pickCandidate([offPath, usable]), usable);
	assert.equal(pickCandidate([offPath, readOnly]), null, "nothing usable means no automatic install");
	assert.equal(pickCandidate([]), null);
});
check("the install command is explicit about its prefix", () => {
	assert.deepEqual(installCommand("/home/u/.local"), [
		"install",
		"-g",
		"--prefix=/home/u/.local",
		"@tobilu/qmd",
	]);
});
check("when nothing is usable the user is told what to do", () => {
	const help = noCandidateHelp([
		{ prefix: "/nvm/v22", binDir: "/nvm/v22/bin", onPath: false, writable: true },
		{ prefix: "/usr/local", binDir: "/usr/local/bin", onPath: true, writable: false },
	]);
	assert.match(help, /not on PATH/);
	assert.match(help, /not writable/);
	assert.match(help, /npm install -g --prefix=/);
	assert.match(help, /export PATH=/);
});

console.log("full reset");
check("only old leftovers are picked for deletion", () => {
	const now = 1_000_000_000;
	const HOUR = 60 * 60 * 1000;
	const entries = [
		{ path: "/tmp/psm-crashed", mtimeMs: now - 3 * HOUR },
		{ path: "/tmp/psm-live", mtimeMs: now - 5_000 },
		{ path: "/tmp/other-thing", mtimeMs: now - 9 * HOUR },
	];
	assert.deepEqual(staleTempDirs(entries, now), ["/tmp/psm-crashed"]);
	assert.deepEqual(staleTempDirs(entries, now, 0), ["/tmp/psm-crashed", "/tmp/psm-live"]);
	assert.deepEqual(staleTempDirs([], now), []);
});
check("the reset plan names what it will delete", () => {
	const plan = planReset(Date.now(), "/tmp/psm-nonexistent-dir");
	assert.ok(plan.remove.length >= 1, "the config dir is always in the plan");
	assert.equal(plan.remove[0], configDir(), "the plan must target the extension's own config dir");
	assert.ok(
		!plan.remove.some((p) => p === "/tmp/psm-nonexistent-dir"),
		"a nonexistent tmp dir must not be planned",
	);
	const text = describeReset(plan);
	assert.match(text, /Deletes:/);
	assert.ok(text.includes(configDir()), "the confirmation must show the real path");
	assert.match(text, /admin console/, "it should be honest that devices remain in Tailscale");
	assert.match(text, /start over/i);
	assert.match(text, /join-tailnet-brain/, "it should say how to start again");
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
	assert.deepEqual(commands.sort(), [
		"brain",
		"install-qmd",
		"join-tailnet-agent",
		"join-tailnet-brain",
		"reset-pi-scale-settings",
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
