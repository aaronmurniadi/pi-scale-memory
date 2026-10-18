/**
 * The brain's own Tailscale node.
 *
 * It runs a **userspace** tailscaled with a private socket and its own state
 * file, so joining a tailnet never touches the machine's system Tailscale and
 * never needs sudo. Because a userspace node cannot accept inbound packets on
 * behalf of a local service, the memory API is published to the tailnet with
 * `tailscale serve --tcp`, which proxies tailnet traffic to 127.0.0.1.
 *
 * Every CLI call passes `--socket=`, which is the guarantee that the host daemon
 * is never read or modified.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configDir } from "./config.js";
import { daemonFiles, daemonRunning, ensureDaemon, openLog, recordPid, stopDaemon } from "./daemon.js";
import {
	agentUpArgs,
	failureText,
	freePort,
	parsePeers,
	run,
	waitFor,
	type BrainPeer,
	type RunResult,
} from "./tailnet.js";

const DAEMON = "brain-tailscaled";
const AGENT_DAEMON = "agent-tailscaled";

export interface BrainNodePaths {
	state: string;
	socket: string;
}

export function brainNodePaths(): BrainNodePaths {
	const dir = path.join(configDir(), "brain-tailnet");
	return { state: path.join(dir, "tailscaled.state"), socket: path.join(dir, "tailscaled.sock") };
}

/** A stable name, so restarts do not leave a trail of dead devices. */
function nodeHostname(prefix: string, machineHost: string): string {
	const clean = machineHost
		.split(".")[0]
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!clean) return prefix;
	return `${prefix}-${clean}`;
}

export function brainNodeHostname(machineHost: string): string {
	return nodeHostname("pi-brain", machineHost);
}

export function agentNodeHostname(machineHost: string): string {
	return nodeHostname("pi-agent", machineHost);
}

export interface BrainNodeStatus {
	backendState: string;
	hostname: string;
	tags: string[];
	ip: string;
	dnsName: string;
}

export function parseNodeStatus(raw: string): BrainNodeStatus | null {
	let json: any;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const self = json?.Self ?? {};
	const ips: string[] = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(String) : [];
	let ip = "";
	for (const candidate of ips) {
		if (!candidate.includes(":")) {
			ip = candidate;
			break;
		}
	}
	if (!ip && ips.length > 0) ip = ips[0];
	let dns = String(self.DNSName ?? "").trim();
	if (dns.endsWith(".")) dns = dns.slice(0, -1);
	return {
		backendState: String(json?.BackendState ?? "Unknown"),
		hostname: String(self.HostName ?? ""),
		tags: Array.isArray(self.Tags) ? self.Tags.map(String) : [],
		ip,
		dnsName: dns,
	};
}

/** Other devices already carrying the tag, from a `status --json` payload. */
export function parseTaggedPeers(raw: string, tag: string): string[] {
	let json: any;
	try {
		json = JSON.parse(raw);
	} catch {
		return [];
	}
	const names: string[] = [];
	for (const peer of Object.values<any>(json?.Peer ?? {})) {
		const tags: string[] = Array.isArray(peer?.Tags) ? peer.Tags.map(String) : [];
		if (!tags.includes(tag)) continue;
		names.push(String(peer?.HostName ?? peer?.DNSName ?? "unknown"));
	}
	return names.sort();
}

/**
 * Joining args for the brain's node. Nothing here advertises a tag: a key that
 * carries one applies it by itself, which needs no tailnet permission, and a key
 * without one is fine because agents identify the brain by asking it.
 */
export function upArgs(authKey: string, hostname: string): string[] {
	return [
		"up",
		`--auth-key=${authKey}`,
		`--hostname=${hostname}`,
		"--accept-dns=false",
		"--accept-routes=false",
		"--timeout=60s",
	];
}

/**
 * Tailscale's answer when a key carries a tag the tailnet will not accept:
 * "backend error: requested tag [tag:x] are invalid or not permitted". This
 * extension never asks for a tag, so it can only come from the key itself.
 */
export function tagRejected(stderr: string): boolean {
	return /requested tag|invalid or not permitted/i.test(stderr);
}

/**
 * Tailscale's answer when a pre-auth key cannot register a node: it was already
 * spent, revoked or expired. Keys are single-use unless they were created
 * reusable, so the second join with the same key gets this instead of a node.
 */
export function keyRejected(stderr: string): boolean {
	return /invalid (?:auth )?key|auth key already used|auth key expired|key has expired/i.test(stderr);
}

/**
 * A refused key is expected, not mysterious: one join per machine is enough here,
 * because a node keeps its state and reuses its device from then on. The most
 * likely cause is a single-use key that this machine has already joined with.
 */
export function keyRejectedHelp(command = "/join-tailnet-agent", detail = ""): string {
	const lines = [
		"Tailscale refused this pre-auth key, so this node could not register.",
		"",
		"A key is single-use unless Reusable is set, and a one-off key is spent by the",
		"first node that joins with it. This extension joins once per machine, not once",
		"per session: the node keeps its state and reuses its device afterwards.",
		"",
		"Create a fresh key in the Tailscale admin console (Settings -> Keys), then run",
		`${command} again. Leave Reusable off if you prefer one key per machine.`,
	];
	if (detail) lines.push("", `Tailscale said: ${detail}`);
	return lines.join("\n");
}

/**
 * Nothing here needs a tag, so a rejected one is always the key's own doing:
 * the key carries tags this tailnet will not accept for it.
 */
export function tagRejectedHelp(observed: string[] = []): string {
	const lines = [
		"Tailscale refused a tag on this pre-auth key.",
		"",
		"This extension does not use tags: agents find the brain by asking each peer.",
		"Simplest fix: create a pre-auth key with no tags and use that.",
	];
	if (observed.length > 0) lines.push("", `The key's tags as applied: ${observed.join(", ")}.`);
	lines.push(
		"",
		"If the key must keep its tags, the tailnet policy has to allow whoever the key",
		"belongs to to apply them (admin console -> Access controls -> tagOwners).",
		"Re-run /join-tailnet-brain afterwards.",
	);
	return lines.join("\n");
}

/** Publish 127.0.0.1:<port> to the tailnet on the same port. */
export function serveArgs(port: number): string[] {
	return ["serve", "--bg", `--tcp=${port}`, `tcp://127.0.0.1:${port}`];
}

/** Withdraw the published port again. */
export function unserveArgs(port: number): string[] {
	return ["serve", `--tcp=${port}`, "off"];
}

function nodeCli(args: string[], timeoutMs = 60000): Promise<RunResult> {
	return run("tailscale", [`--socket=${brainNodePaths().socket}`, ...args], { timeoutMs });
}

/**
 * Take the memory port back off the tailnet. Used when the brain could not be
 * brought up, so agents stop asking a port that nothing answers on.
 */
export async function unpublishBrainPort(port: number): Promise<boolean> {
	const res = await nodeCli(unserveArgs(port), 30000);
	return res.ok;
}

async function nodeStatusRaw(): Promise<string> {
	const res = await nodeCli(["status", "--json"], 20000);
	return res.stdout;
}

export async function nodeStatus(): Promise<BrainNodeStatus | null> {
	const raw = await nodeStatusRaw();
	if (!raw.trim()) return null;
	return parseNodeStatus(raw);
}

function spawnNode(): number | null {
	const paths = brainNodePaths();
	fs.mkdirSync(path.dirname(paths.state), { recursive: true });
	const out = openLog(DAEMON);
	const child = spawn(
		"tailscaled",
		[
			"--tun=userspace-networking",
			`--state=${paths.state}`,
			`--socket=${paths.socket}`,
		],
		{ detached: true, stdio: ["ignore", out, out] },
	);
	child.unref();
	if (typeof child.pid === "number") {
		recordPid(DAEMON, child.pid);
		return child.pid;
	}
	return null;
}

export interface EnsureNodeResult {
	ok: boolean;
	detail: string;
	status?: BrainNodeStatus;
	joined: boolean;
	served: boolean;
	/** Tags the key happened to carry, reported for context. */
	tags?: string[];
}

/**
 * Bring the brain's node up: start tailscaled, join with the key when one is
 * given (or the saved state is not authenticated yet), and publish the memory
 * port to the tailnet.
 */
export async function ensureBrainNode(opts: {
	port: number;
	authKey?: string;
	log?: (message: string) => void;
}): Promise<EnsureNodeResult> {
	const log = opts.log ?? (() => {});
	if (!daemonRunning(DAEMON)) log("starting the brain's tailscaled (userspace, no sudo)");
	const daemon = await ensureDaemon({
		name: DAEMON,
		spawn: spawnNode,
		probe: async () => {
			const status = await nodeStatus();
			return status !== null;
		},
		timeoutMs: 15000,
	});
	if (!daemon.ok) {
		return { ok: false, detail: `tailscaled: ${daemon.detail}; log: ${daemonFiles(DAEMON).log}`, joined: false, served: false };
	}

	let status = await nodeStatus();
	let joined = false;
	// Tags are optional now: agents identify the brain by asking it. A missing
	// tag is no longer a reason to join again.
	const needsJoin = !status || status.backendState !== "Running";

	if (needsJoin) {
		if (!opts.authKey) {
			return {
				ok: false,
				detail: "this machine's tailscale node is not joined yet; run /join-tailnet-brain with a pre-auth key",
				status: status ?? undefined,
				joined: false,
				served: false,
			};
		}
		const hostname = brainNodeHostname(os.hostname());

		let up = await nodeCli(upArgs(opts.authKey, hostname), 120000);
		if (!up.ok && /non-default|explicitly mention/i.test(up.stderr)) {
			// This node exists only for pi-scale-memory, so clearing its own
			// preferences disturbs nothing of the user's.
			up = await nodeCli([...upArgs(opts.authKey, hostname), "--reset"], 120000);
		}
		if (!up.ok) {
			let detail = `tailscale up failed: ${up.stderr.trim().split("\n").slice(-3).join(" ")}`;
			if (tagRejected(up.stderr)) detail = tagRejectedHelp(status?.tags ?? []);
			if (keyRejected(up.stderr)) detail = keyRejectedHelp("/join-tailnet-brain", failureText(up));
			return { ok: false, detail, status: status ?? undefined, joined: false, served: false };
		}
		joined = true;
		status = await waitFor(async () => {
			const current = await nodeStatus();
			return Boolean(current && current.backendState === "Running");
		}, 30000).then(async () => nodeStatus());

	}

	if (!status || status.backendState !== "Running") {
		return { ok: false, detail: "the brain's tailscale node is not running yet", status: status ?? undefined, joined, served: false };
	}
	const served = await nodeCli(serveArgs(opts.port), 60000);
	if (!served.ok && !/already|configured/i.test(served.stderr)) {
		return {
			ok: false,
			detail: `could not publish the memory port to the tailnet: ${served.stderr.trim().split("\n").slice(-3).join(" ")}`,
			status,
			joined,
			served: false,
		};
	}

	return {
		ok: true,
		detail: `${status.hostname || "brain"} at ${status.ip || status.dnsName}`,
		status,
		joined,
		served: true,
		tags: status.tags,
	};
}

export async function stopBrainNode(): Promise<{ stopped: boolean; detail: string }> {
	return stopDaemon(DAEMON);
}

export function brainNodeRunning(): boolean {
	return daemonRunning(DAEMON);
}

// ---------------------------------------------------------------------------
// The agent's own Tailscale node
// ---------------------------------------------------------------------------

/**
 * One agent node per machine, not one per session.
 *
 * It runs detached with its own state, exactly like the brain's node, so it
 * registers a single device and joins once. Later sessions reuse it, which is
 * what makes a single-use pre-auth key enough: the key is spent by the first
 * join on a machine and never needed again.
 */
export interface AgentNodePaths {
	state: string;
	socket: string;
	/** Where the SOCKS5 port is recorded, so any session can attach to the node. */
	socks: string;
}

export function agentNodePaths(): AgentNodePaths {
	const dir = path.join(configDir(), "agent-tailnet");
	return {
		state: path.join(dir, "tailscaled.state"),
		socket: path.join(dir, "tailscaled.sock"),
		socks: path.join(dir, "socks-port"),
	};
}

function agentCli(args: string[], timeoutMs = 60000): Promise<RunResult> {
	return run("tailscale", [`--socket=${agentNodePaths().socket}`, ...args], { timeoutMs });
}

export async function agentNodeStatus(): Promise<BrainNodeStatus | null> {
	const res = await agentCli(["status", "--json"], 20000);
	if (!res.stdout.trim()) return null;
	return parseNodeStatus(res.stdout);
}

/** Every peer this node can see. */
export async function agentPeers(): Promise<BrainPeer[]> {
	const res = await agentCli(["status", "--json"], 15000);
	if (!res.ok) return [];
	return parsePeers(res.stdout);
}

/**
 * Ask the Tailscale layer to reach a peer.
 *
 * A node that has just joined has the peer list but no paths yet, and magicsock
 * only learns a peer's endpoints when something tries to use it. That trigger is
 * the whole point here, so the answer is not interesting: magicsock keeps going
 * after this returns, and even after the call is given up on.
 */
export async function agentPing(ip: string, timeoutMs = 1000): Promise<boolean> {
	const res = await agentCli(["ping", "--c=1", ip], timeoutMs);
	return res.ok;
}

/** The port recorded when the node was started, so a later session can attach. */
export function agentSocksPort(): number | null {
	try {
		const raw = Number(fs.readFileSync(agentNodePaths().socks, "utf-8").trim());
		if (Number.isInteger(raw) && raw > 0) return raw;
	} catch {
		/* not written yet */
	}
	return null;
}

function spawnAgentNode(socksPort: number): number | null {
	const paths = agentNodePaths();
	fs.mkdirSync(path.dirname(paths.state), { recursive: true });
	// A socket file left behind by a killed daemon would stop the next one from
	// binding, so clear it when nothing is alive to own it.
	if (!agentNodeRunning()) fs.rmSync(paths.socket, { force: true });
	fs.writeFileSync(paths.socks, String(socksPort), { mode: 0o600 });
	const out = openLog(AGENT_DAEMON);
	const child = spawn(
		"tailscaled",
		[
			"--tun=userspace-networking",
			`--socks5-server=127.0.0.1:${socksPort}`,
			`--state=${paths.state}`,
			`--socket=${paths.socket}`,
		],
		{ detached: true, stdio: ["ignore", out, out] },
	);
	child.unref();
	fs.closeSync(out);
	if (typeof child.pid === "number") {
		recordPid(AGENT_DAEMON, child.pid);
		return child.pid;
	}
	return null;
}

export interface EnsureAgentNodeResult {
	ok: boolean;
	detail: string;
	/** Up, and answering on this port, when ok. */
	socksPort?: number;
	hostname?: string;
	/** True when this call was the one that consumed the pre-auth key. */
	joined: boolean;
}

/**
 * Bring up this machine's agent node and return the address of its SOCKS5 proxy.
 *
 * The node is joined only when its saved state is not authenticated yet, so the
 * pre-auth key is needed on the first run on a machine and never again. A node
 * that is alive but unreachable is restarted rather than adopted: its identity
 * lives in the state file, so restarting costs no key.
 */
export async function ensureAgentNode(opts: {
	authKey?: string;
	loginServer?: string;
	log?: (message: string) => void;
}): Promise<EnsureAgentNodeResult> {
	const log = opts.log ?? (() => {});

	const reachable = async (): Promise<boolean> => {
		if (agentSocksPort() === null) return false;
		return (await agentNodeStatus()) !== null;
	};

	if (agentNodeRunning() && !(await reachable())) {
		log("restarting this machine's tailnet node; its saved identity is kept");
		await stopDaemon(AGENT_DAEMON);
	}

	if (!(await reachable())) {
		log("starting this machine's tailnet node (userspace, no sudo)");
		const port = await freePort();
		const daemon = await ensureDaemon({
			name: AGENT_DAEMON,
			spawn: () => spawnAgentNode(port),
			probe: async () => (await agentNodeStatus()) !== null,
			timeoutMs: 15000,
		});
		if (!daemon.ok) {
			return {
				ok: false,
				detail: `tailscaled: ${daemon.detail}; log: ${daemonFiles(AGENT_DAEMON).log}`,
				joined: false,
			};
		}
	}

	let status = await agentNodeStatus();
	let joined = false;
	if (!status || status.backendState !== "Running") {
		if (!opts.authKey) {
			return {
				ok: false,
				detail: "this machine's tailscale node is not joined yet; run /join-tailnet-agent with a pre-auth key",
				joined: false,
			};
		}
		const hostname = agentNodeHostname(os.hostname());
		const args = agentUpArgs(hostname, opts.authKey, opts.loginServer);
		let up = await agentCli(args, 120000);
		if (!up.ok && /non-default|explicitly mention/i.test(up.stderr)) {
			// This node exists only for pi-scale-memory, so clearing its own
			// preferences disturbs nothing of the user's.
			up = await agentCli([...args, "--reset"], 120000);
		}
		if (!up.ok) {
			if (keyRejected(up.stderr)) {
				return { ok: false, detail: keyRejectedHelp("/join-tailnet-agent", failureText(up)), joined: false };
			}
			return { ok: false, detail: `tailscale up failed: ${failureText(up)}`, joined: false };
		}
		joined = true;
		status = await waitFor(async () => {
			const current = await agentNodeStatus();
			return Boolean(current && current.backendState === "Running");
		}, 30000).then(() => agentNodeStatus());
	}

	if (!status || status.backendState !== "Running") {
		return { ok: false, detail: "this machine's tailscale node is not running yet", joined };
	}
	const socksPort = agentSocksPort();
	if (socksPort === null) {
		return {
			ok: false,
			detail: "the node is up but its SOCKS port is not recorded; run /reset-pi-scale-settings and join again",
			joined,
		};
	}
	return {
		ok: true,
		detail: `${status.hostname || "agent"} at ${status.ip || status.dnsName}`,
		socksPort,
		hostname: status.hostname,
		joined,
	};
}

export function agentNodeRunning(): boolean {
	return daemonRunning(AGENT_DAEMON);
}

export async function stopAgentNode(): Promise<{ stopped: boolean; detail: string }> {
	return stopDaemon(AGENT_DAEMON);
}

/** Invalidate the agent node's key, so a reset does not leave it live. */
export async function logoutAgentNode(): Promise<boolean> {
	const paths = agentNodePaths();
	if (!fs.existsSync(paths.socket)) return false;
	const res = await run("tailscale", [`--socket=${paths.socket}`, "logout"], { timeoutMs: 20000 });
	return res.ok;
}
