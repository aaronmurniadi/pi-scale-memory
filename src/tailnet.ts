/**
 * Tailscale plumbing.
 *
 * Nothing here ever talks to the machine's system tailscale: every node is a
 * private userspace tailscaled with its own socket and state, run detached and
 * one per machine (both live in src/tailnet-node.ts).
 *   - an agent reaches the brain through its node's SOCKS5 proxy;
 *   - the brain publishes its memory API to the tailnet with `tailscale serve`.
 *
 * A node keeps its own state, so it joins once and then reuses its device. That
 * is what lets a single-use pre-auth key be enough for a machine.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

/** Prefix of the temp dirs that hold an agent node's socket. */
export const PSM_TMP_PREFIX = "psm-";

export interface RunResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	missing: boolean;
}

export interface RunOptions {
	timeoutMs?: number;
	sudo?: boolean;
}

function exitCodeOf(err: NodeJS.ErrnoException | null): { code: number | null; missing: boolean } {
	if (!err) return { code: 0, missing: false };
	const raw = err.code;
	if (typeof raw === "number") return { code: raw, missing: false };
	if (raw === "ENOENT") return { code: 127, missing: true };
	return { code: null, missing: false };
}

export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
	let cmd = file;
	let cmdArgs = args;
	if (opts.sudo) {
		cmd = "sudo";
		cmdArgs = ["-n", file, ...args];
	}
	return new Promise((resolve) => {
		execFile(
			cmd,
			cmdArgs,
			{ timeout: opts.timeoutMs ?? 60000, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const { code, missing } = exitCodeOf(err as NodeJS.ErrnoException | null);
				resolve({ ok: code === 0, code, stdout: String(stdout), stderr: String(stderr), missing });
			},
		);
	});
}

export function failureText(r: RunResult): string {
	const text = `${r.stderr}\n${r.stdout}`.trim();
	if (r.missing) return "command not found";
	if (!text) return `exited with code ${r.code}`;
	return text.split("\n").slice(-4).join("\n");
}


export async function tailscaleInstalled(): Promise<boolean> {
	const [cli, daemon] = await Promise.all([
		run("tailscale", ["version"], { timeoutMs: 5000 }),
		run("tailscaled", ["--version"], { timeoutMs: 5000 }),
	]);
	return cli.ok && daemon.ok;
}

export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return true;
		if (Date.now() > deadline) return false;
		await sleep(250);
	}
}

// ---------------------------------------------------------------------------
// Agent-side userspace tailscaled
// ---------------------------------------------------------------------------

export interface BrainPeer {
	name: string;
	ip: string;
	online: boolean;
}

/** Every peer in the netmap, from a `tailscale status --json` payload. */
export function parsePeers(raw: string): BrainPeer[] {
	let json: any;
	try {
		json = JSON.parse(raw);
	} catch {
		return [];
	}
	const peers: BrainPeer[] = [];
	for (const peer of Object.values<any>(json?.Peer ?? {})) {
		const ips: string[] = Array.isArray(peer?.TailscaleIPs) ? peer.TailscaleIPs.map(String) : [];
		let ip = "";
		for (const candidate of ips) {
			if (!candidate.includes(":")) {
				ip = candidate;
				break;
			}
		}
		if (!ip && ips.length > 0) ip = ips[0];
		if (!ip) continue;
		peers.push({
			name: String(peer?.HostName ?? peer?.DNSName ?? ip),
			ip,
			online: peer?.Online === true,
		});
	}
	return peers;
}

/**
 * Joining arguments for an agent's node.
 *
 * No `--advertise-tags`: the agent does not need a tag to be discovered, since
 * the brain identifies itself when asked. Advertising one would make the join
 * depend on tagOwners and on what the key may apply, which is exactly the
 * dependency this design avoids. A key that carries its own tags still applies
 * them, because that needs no permission of its own.
 */
export function agentUpArgs(hostname: string, authKey: string, loginServer?: string): string[] {
	const args = [
		"up",
		`--auth-key=${authKey}`,
		`--hostname=${hostname}`,
		"--accept-dns=false",
		"--accept-routes=false",
		"--timeout=60s",
	];
	if (loginServer) args.push(`--login-server=${loginServer}`);
	return args;
}

// ---------------------------------------------------------------------------
// Reaping nodes left behind
// ---------------------------------------------------------------------------

/**
 * A session that dies without running its shutdown path leaves its userspace
 * tailscaled behind. Removing the socket dir makes that process unreachable: no
 * CLI call can address it again, and it keeps the tailnet entry it registered.
 * These helpers find those abandoned nodes and end them.
 */

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in seconds, or null when unreadable. */
export function parseElapsed(text: string): number | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	let rest = trimmed;
	let days = 0;
	const dash = rest.indexOf("-");
	if (dash !== -1) {
		days = Number(rest.slice(0, dash));
		rest = rest.slice(dash + 1);
	}
	if (!Number.isFinite(days)) return null;
	let seconds = 0;
	for (const part of rest.split(":")) {
		const value = Number(part);
		if (!Number.isFinite(value)) return null;
		seconds = seconds * 60 + value;
	}
	return days * 86400 + seconds;
}

export interface TailscaledProcess {
	pid: number;
	socket: string;
	/** How long the process has been running, when `ps` reported it. */
	elapsedSeconds: number | null;
}

/** Read `ps -A -o pid=,etime=,command=` output into the userspace nodes it lists. */
export function parseTailscaledProcesses(output: string): TailscaledProcess[] {
	const found: TailscaledProcess[] = [];
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const command = match[3];
		if (!command.includes("tailscaled")) continue;
		if (!command.includes("--tun=userspace-networking")) continue;
		const socket = /--socket=(\S+)/.exec(command);
		if (!socket) continue;
		found.push({ pid: Number(match[1]), socket: socket[1], elapsedSeconds: parseElapsed(match[2]) });
	}
	return found;
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** SIGTERM, then SIGKILL when the process is still there. False if it was gone. */
async function terminate(pid: number): Promise<boolean> {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return false;
	}
	const deadline = Date.now() + 3000;
	while (isRunning(pid) && Date.now() < deadline) await sleep(100);
	if (isRunning(pid)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			return true;
		}
	}
	return true;
}

/**
 * End the userspace tailscaled processes whose socket is gone.
 *
 * A live session always owns a socket file, so only abandoned nodes are touched.
 * The brain's node keeps its socket in the config dir rather than a psm-* temp
 * dir, and is stopped through its pid file instead. `minAgeMs` keeps a node that
 * has just started, and has not created its socket yet, out of reach.
 */
export async function reapOrphanedTailscaled(minAgeMs = 60_000): Promise<number> {
	const res = await run("ps", ["-A", "-o", "pid=,etime=,command="], { timeoutMs: 10000 });
	if (!res.ok) return 0;
	let reaped = 0;
	for (const proc of parseTailscaledProcesses(res.stdout)) {
		if (!path.basename(path.dirname(proc.socket)).startsWith(PSM_TMP_PREFIX)) continue;
		if (fs.existsSync(proc.socket)) continue;
		if (proc.elapsedSeconds !== null && proc.elapsedSeconds * 1000 < minAgeMs) continue;
		if (await terminate(proc.pid)) reaped++;
	}
	return reaped;
}
