/**
 * Unit tests plus a few localhost integration tests: `npm test`.
 * No tailnet is involved. The brain server and the brain-server lifecycle are
 * exercised over loopback; anything needing a real tailnet is out of scope here.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
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
import { budgetMs, withBudget } from "../src/budget.js";
import { BrainClient, type BrainTransport, localTransport, MAX_RETRY_ATTEMPTS, retryDelayMs } from "../src/client.js";
import {
	agentUpArgs,
	parseElapsed,
	parsePeers,
	parseTailscaledProcesses,
	reapOrphanedTailscaled,
	run,
	tailscaleInstalled,
} from "../src/tailnet.js";
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
	agentNodeHostname,
	agentNodePaths,
	brainNodeHostname,
	keyRejected,
	keyRejectedHelp,
	parseNodeStatus,
	serveArgs,
	tagRejected,
	tagRejectedHelp,
	unserveArgs,
	upArgs,
} from "../src/tailnet-node.js";
import { socksConnect, socksHttp } from "../src/socks.js";
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
import {
	buildContext,
	DEFAULT_NS,
	isValidNs,
	migrateFlat,
	similarity,
	todayStr,
	tokenize,
	TOTAL_CONTEXT_CHARS,
	writeEntry,
	yesterdayStr,
} from "../brain/memory.mjs";
import {
	canonicalRemote,
	detectGit,
	mainWorktreeRoot,
	nsIdFromKey,
	pickRemote,
	resolveForCwd,
	resolveNamespace,
} from "../src/namespace.js";

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

/**
 * A brain keeps one collection per tier, named `<prefix>-<tier>`, so cleanup has to
 * name them. `qmd update` reindexes every collection on the machine, so a leftover
 * from a test is a standing tax on every later run.
 */
function removeCollections(prefix: string, namespaces: string[] = []): void {
	removeCollection(`${prefix}-core`);
	removeCollection(`${prefix}-shared`);
	removeCollection(`${prefix}-legacy`);
	for (const ns of namespaces) removeCollection(`${prefix}-${ns}`);
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
			QMD_COLLECTION_PREFIX: collection,
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

console.log("the agent's own tailnet node");
check("an agent retries a few times, then stops and asks the user", () => {
	assert.equal(MAX_RETRY_ATTEMPTS, 3, "three tries: enough for a new node or a moved brain, few enough to stay honest");
	assert.equal(retryDelayMs(0), 5_000, "the first retry is quick: a just-joined node has no paths yet");
	assert.equal(retryDelayMs(1), 10_000);
	assert.equal(retryDelayMs(2), 20_000);
	assert.equal(retryDelayMs(99), retryDelayMs(MAX_RETRY_ATTEMPTS - 1), "past the cap the ladder stops growing");
	assert.equal(retryDelayMs(-1), 5_000, "a nonsense attempt must not be cheaper than the first");
	let previous = 0;
	for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
		const delay = retryDelayMs(attempt);
		assert.ok(delay >= previous, `backoff must not go backwards at attempt ${attempt}`);
		previous = delay;
	}
	assert.ok(!/retry/i.test(String(retryDelayMs(2))), "the delay is a number, not a message");
	assert.ok(MAX_RETRY_ATTEMPTS <= 3, "a longer loop would hide a problem only the user can fix");
});
check("the agent node is named per machine, with no per-session suffix", () => {
	assert.equal(agentNodeHostname("NV00016680"), "pi-agent-nv00016680");
	assert.equal(agentNodeHostname("aaron-mac.local"), "pi-agent-aaron-mac");
	assert.equal(agentNodeHostname("Weird Name!"), "pi-agent-weird-name");
	assert.equal(agentNodeHostname(""), "pi-agent");
	assert.equal(
		agentNodeHostname("NV00016680"),
		agentNodeHostname("NV00016680"),
		"a stable name is what keeps one device per machine",
	);
	assert.notEqual(agentNodeHostname("mac"), brainNodeHostname("mac"), "the two roles must not claim one name");
});
check("the agent node keeps its identity in the config dir, not in a temp dir", () => {
	const paths = agentNodePaths();
	assert.ok(paths.state.startsWith(configDir()), `state should outlive the session: ${paths.state}`);
	assert.ok(paths.socket.startsWith(configDir()), `socket should be stable: ${paths.socket}`);
	assert.notEqual(paths.state, paths.socket);
	assert.ok(
		paths.state.includes("agent-tailnet"),
		"the agent node must not share the brain node's state",
	);
	assert.ok(
		path.basename(path.dirname(paths.socket)) === "agent-tailnet",
		`the socket lives in a stable per-role dir, not a session temp dir: ${paths.socket}`,
	);
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
await checkAsync("a probe is told how long it may take", async () => {
	const budgets: number[] = [];
	const peers: BrainPeer[] = [{ name: "a", ip: "10.0.0.1", online: true }];
	await findBrain(
		peers,
		async (_host, timeoutMs) => {
			budgets.push(timeoutMs);
			return false;
		},
		{ timeoutMs: 1234 },
	);
	assert.deepEqual(budgets, [1234], "the probe has to receive the deadline, or it never expires");
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
check("a failed brain takes its published port back off the tailnet", () => {
	assert.deepEqual(unserveArgs(8787), ["serve", "--tcp=8787", "off"]);
});
check("a spent pre-auth key is recognised and explained", () => {
	// The exact message the control plane returned for a key that had been used.
	assert.equal(keyRejected("backend error: invalid key: API key kWeigW5A7N11CNTRL not valid"), true);
	assert.equal(keyRejected("auth key already used"), true);
	assert.equal(keyRejected("auth key expired"), true);
	assert.equal(keyRejected("backend error: requested tag [tag:x] are invalid or not permitted"), false);
	assert.equal(keyRejected("Failed to connect to local tailscaled"), false);

	const help = keyRejectedHelp("/psm-join agent", "invalid key: API key abc not valid");
	assert.match(help, /Join once per machine|once per machine/, "it should say one join is enough here");
	assert.match(help, /Settings -> Keys/, "it should say where to make a new key");
	assert.match(help, /psm-join agent/, "it should name the command to re-run");
	assert.match(help, /Tailscale said: .*abc/, "it should keep what Tailscale actually said");
	assert.match(keyRejectedHelp("/psm-join brain"), /psm-join brain/, "the brain has its own command");
	assert.ok(!keyRejectedHelp().includes("Tailscale said:"), "nothing observed, nothing repeated");
});

console.log("socks");
/** A proxy that accepts the connection and then says nothing, like dropped packets. */
function silentProxy(): Promise<{ close: () => void; port: number }> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer(() => {});
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			resolve({ close: () => srv.close(), port: (srv.address() as net.AddressInfo).port });
		});
	});
}
await checkAsync("a silent proxy cannot hang the SOCKS handshake", async () => {
	const proxy = await silentProxy();
	const started = Date.now();
	await assert.rejects(socksConnect(proxy.port, "100.64.0.1", 8787, 300), /SOCKS5 connect timed out/);
	const took = Date.now() - started;
	proxy.close();
	assert.ok(took < 3000, `it should give up on its own deadline, took ${took}ms`);
});
await checkAsync("a dropped probe is bounded by its budget, not by the handshake", async () => {
	const proxy = await silentProxy();
	const started = Date.now();
	await assert.rejects(
		socksHttp({ proxyPort: proxy.port, host: "100.64.0.1", port: 8787, method: "GET", path: "/v1/health", timeoutMs: 300 }),
		/SOCKS5 connect timed out/,
	);
	const took = Date.now() - started;
	proxy.close();
	assert.ok(took < 3000, `the whole probe should be bounded, took ${took}ms`);
});

/**
 * A proxy that finishes the SOCKS handshake and then serves HTTP over the tunnel,
 * remembering whether a request ever arrived through it. This is the shape a real
 * brain probe has: the handshake is only half of it.
 */
function brainProxy(): Promise<{ close: () => void; port: number; sawRequest: () => boolean }> {
	let sawRequest = false;
	const httpServer = http.createServer((_req, res) => {
		sawRequest = true;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, service: "pi-scale-memory", role: "brain" }));
	});
	return new Promise((resolve, reject) => {
		const srv = net.createServer((sock) => {
			let buf = Buffer.alloc(0);
			let stage = "greeting";
			sock.on("error", () => {});
			sock.on("data", function onData(chunk: Buffer) {
				buf = Buffer.concat([buf, chunk]);
				if (stage === "greeting") {
					if (buf.length < 2) return;
					const methods = buf[1];
					if (buf.length < 2 + methods) return;
					buf = buf.subarray(2 + methods);
					stage = "connect";
					sock.write(Buffer.from([0x05, 0x00]));
					return;
				}
				if (buf.length < 5) return;
				let need = 4;
				if (buf[3] === 0x01) need += 4 + 2;
				else if (buf[3] === 0x04) need += 16 + 2;
				else need += 1 + buf[4] + 2;
				if (buf.length < need) return;
				const rest = buf.subarray(need);
				sock.off("data", onData);
				sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
				if (rest.length) sock.unshift(rest);
				httpServer.emit("connection", sock);
			});
		});
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			resolve({
				close: () => {
					srv.close();
					httpServer.close();
				},
				port: (srv.address() as net.AddressInfo).port,
				sawRequest: () => sawRequest,
			});
		});
	});
}
await checkAsync("the request rides the socket the handshake opened", async () => {
	// `agent` has to stay unset in socksHttp. Node honours `createConnection` only
	// when no agent is chosen, so `agent: false` quietly builds a default agent,
	// throws this socket away and dials the peer address over the host's own
	// network. Nothing routes a tailnet address there, so the probe reaches no
	// brain and reads as a timeout. Only serving HTTP on the tunnel catches that.
	const proxy = await brainProxy();
	const res = await socksHttp({
		proxyPort: proxy.port,
		host: "100.64.0.1",
		port: 8787,
		method: "GET",
		path: "/v1/health",
		timeoutMs: 3000,
	});
	assert.ok(proxy.sawRequest(), "the HTTP request has to arrive through the tunnel");
	proxy.close();
	assert.equal(res.status, 200, "the probe should get the brain's answer back");
	assert.match(res.body, /"role":"brain"/);
});

console.log("leftover nodes");
check("ps elapsed time is read in each format ps prints", () => {
	assert.equal(parseElapsed("05:03"), 303);
	assert.equal(parseElapsed("01:05:03"), 3903);
	assert.equal(parseElapsed("2-01:05:03"), 176703);
	assert.equal(parseElapsed("  12:00  "), 720);
	assert.equal(parseElapsed(""), null);
	assert.equal(parseElapsed("nonsense"), null);
});
check("only userspace tailscaled lines are read out of ps output", () => {
	const ps = [
		"  501 05:03 node brain/server.mjs",
		"  612 01:05:03 tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:51003 --state=mem: --socket=/tmp/psm-aaa/ts.sock",
		"  613 2-01:05:03 /opt/homebrew/bin/tailscaled --tun=userspace-networking --state=/x/state --socket=/Users/x/.pi/agent/pi-scale-memory/brain-tailnet/tailscaled.sock",
		"  614 00:10 tailscaled --tun=userspace-networking --state=mem:",
	].join("\n");
	const found = parseTailscaledProcesses(ps);
	assert.deepEqual(
		found.map((p) => p.pid),
		[612, 613],
		"the agent node and the brain node are read; a daemon with no socket and a non-tailscale line are not",
	);
	assert.equal(found[0].socket, "/tmp/psm-aaa/ts.sock");
	assert.equal(found[0].elapsedSeconds, 3903);
});
function waitForExit(child: { exitCode: number | null; signalCode: NodeJS.Signals | null }, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = Date.now() + ms;
		const tick = () => {
			if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
			if (Date.now() > deadline) return resolve(false);
			setTimeout(tick, 50);
		};
		tick();
	});
}
await checkAsync("a node whose socket is gone is ended, a live one is left alone", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-reap-"));
	// Sockets sit directly inside a psm-* dir, as an older version laid them out.
	// New nodes keep a stable socket, but debris from those versions still needs
	// clearing out.
	const orphanSocket = path.join(dir, "orphan-ts.sock");
	const liveSocket = path.join(dir, "live-ts.sock");
	fs.writeFileSync(liveSocket, "");
	// A real command line, so `ps` sees exactly what an abandoned node looks like.
	const fake = (socket: string) =>
		spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)", "tailscaled", "--tun=userspace-networking", `--socket=${socket}`],
			{ stdio: "ignore" },
		);
	const orphan = fake(orphanSocket);
	const live = fake(liveSocket);
	await new Promise((r) => setTimeout(r, 500));

	await reapOrphanedTailscaled(0);

	const orphanGone = await waitForExit(orphan, 3000);
	const liveSurvived = !(await waitForExit(live, 500));
	live.kill("SIGKILL");
	fs.rmSync(dir, { recursive: true, force: true });
	assert.ok(orphanGone, "a node with no socket is unreachable and has to be ended");
	assert.ok(liveSurvived, "a node that still owns its socket belongs to a live session");
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
await checkAsync("tiered write/read/search/scratchpad/forget round-trip", async () => {
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
	const ns = "project-a";
	try {
		const health = await client.health();
		assert.deepEqual(health.scopes, ["core", "shared", "project"]);
		assert.equal(health.defaultNs, DEFAULT_NS);
		assert.equal(await client.context(ns), "", "an empty brain injects nothing");

		const longTerm = await client.writeOrQueue({
			path: "/v1/write",
			body: { target: "long_term", ns, content: "chose #postgres", agent: "test-agent" },
		});
		assert.equal(longTerm.queued, false);
		assert.equal(longTerm.result.file, "project-a/MEMORY.md");

		const daily = await client.writeOrQueue({
			path: "/v1/write",
			body: { target: "daily", ns, content: "fixed [[auth]]", agent: "test-agent" },
		});
		assert.match(daily.result.file, /^project-a\/daily\/\d{4}-\d{2}-\d{2}\.md$/);

		const shared = await client.writeOrQueue({
			path: "/v1/write",
			body: { target: "long_term", ns: "shared", content: "always run the tests", agent: "test-agent" },
		});
		assert.equal(shared.result.file, "shared/MEMORY.md");

		const context = await client.context(ns);
		assert.match(context, /chose #postgres/);
		assert.match(context, /fixed \[\[auth\]\]/);
		assert.match(context, /always run the tests/, "shared memory is injected with the project's own");

		const hits = await client.search("#postgres", 5, undefined, { ns, scope: "all" });
		assert.ok(hits.results.length >= 1, "search should find the long-term note");
		assert.equal(hits.results[0].file, "MEMORY.md");
		assert.equal(hits.results[0].tier, "project");

		const sharedHit = await client.search("run the tests", 5, undefined, { ns, scope: "shared" });
		assert.equal(sharedHit.results[0]?.tier, "shared");
		assert.equal(
			(await client.search("#postgres", 5, undefined, { ns, scope: "shared" })).results.length,
			0,
			"a project note must not surface from the shared tier",
		);

		const read = await client.read("long_term", { ns });
		assert.match(read.content, /chose #postgres/);
		const list = await client.read("list", { ns });
		assert.equal(list.files.length, 1);

		const snap = await client.snapshot(ns);
		assert.ok(snap.takenAt.length > 0);
		assert.equal(snap.project?.id, ns);
		assert.match(snap.project?.files["MEMORY.md"] ?? "", /chose #postgres/);
		assert.match(snap.shared.files["MEMORY.md"] ?? "", /always run the tests/);

		// Isolation: another project sees none of this project's memory.
		assert.equal((await client.read("long_term", { ns: "project-b" })).content, "");
		assert.ok(!(await client.context("project-b")).includes("chose #postgres"));
		assert.ok(fs.existsSync(path.join(dir, "ns", ns, "MEMORY.md")), "a project tier is one directory per namespace");

		const added = await client.writeNow({ path: "/v1/scratchpad", body: { action: "add", ns, text: "todo one" } });
		assert.equal(added.items.length, 1);
		assert.equal(added.items[0].done, false);
		const done = await client.writeNow({ path: "/v1/scratchpad", body: { action: "done", ns, text: "todo" } });
		assert.equal(done.items[0].done, true);
		const cleared = await client.writeNow({ path: "/v1/scratchpad", body: { action: "clear_done", ns } });
		assert.equal(cleared.items.length, 0);

		const forgot = await client.forget({ match: "postgres", ns });
		assert.equal(forgot.removed, 1);
		assert.ok(fs.existsSync(path.join(dir, "ns", ns, "recovery", `${forgot.recoveryId}.json`)));
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(dir, { recursive: true, force: true });
		removeCollections(collection, [ns, "project-b"]);
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
			{ port, token: "secret-token", env: { BRAIN_DIR: dir, BRAIN_HOST: "127.0.0.1", QMD_COLLECTION_PREFIX: collection, QMD_UPDATE: "off" } },
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
		removeCollections(collection);
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
		const ns = "project-cache";
		await live.writeNow({ path: "/v1/write", body: { target: "long_term", ns, content: "cache me #alpha", agent: "a" } });
		await live.writeNow({ path: "/v1/write", body: { target: "daily", ns, content: "today note #beta", agent: "a" } });
		await live.writeNow({ path: "/v1/scratchpad", body: { action: "add", ns, text: "cache todo" } });
		await live.writeCore({ action: "append", content: "core rule #gamma" });
		await live.writeNow({
			path: "/v1/write",
			body: { target: "long_term", ns: "shared", content: "shared rule #delta", agent: "a" },
		});

		assert.equal(hasCache(cache), false);
		const meta = await syncCache(live, cache, ns);
		assert.equal(meta.files, 5, "project MEMORY.md, SCRATCHPAD.md and one daily log, plus core and shared");
		assert.equal(metaOf(cache)?.files, 5);
		assert.equal(meta.ns, ns);

		// The two cross-project tiers are mirrored whatever project the session is in.
		const tierRead = (tier: string) => fs.readFileSync(path.join(cache, tier, "MEMORY.md"), "utf-8");
		assert.match(tierRead("core"), /core rule #gamma/);
		assert.match(tierRead("shared"), /shared rule #delta/);

		const offlineRead = await readWithFallback(dead, cache, "long_term", { ns });
		assert.equal(offlineRead.source, "cache");
		assert.match(String((offlineRead.value as { content: string }).content), /cache me #alpha/);

		const offlineSearch = await searchWithFallback(dead, cache, "#alpha", 5, { ns });
		assert.equal(offlineSearch.source, "cache");
		assert.equal(offlineSearch.engine, "bm25");
		assert.equal(offlineSearch.results[0].file, "MEMORY.md");

		const offlineContext = await contextWithFallback(dead, cache, ns);
		assert.equal(offlineContext.source, "cache");
		assert.match(offlineContext.value, /cache todo/);

		const onlineRead = await readWithFallback(live, cache, "long_term", { ns });
		assert.equal(onlineRead.source, "brain");
		const onlineSearch = await searchWithFallback(live, cache, "#alpha", 5, { ns });
		assert.equal(onlineSearch.source, "brain");
		assert.ok(onlineSearch.results.length >= 1);
		assert.equal((await contextWithFallback(live, cache, ns)).source, "brain");

		// A project the session is not in is never mirrored, so nothing of it is readable.
		const other = await readWithFallback(dead, cache, "long_term", { ns: "project-other" });
		assert.equal(String((other.value as { content: string }).content), "");

		// A second session on this machine, in another repository, must not evict the
		// first one's mirror: every session on a machine shares this cache directory.
		await live.writeNow({
			path: "/v1/write",
			body: { target: "long_term", ns: "project-second", content: "second project note #omega", agent: "a" },
		});
		const secondMeta = await syncCache(live, cache, "project-second");
		assert.equal(secondMeta.ns, "project-second");
		const survived = await readWithFallback(dead, cache, "long_term", { ns });
		assert.match(
			String((survived.value as { content: string }).content),
			/cache me #alpha/,
			"another session's sync must not evict this project",
		);
		assert.ok(secondMeta.nsTakenAt[ns], "each tier keeps its own timestamp");
		assert.ok(secondMeta.nsTakenAt["project-second"]);
		assert.equal(metaOf(cache)?.nsTakenAt[ns], secondMeta.nsTakenAt[ns], "the older tier's time is not rewritten");

		const empty = cacheDir(fs.mkdtempSync(path.join(os.tmpdir(), "psm-cache-empty-")));
		await assert.rejects(() => readWithFallback(dead, empty, "long_term", { ns }));

		await live.forget({ match: "cache me", ns });
		await syncCache(live, cache, ns);
		assert.equal((await readFromCache(cache, "long_term", ns)).content, "");
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(brainDir, { recursive: true, force: true });
		fs.rmSync(cache, { recursive: true, force: true });
		removeCollections(collection, ["project-cache", "project-second"]);
	}
});

await checkAsync("cache sync ignores paths outside the memory layout", async () => {
	const cache = cacheDir(fs.mkdtempSync(path.join(os.tmpdir(), "psm-cache-evil-")));
	const fake = {
		brainName: "fake-brain",
		snapshot: async () => ({
			takenAt: "2026-10-18 09:00:00",
			ns: "project-evil",
			core: { files: { "MEMORY.md": "core\n" } },
			shared: { files: { "MEMORY.md": "legit\n", "../../../escape.md": "nope\n" } },
			project: {
				id: "project-evil",
				files: { "MEMORY.md": "project\n", "daily/2026-10-18.md": "ok\n", "daily/not-a-date.md": "nope\n" },
			},
		}),
	} as unknown as BrainClient;
	try {
		const meta = await syncCache(fake, cache, "project-evil");
		assert.equal(meta.files, 4, "core, shared, project MEMORY.md and the one valid daily log");
		assert.ok(!fs.existsSync(path.join(cache, "ns", "project-evil", "daily", "not-a-date.md")));
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
		const ns = "project-qmd";
		fs.mkdirSync(path.join(dir, "ns", ns), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "ns", ns, "MEMORY.md"),
			"# Memory\n\nWe chose postgres for the billing database because of JSON support.\n",
		);
		const child = await startBrain(dir, port, collection);
		const client = new BrainClient({ host: "127.0.0.1", port, token: "", agentId: "test-agent", transport: localTransport() });
		try {
			let ready = false;
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const h = await client.health();
				if (h.search?.ready === true && h.search.collections?.includes(`${collection}-${ns}`)) {
					ready = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 250));
			}
			assert.ok(ready, "the brain should report its per-tier qmd collections ready");

			const embedded = spawnSync("qmd", ["embed", "-c", `${collection}-${ns}`, "--timeout", "5"], {
				encoding: "utf-8",
				timeout: 240000,
			});
			if (embedded.status !== 0) {
				const detail = String(embedded.stderr).trim().split("\n").pop() ?? "";
				if (/Collection not found/i.test(detail)) throw new Error(`embed failed: ${detail}`);
				console.log(`  skip qmd search: embeddings unavailable (${detail})`);
				return;
			}

			const semantic = await client.search("which database did we pick for billing", 3, "semantic", { ns, scope: "all" });
			assert.equal(semantic.engine, "qmd");
			assert.equal(semantic.mode, "semantic");
			assert.ok(semantic.results.length >= 1, "semantic search should find the note");
			assert.equal(semantic.results[0].file, "MEMORY.md");
			assert.equal(semantic.results[0].tier, "project");
			assert.match(semantic.results[0].text, /postgres/);

			const keyword = await client.search("postgres", 3, "keyword", { ns, scope: "all" });
			assert.equal(keyword.engine, "qmd");
			assert.ok(keyword.results.length >= 1);

			// Scoping is exact: another project's collection is not queried at all.
			const elsewhere = await client.search("postgres", 3, "keyword", { ns: "project-other", scope: "project" });
			assert.equal(elsewhere.results.length, 0, "a search must never cross into another project");
		} finally {
			child.kill("SIGKILL");
			fs.rmSync(dir, { recursive: true, force: true });
			removeCollections(collection, [ns, "project-other"]);
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
	assert.match(text, /psm-join brain/, "it should say how to start again");
});

console.log("project namespaces from git");
check("a remote URL becomes one canonical key whatever form it arrives in", () => {
	assert.equal(canonicalRemote("https://github.com/acme/api.git"), "github.com/acme/api");
	assert.equal(canonicalRemote("https://github.com/acme/api/"), "github.com/acme/api");
	assert.equal(canonicalRemote("git@github.com:acme/api.git"), "github.com/acme/api");
	assert.equal(canonicalRemote("ssh://git@github.com:22/acme/api"), "github.com/acme/api");
	assert.equal(canonicalRemote("HTTPS://GitHub.com/ACME/API.git"), "github.com/acme/api");
	assert.equal(
		canonicalRemote("https://user:ghp_secret@github.com/acme/api.git"),
		"github.com/acme/api",
		"credentials must never reach the key",
	);
	assert.ok(!String(canonicalRemote("https://user:ghp_secret@github.com/acme/api.git")).includes("ghp"));
	assert.equal(canonicalRemote("/home/aaron/repos/api"), null, "a local path is not a shareable identity");
	assert.equal(canonicalRemote("file:///home/aaron/repos/api.git"), null);
	assert.equal(canonicalRemote(""), null);
});
check("the namespace id is filesystem-safe, stable and not a reserved name", () => {
	const id = nsIdFromKey("github.com/acme/api");
	assert.equal(id, nsIdFromKey("github.com/acme/api"));
	assert.match(id, /^[a-z0-9][a-z0-9._-]{0,63}$/);
	assert.notEqual(id, nsIdFromKey("github.com/acme/web"), "different repositories must not collide");
	assert.equal(isValidNs(".."), false);
	assert.equal(isValidNs("a/b"), false);
	assert.equal(isValidNs("Core"), false);
	assert.equal(isValidNs("core"), false, "core is not a namespace: it has its own endpoint");
	assert.equal(isValidNs("shared"), true);
});
check("the preferred remote decides, so a fork is not silently the upstream project", () => {
	const remotes = [
		{ name: "upstream", url: "git@github.com:acme/api.git" },
		{ name: "origin", url: "git@github.com:me/api.git" },
	];
	assert.equal(pickRemote(remotes)?.name, "origin");
	assert.equal(pickRemote(remotes, "upstream")?.name, "upstream");
	assert.equal(pickRemote([{ name: "b", url: "x" }, { name: "a", url: "y" }])?.name, "a", "the pick is stable");
	assert.equal(pickRemote([]), null);
});
check("every worktree of one repository resolves to the same root", () => {
	assert.equal(mainWorktreeRoot("/repo", ".git"), "/repo");
	assert.equal(mainWorktreeRoot("/repo/.worktrees/one", "/repo/.git"), "/repo");
	assert.equal(mainWorktreeRoot("/repo", null), "/repo");
});
check("the ladder prefers the remote, then this machine's copy, then the path", () => {
	const base = { cwd: "/repo", hostname: "mac", git: null };
	const git = {
		toplevel: "/repo",
		commonDir: "/repo/.git",
		remotes: [{ name: "origin", url: "git@github.com:acme/api.git" }],
		superproject: null,
	};
	const withRemote = resolveNamespace({ ...base, git });
	assert.equal(withRemote.source, "remote");
	assert.equal(withRemote.key, "github.com/acme/api");
	assert.equal(withRemote.ns, nsIdFromKey("github.com/acme/api"));
	assert.equal(
		resolveNamespace({ ...base, cwd: "/somewhere/else", git: { ...git, toplevel: "/somewhere/else" } }).ns,
		withRemote.ns,
		"a second clone is the same project",
	);

	const noRemote = resolveNamespace({ ...base, git: { ...git, remotes: [] } });
	assert.equal(noRemote.source, "toplevel");
	assert.equal(
		resolveNamespace({
			...base,
			git: { ...git, remotes: [], toplevel: "/repo/.worktrees/one", commonDir: "/repo/.git" },
		}).ns,
		noRemote.ns,
		"without a remote, worktrees still share one namespace",
	);
	assert.notEqual(
		resolveNamespace({ ...base, git: { ...git, remotes: [] }, hostname: "other-box" }).ns,
		noRemote.ns,
		"a remote-less repository cannot be shared across machines",
	);

	const plain = resolveNamespace(base);
	assert.equal(plain.source, "path");
	assert.notEqual(plain.ns, resolveNamespace({ ...base, cwd: "/other" }).ns);

	const pinned = resolveNamespace({ ...base, git, pin: "My-Project" });
	assert.equal(pinned.source, "pin");
	assert.equal(pinned.ns, "my-project");
	assert.equal(
		resolveNamespace({ ...base, git, pin: "../etc" }).source,
		"remote",
		"a pin that is not a legal namespace id must not escape the namespace dir",
	);
	assert.equal(resolveNamespace({ ...base, fallback: "legacy" }).ns, DEFAULT_NS);
	assert.equal(
		resolveNamespace({ ...base, git, fallback: "legacy" }).source,
		"remote",
		"the fallback is used last, not first",
	);
});
await checkAsync("repository facts are read from git, not guessed", async () => {
	const table: Record<string, string> = {
		"rev-parse --show-toplevel": "/repo\n",
		"rev-parse --git-common-dir": "/repo/.git\n",
		"rev-parse --show-superproject-working-tree": "\n",
		"remote -v":
			"origin\tgit@github.com:acme/api.git (fetch)\norigin\tgit@github.com:acme/api.git (push)\nupstream\thttps://github.com/acme/upstream.git (fetch)\n",
	};
	const fake = async (_file: string, args: string[]) => {
		const out = table[args.slice(2).join(" ")];
		if (out === undefined) return { ok: false, stdout: "", stderr: "", missing: false, code: 128 };
		return { ok: true, stdout: out, stderr: "", missing: false, code: 0 };
	};
	const facts = await detectGit("/repo", fake);
	assert.ok(facts);
	assert.equal(facts.toplevel, "/repo");
	assert.deepEqual(facts.remotes.map((r) => r.name), ["origin", "upstream"], "one entry per remote, fetch lines only");
	assert.equal(facts.superproject, null);
	const resolved = await resolveForCwd("/repo", fake, { hostname: "mac" });
	assert.equal(resolved.source, "remote");
	assert.equal(resolved.ns, nsIdFromKey("github.com/acme/api"));

	// No git at all: a clean fall-through to the path rung, not an exception.
	const noGit = async () => ({ ok: false, stdout: "", stderr: "", missing: true, code: 127 });
	assert.equal(await detectGit("/tmp", noGit), null);
	const scratch = await resolveForCwd("/tmp/scratch", noGit, { hostname: "mac" });
	assert.equal(scratch.source, "path");
	assert.equal(scratch.ns, (await resolveForCwd("/tmp/scratch", noGit, { hostname: "mac" })).ns);
	assert.notEqual(scratch.ns, (await resolveForCwd("/tmp/other", noGit, { hostname: "mac" })).ns);
	assert.equal((await resolveForCwd("/tmp/scratch", noGit, { hostname: "mac", fallback: "legacy" })).ns, DEFAULT_NS);
});

console.log("memory hygiene: dedup, budgets, migration");
check("a restated fact replaces its entry instead of growing the file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-dedup-"));
	try {
		const file = path.join(dir, "MEMORY.md");
		const first = writeEntry(file, "<!-- t1 -->\nThe brain listens on port 8787", "The brain listens on port 8787");
		assert.equal(first.deduped, false);
		const second = writeEntry(file, "<!-- t2 -->\nThe brain listens on 8787", "The brain listens on 8787");
		assert.equal(second.deduped, true, "restating a fact must not add a second copy");
		const content = fs.readFileSync(file, "utf-8");
		assert.equal(content.split("\n").filter((l) => l.trim()).length, 2, "one stamp and one entry");
		assert.ok(!content.includes("t1"), "the replaced entry's stamp goes with it");
		const changed = writeEntry(file, "<!-- t3 -->\nThe brain listens on port 9000 instead", "The brain listens on port 9000 instead");
		assert.equal(changed.deduped, false, "a changed fact is a new entry, not a replacement");
		assert.equal(similarity(tokenize("one two three"), tokenize("one two three")), 1);
		assert.equal(similarity(tokenize("alpha"), tokenize("beta")), 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
check("the injected block is budgeted, and core is never what gets dropped", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-ctx-"));
	try {
		const ns = "project-ctx";
		fs.mkdirSync(path.join(root, "core"), { recursive: true });
		fs.mkdirSync(path.join(root, "ns", ns, "daily"), { recursive: true });
		fs.writeFileSync(path.join(root, "core", "MEMORY.md"), "- never use ternary operators\n");
		fs.writeFileSync(path.join(root, "ns", ns, "MEMORY.md"), "# project\n\n- decided to use postgres\n");
		const notes = Array.from({ length: 2_000 }, (_, i) => `- note ${i} ${i === 0 ? "#first" : ""} ${i === 1_999 ? "#last" : ""}`);
		fs.writeFileSync(path.join(root, "ns", ns, "daily", `${todayStr()}.md`), notes.join("\n\n"));

		// A log longer than its budget is clipped to the newest part, and says so.
		const clipped = buildContext(root, ns);
		assert.match(clipped, /never use ternary operators/, "core survives any budget pressure");
		assert.match(clipped, /decided to use postgres/);
		assert.match(clipped, /truncated to \d+ of \d+ chars/, "the log is trimmed and the trim is visible");
		assert.match(clipped, /#last/, "the newest notes are the ones kept");
		assert.ok(!clipped.includes("#first"), "the oldest notes are what gets dropped");
		assert.ok(clipped.length <= TOTAL_CONTEXT_CHARS + 2_000, `budget respected: ${clipped.length} chars`);
		assert.match(clipped, /~\d+ tokens/, "the size of each tier is visible");

		// With the project file at its own budget, the daily log keeps only what is left
		// over — it is not thrown away while the budget still has room.
		const facts = Array.from({ length: 400 }, (_, i) => `- fact ${i} ${"y".repeat(30)}`);
		fs.writeFileSync(path.join(root, "ns", ns, "MEMORY.md"), facts.join("\n\n"));
		const squeezed = buildContext(root, ns);
		assert.match(squeezed, /never use ternary operators/);
		assert.match(squeezed, /#last/, "the log keeps its newest notes rather than vanishing");
		assert.ok(!squeezed.includes("#first"), "and gives up its oldest");
		assert.ok(squeezed.length <= TOTAL_CONTEXT_CHARS + 2_000, `budget respected: ${squeezed.length} chars`);
		const projectSection = squeezed.match(/## Project memory \([^)]+\)[^[]*\[(\d+) chars/);
		assert.ok(projectSection, "the project tier is still in the block");
		assert.ok(
			Number(projectSection?.[1] ?? 0) > 6_000,
			`the project's own memory keeps most of its budget: ${projectSection?.[1]} chars`,
		);

		// A full scratchpad plus a yesterday log cannot both fit: the automatic log
		// goes first, and the deliberate checklist and the project file stay.
		fs.writeFileSync(path.join(root, "ns", ns, "SCRATCHPAD.md"), `- [ ] #scratchmark ${"z".repeat(3_900)}\n`);
		fs.writeFileSync(path.join(root, "ns", ns, "daily", `${yesterdayStr()}.md`), "- yesterday note #yesterdaymark\n");
		const tight = buildContext(root, ns);
		assert.match(tight, /#scratchmark/, "the checklist survives");
		assert.ok(!tight.includes("#yesterdaymark"), "the oldest log is dropped first");
		assert.ok(!tight.includes("#last"), "then today's log, before the project's memory");
		assert.ok(
			Number(tight.match(/## Project memory \([^)]+\)[^[]*\[(\d+) chars/)?.[1] ?? 0) > 6_000,
			"the project tier is still not the thing that gives way",
		);
		assert.ok(tight.length <= TOTAL_CONTEXT_CHARS + 2_000, `budget respected: ${tight.length} chars`);

		const crossProjectOnly = buildContext(root, null);
		assert.match(crossProjectOnly, /never use ternary operators/, "an unresolvable workspace still gets core");
		assert.ok(!crossProjectOnly.includes("decided to use postgres"), "and no project memory it cannot attribute");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
check("migrating twice cannot duplicate what it moved", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-migrate-"));
	try {
		fs.writeFileSync(path.join(dir, "MEMORY.md"), "- once only\n");
		assert.equal(migrateFlat(dir).migrated, true);
		assert.equal(migrateFlat(dir).migrated, false, "the flat files are gone after the first pass");
		const shared = fs.readFileSync(path.join(dir, "shared", "MEMORY.md"), "utf-8");
		assert.equal(shared.match(/once only/g)?.length, 1);
		assert.equal(fs.existsSync(path.join(dir, "ns", DEFAULT_NS, "MEMORY.md")), true, "the original is archived");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

console.log("core, shared and project tiers over loopback");
await checkAsync("core memory has one writable route and no other", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-core-"));
	const port = await freePort();
	const collection = testCollection();
	const child = await startBrain(dir, port, collection);
	const client = new BrainClient({ host: "127.0.0.1", port, token: "", agentId: "test-agent", transport: localTransport() });
	try {
		assert.equal((await client.readCore()).content, "");
		const added = await client.writeCore({ action: "append", content: "never commit directly to main" });
		assert.equal(added.ok, true);
		assert.match((await client.readCore()).content, /never commit directly to main/);

		const again = await client.writeCore({ action: "append", content: "Never commit directly to main" });
		assert.equal(again.deduped, true, "the same rule twice is one rule");
		assert.equal((await client.readCore()).content.match(/never commit/gi)?.length, 1);

		// No agent route reaches core, at the endpoint rather than by convention.
		await assert.rejects(
			() => client.writeOrQueue({ path: "/v1/write", body: { target: "long_term", ns: "core", content: "sneak" } }),
			/core memory is written only through/,
		);
		await assert.rejects(() => client.forget({ match: "never commit", ns: "core" }), /core memory is edited only through/);
		await assert.rejects(() => client.read("scratchpad", { ns: "core" }), /core memory has no scratchpad/);

		const removed = await client.writeCore({ action: "remove", match: "never commit" });
		assert.equal(removed.removed, 1);
		assert.ok(fs.existsSync(path.join(dir, "core", "recovery", `${removed.recoveryId}.json`)));
		assert.equal((await client.readCore()).content.trim(), "");
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(dir, { recursive: true, force: true });
		removeCollections(collection);
	}
});
await checkAsync("the shared tier is agent-managed and holds MEMORY.md only", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-shared-"));
	const port = await freePort();
	const collection = testCollection();
	const child = await startBrain(dir, port, collection);
	const client = new BrainClient({ host: "127.0.0.1", port, token: "", agentId: "test-agent", transport: localTransport() });
	try {
		await client.writeOrQueue({
			path: "/v1/write",
			body: { target: "long_term", ns: "shared", content: "prefer ripgrep over grep", agent: "a" },
		});
		assert.match((await client.read("long_term", { ns: "shared" })).content, /prefer ripgrep/);

		await assert.rejects(
			() => client.writeOrQueue({ path: "/v1/write", body: { target: "daily", ns: "shared", content: "nope" } }),
			/shared tier holds MEMORY.md only/,
		);
		await assert.rejects(
			() => client.writeNow({ path: "/v1/scratchpad", body: { action: "list", ns: "shared" } }),
			/shared tier holds MEMORY.md only/,
		);

		// An agent prunes shared memory freely.
		const removed = await client.forget({ match: "ripgrep", ns: "shared" });
		assert.equal(removed.removed, 1);

		// And a project write never leaks up into it.
		await client.writeOrQueue({
			path: "/v1/write",
			body: { target: "long_term", ns: "project-iso", content: "a project-only fact", agent: "a" },
		});
		assert.equal((await client.read("long_term", { ns: "shared" })).content.trim(), "");
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(dir, { recursive: true, force: true });
		removeCollections(collection, ["project-iso"]);
	}
});
await checkAsync("namespaces are listed with their sizes, and two can be merged", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-ns-"));
	const port = await freePort();
	const collection = testCollection();
	const child = await startBrain(dir, port, collection);
	const client = new BrainClient({ host: "127.0.0.1", port, token: "", agentId: "test-agent", transport: localTransport() });
	try {
		await client.writeOrQueue({
			path: "/v1/write",
			body: {
				target: "long_term",
				ns: "old-name",
				content: "fact from before the rename",
				agent: "a",
				nsKey: "github.com/acme/old",
				nsLabel: "github.com/acme/old",
			},
		});
		await client.writeOrQueue({ path: "/v1/write", body: { target: "daily", ns: "old-name", content: "a day of work", agent: "a" } });

		const listing = await client.namespaces("old-name");
		const entry = listing.namespaces.find((n) => n.id === "old-name");
		assert.ok(entry, "the namespace should be listed");
		assert.equal(entry.key, "github.com/acme/old", "the canonical key is recorded for the rename case");
		assert.equal(entry.dailyFiles, 1);
		assert.ok(entry.memory > 0);

		const merged = await client.mergeNamespaces("old-name", "new-name");
		assert.equal(merged.moved.daily, 1);
		assert.match((await client.read("long_term", { ns: "new-name" })).content, /fact from before the rename/);
		assert.equal((await client.read("long_term", { ns: "old-name" })).content, "");
		const after = await client.namespaces("new-name");
		assert.ok(!after.namespaces.some((n) => n.id === "old-name"));
		assert.equal(after.namespaces.find((n) => n.id === "new-name")?.dailyFiles, 1);
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(dir, { recursive: true, force: true });
		removeCollections(collection, ["old-name", "new-name"]);
	}
});
await checkAsync("a bad namespace is refused, and no namespace means the legacy one", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-legacy-"));
	const port = await freePort();
	const collection = testCollection();
	const child = await startBrain(dir, port, collection);
	const client = new BrainClient({ host: "127.0.0.1", port, token: "", agentId: "test-agent", transport: localTransport() });
	try {
		const raw = await localTransport()("127.0.0.1", port, {
			method: "GET",
			path: "/v1/read?target=long_term&ns=../..",
			headers: {},
		});
		assert.equal(raw.status, 400, "a namespace is a directory name and must not escape");
		await assert.rejects(() => client.read("long_term", { ns: "../../etc" }), /invalid ns/);

		// A caller that names nothing, such as a pre-tier agent, lands where the old
		// flat memory was moved rather than in core or in someone's project.
		await client.writeOrQueue({
			path: "/v1/write",
			body: { target: "long_term", content: "written without a namespace", agent: "old-agent" },
		});
		assert.ok(fs.existsSync(path.join(dir, "ns", DEFAULT_NS, "MEMORY.md")));
		const listing = await client.namespaces();
		assert.equal(listing.default, DEFAULT_NS);
		assert.equal(listing.namespaces.find((n) => n.id === DEFAULT_NS)?.archived, true);
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(dir, { recursive: true, force: true });
		removeCollections(collection);
	}
});
await checkAsync("the flat v0.1 layout is moved into tiers on startup", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-mig-int-"));
	fs.mkdirSync(path.join(dir, "daily"), { recursive: true });
	fs.writeFileSync(path.join(dir, "MEMORY.md"), "- a durable decision from before tiers\n");
	fs.writeFileSync(path.join(dir, "SCRATCHPAD.md"), "- [ ] an open item\n- [x] a finished item\n");
	fs.writeFileSync(path.join(dir, "daily", "2026-01-02.md"), "old daily log\n");
	const port = await freePort();
	const collection = testCollection();
	const child = await startBrain(dir, port, collection);
	const client = new BrainClient({ host: "127.0.0.1", port, token: "", agentId: "test-agent", transport: localTransport() });
	try {
		const shared = await client.read("long_term", { ns: "shared" });
		assert.match(shared.content, /a durable decision from before tiers/);
		assert.match(shared.content, /an open item/);
		assert.ok(!shared.content.includes("a finished item"), "a finished item is history, not memory");

		const archived = await client.read("daily", { ns: DEFAULT_NS, date: "2026-01-02" });
		assert.match(archived.content, /old daily log/);
		assert.ok(fs.existsSync(path.join(dir, "ns", DEFAULT_NS, "SCRATCHPAD.md")));

		assert.equal(fs.existsSync(path.join(dir, "MEMORY.md")), false, "nothing flat is left to migrate twice");
		assert.equal(fs.existsSync(path.join(dir, "daily")), false);
		assert.equal((await client.readCore()).content, "", "migration must never write core");
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(dir, { recursive: true, force: true });
		removeCollections(collection);
	}
});

await checkAsync("a project with no memory yet does not break a search", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-newproj-"));
	const port = await freePort();
	const collection = testCollection();
	const child = await startBrain(dir, port, collection);
	const client = new BrainClient({ host: "127.0.0.1", port, token: "", agentId: "test-agent", transport: localTransport() });
	try {
		await client.writeCore({ action: "append", content: "never force push to main" });
		await client.writeOrQueue({
			path: "/v1/write",
			body: { target: "long_term", ns: "shared", content: "prefer ripgrep over grep", agent: "a" },
		});
		// A namespace that has never been written to has no directory, and so no qmd
		// collection. It must not cost the agent the tiers that do have content, which
		// is exactly the "have we done this before?" search in a new repository.
		const res = await client.search("ripgrep", 5, "keyword", { ns: "brand-new-project", scope: "all" });
		assert.ok(res.results.length >= 1, "the shared hit must still be found");
		assert.equal(res.results[0].tier, "shared");
		assert.ok(
			!String(res.note ?? "").includes("Collection not found"),
			`a missing collection must not fail the query: ${res.note}`,
		);
		assert.ok(!fs.existsSync(path.join(dir, "ns", "brand-new-project")), "a search must not create a namespace");
	} finally {
		child.kill("SIGKILL");
		fs.rmSync(dir, { recursive: true, force: true });
		removeCollections(collection, ["brand-new-project"]);
	}
});

console.log("shutdown budget");
check("a budget falls back on nonsense and is clamped", () => {
	assert.equal(budgetMs(undefined, 3000, 60000), 3000, "unset uses the default");
	assert.equal(budgetMs("", 3000, 60000), 3000, "an empty value is not a budget of zero");
	assert.equal(budgetMs("soon", 3000, 60000), 3000, "a typo must not become a timeout of one tick");
	assert.equal(budgetMs("0", 3000, 60000), 3000);
	assert.equal(budgetMs("-1", 3000, 60000), 3000);
	assert.equal(budgetMs("250", 3000, 60000), 250);
	assert.equal(budgetMs("600000", 3000, 60000), 60000, "an env var must not reintroduce the quit that hangs");
});
await checkAsync("work that beats its budget keeps its result", async () => {
	assert.equal(await withBudget(5_000, Promise.resolve("done")), "done");
});
await checkAsync("work that overruns its budget is abandoned, not fatal", async () => {
	// The model call on the exit path: still running when the budget expires.
	let failLater: (err: Error) => void = () => {};
	const slow = new Promise<string>((_resolve, reject) => {
		failLater = reject;
	});
	const started = Date.now();
	assert.equal(await withBudget(50, slow), null, "the caller stops waiting at the deadline");
	assert.ok(Date.now() - started < 2_000, "and does so at the deadline, not when the work ends");

	// Pi exits immediately after the handler returns, so an abandoned promise that
	// rejects on its way out must not become an unhandled rejection and take the
	// process with it.
	let unhandled = 0;
	const onUnhandled = () => {
		unhandled++;
	};
	process.on("unhandledRejection", onUnhandled);
	failLater(new Error("the model call finally failed"));
	await new Promise((r) => setTimeout(r, 50));
	process.off("unhandledRejection", onUnhandled);
	assert.equal(unhandled, 0, "an abandoned capture must not crash the process on its way out");
});
await checkAsync("a per-request deadline reaches the transport", async () => {
	const seen: (number | undefined)[] = [];
	const transport: BrainTransport = async (_host, _port, _req, timeoutMs) => {
		seen.push(timeoutMs);
		return { status: 200, body: "{}" };
	};
	const client = new BrainClient({ host: "127.0.0.1", port: 1, token: "", agentId: "test-agent", transport });
	await client.writeNow({ path: "/v1/write", body: {} }, { timeoutMs: 250 });
	await client.writeNow({ path: "/v1/write", body: {} });
	assert.deepEqual(seen, [250, undefined], "only the caller that asks for a deadline gets one");
});
await checkAsync("a brain that never answers cannot hold up the exit path", async () => {
	// Accepts the connection, then says nothing at all. Without a per-request
	// budget this is the transport's 15s default, which is the slow /quit.
	const open: net.Socket[] = [];
	const silent = net.createServer((socket) => {
		open.push(socket);
	});
	await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
	const port = (silent.address() as net.AddressInfo).port;
	const client = new BrainClient({
		host: "127.0.0.1",
		port,
		token: "",
		agentId: "test-agent",
		transport: localTransport(),
	});
	try {
		const started = Date.now();
		await assert.rejects(
			() => client.writeNow({ path: "/v1/write", body: {} }, { timeoutMs: 200 }),
			/request timed out/,
		);
		const took = Date.now() - started;
		assert.ok(took < 2_000, `the request must give up on its own budget, took ${took}ms`);
	} finally {
		for (const socket of open) socket.destroy();
		silent.close();
	}
});

console.log("extension registration");
await checkAsync("the extension registers its commands and tools", async () => {
	const mod = await import("../index.js");
	const commands: string[] = [];
	const tools: string[] = [];
	const toolDefs: { name: string; parameters: { properties: Record<string, { enum?: string[] }> } }[] = [];
	const events: string[] = [];
	const stub = {
		on(event: string) {
			events.push(event);
			return () => {};
		},
		registerTool(tool: { name: string; parameters: { properties: Record<string, { enum?: string[] }> } }) {
			tools.push(tool.name);
			toolDefs.push(tool);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	};
	mod.default(stub as never);
	assert.deepEqual(commands.sort(), [
		"psm-core-memory",
		"psm-install-qmd",
		"psm-join",
		"psm-memory",
		"psm-reset",
		"psm-role",
		"psm-update",
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
	// The user can put a rule in core memory by asking for it; the scope is what
	// carries that permission, so the tool has to accept it.
	const write = toolDefs.find((t) => t.name === "memory_write");
	assert.ok(write, "memory_write is registered");
	assert.deepEqual(write.parameters.properties.scope.enum, ["project", "shared", "core"]);
});

fs.rmSync(process.env.PI_SCALE_MEMORY_CONFIG_DIR as string, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
console.log("all tests passed");
