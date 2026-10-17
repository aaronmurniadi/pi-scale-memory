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
import { BRAIN_TAG, run, waitFor, type RunResult } from "./tailnet.js";

const DAEMON = "brain-tailscaled";

export interface BrainNodePaths {
	state: string;
	socket: string;
}

export function brainNodePaths(): BrainNodePaths {
	const dir = path.join(configDir(), "brain-tailnet");
	return { state: path.join(dir, "tailscaled.state"), socket: path.join(dir, "tailscaled.sock") };
}

/** A stable name, so restarts do not leave a trail of dead devices. */
export function brainNodeHostname(machineHost: string): string {
	const clean = machineHost
		.split(".")[0]
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!clean) return "pi-brain";
	return `pi-brain-${clean}`;
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

export function upArgs(authKey: string, hostname: string): string[] {
	return [
		"up",
		`--auth-key=${authKey}`,
		`--advertise-tags=${BRAIN_TAG}`,
		`--hostname=${hostname}`,
		"--accept-dns=false",
		"--accept-routes=false",
		"--timeout=60s",
	];
}

/** Publish 127.0.0.1:<port> to the tailnet on the same port. */
export function serveArgs(port: number): string[] {
	return ["serve", "--bg", `--tcp=${port}`, `tcp://127.0.0.1:${port}`];
}

function nodeCli(args: string[], timeoutMs = 60000): Promise<RunResult> {
	return run("tailscale", [`--socket=${brainNodePaths().socket}`, ...args], { timeoutMs });
}

export async function nodeStatus(): Promise<BrainNodeStatus | null> {
	const res = await nodeCli(["status", "--json"], 20000);
	if (!res.stdout.trim()) return null;
	return parseNodeStatus(res.stdout);
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
	const needsJoin = !status || status.backendState !== "Running" || !status.tags.includes(BRAIN_TAG);

	if (needsJoin) {
		if (!opts.authKey) {
			return {
				ok: false,
				detail: `the brain's tailscale node is not joined as ${BRAIN_TAG} yet; run /join-tailnet-brain with a pre-auth key`,
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
			return {
				ok: false,
				detail: `tailscale up failed: ${up.stderr.trim().split("\n").slice(-3).join(" ")}`,
				status: status ?? undefined,
				joined: false,
				served: false,
			};
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
	if (!status.tags.includes(BRAIN_TAG)) {
		return {
			ok: false,
			detail: `this device reports tags: ${status.tags.length ? status.tags.join(", ") : "none"}; expected ${BRAIN_TAG} — the pre-auth key must be tagged ${BRAIN_TAG}`,
			status,
			joined,
			served: false,
		};
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

	return { ok: true, detail: `${status.hostname || "brain"} at ${status.ip || status.dnsName}`, status, joined, served: true };
}

export async function stopBrainNode(): Promise<{ stopped: boolean; detail: string }> {
	return stopDaemon(DAEMON);
}

export function brainNodeRunning(): boolean {
	return daemonRunning(DAEMON);
}
