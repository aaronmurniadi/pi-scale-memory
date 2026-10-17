/**
 * Tailscale plumbing.
 *
 * Two distinct roles use this module:
 *   - the brain joins the tailnet with the **system** tailscale as tag:brain, so
 *     its memory API is reachable at its tailnet address;
 *   - agents each run a private **userspace** tailscaled (no TUN device, no route
 *     changes, SOCKS5 proxy only) so joining a tailnet never disturbs the
 *     machine's own system tailscale.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const AGENT_TAG = "tag:agent";
export const BRAIN_TAG = "tag:brain";

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

/** Run the system tailscale CLI. */
export function ts(args: string[], timeoutMs = 30000): Promise<RunResult> {
	return run("tailscale", args, { timeoutMs });
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
// System node status (the brain side)
// ---------------------------------------------------------------------------

export interface SystemStatus {
	backendState: string;
	/** MagicDNS name with the trailing dot removed, e.g. brain.tailnet.ts.net. */
	dnsName: string;
	hostName: string;
	tags: string[];
	tailnetName: string;
}

export function parseSystemStatus(raw: string): SystemStatus | null {
	let json: any;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const self = json?.Self ?? {};
	let dns = String(self.DNSName ?? "").trim();
	if (dns.endsWith(".")) dns = dns.slice(0, -1);
	const tailnet = json?.CurrentTailnet ?? {};
	return {
		backendState: String(json?.BackendState ?? "Unknown"),
		dnsName: dns,
		hostName: String(self.HostName ?? ""),
		tags: Array.isArray(self.Tags) ? self.Tags.map(String) : [],
		tailnetName: String(tailnet.Name ?? ""),
	};
}

export async function systemStatus(): Promise<SystemStatus | null> {
	const r = await ts(["status", "--json"], 20000);
	if (!r.ok && !r.stdout.trim()) return null;
	return parseSystemStatus(r.stdout);
}

function attempt(args: string[]): Promise<RunResult> {
	return ts(args, 120000).then((result) => {
		if (!result.ok && /permission denied|must be root|access denied/i.test(result.stderr)) {
			return run("tailscale", args, { timeoutMs: 120000, sudo: true });
		}
		return result;
	});
}

/**
 * Join the system tailscale.
 *
 * A pre-auth key that already carries its tags does not need `--advertise-tags`,
 * and asking for a tag the key cannot grant is an error, so that case is retried
 * without the flag rather than failing the join.
 */
export async function joinSystem(authKey: string, tags: string[] = []): Promise<RunResult> {
	const base = ["up", `--auth-key=${authKey}`];
	const withTags = [...base];
	for (const tag of tags) withTags.push(`--advertise-tags=${tag}`);

	let result = await attempt(withTags);
	if (!result.ok && tags.length > 0 && /tag|owns|permission/i.test(result.stderr)) {
		result = await attempt(base);
	}
	return result;
}

/** `null` when the device carries the tag, otherwise what to tell the user. */
export function missingTagWarning(status: SystemStatus | null, tag: string): string | null {
	if (!status) return "Could not read tailscale status after joining.";
	if (status.tags.includes(tag)) return null;
	let found = "none";
	if (status.tags.length) found = status.tags.join(", ");
	return `This device reports tags: ${found}. Expected ${tag}: the pre-auth key must be tagged ${tag}, and its owner must be allowed to use that tag.`;
}

// ---------------------------------------------------------------------------
// Agent-side userspace tailscaled
// ---------------------------------------------------------------------------

export interface BrainPeer {
	name: string;
	ip: string;
	online: boolean;
}

export interface TailnetStartOptions {
	/** Empty/undefined = the Tailscale control plane. Otherwise a login server URL. */
	loginServer?: string;
	authKey: string;
}

/** A private userspace tailscaled: no TUN device, no route changes, SOCKS5 proxy only. */
export class UserspaceTailnet {
	private proc: ChildProcess | null = null;
	private dir: string | null = null;
	private socket = "";
	socksPort = 0;
	hostname = "";

	get running(): boolean {
		return this.proc !== null && this.proc.exitCode === null;
	}

	async start(opts: TailnetStartOptions): Promise<void> {
		if (this.running) return;
		const id = crypto.randomBytes(3).toString("hex");
		const host = os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-");
		this.hostname = `pi-agent-${host}-${id}`;
		// Keep the path short: unix socket paths are limited to ~104 bytes.
		this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-"));
		this.socket = path.join(this.dir, "ts.sock");
		this.socksPort = await freePort();

		this.proc = spawn(
			"tailscaled",
			[
				"--tun=userspace-networking",
				`--socks5-server=127.0.0.1:${this.socksPort}`,
				"--state=mem:",
				`--socket=${this.socket}`,
			],
			{ stdio: "ignore" },
		);
		this.proc.on("error", () => {});

		const appeared = await waitFor(async () => fs.existsSync(this.socket), 15000);
		if (!appeared) {
			await this.stop();
			throw new Error("tailscaled socket did not appear");
		}

		const args = [
			`--socket=${this.socket}`,
			"up",
			`--auth-key=${opts.authKey}`,
			`--hostname=${this.hostname}`,
			`--advertise-tags=${AGENT_TAG}`,
			"--accept-dns=false",
			"--accept-routes=false",
			"--timeout=60s",
		];
		if (opts.loginServer) args.push(`--login-server=${opts.loginServer}`);
		const up = await run("tailscale", args, { timeoutMs: 90000 });
		if (!up.ok) {
			await this.stop();
			throw new Error(`tailscale up failed: ${failureText(up)}`);
		}
	}

	async findBrain(): Promise<BrainPeer | null> {
		const st = await run("tailscale", [`--socket=${this.socket}`, "status", "--json"], { timeoutMs: 15000 });
		if (!st.ok) return null;
		let json: any;
		try {
			json = JSON.parse(st.stdout);
		} catch {
			return null;
		}
		const peers: BrainPeer[] = [];
		for (const peer of Object.values<any>(json.Peer ?? {})) {
			const tags: string[] = peer.Tags ?? [];
			if (!tags.includes(BRAIN_TAG)) continue;
			const ips: string[] = peer.TailscaleIPs ?? [];
			let ip = ips[0] ?? "";
			for (const candidate of ips) {
				if (!candidate.includes(":")) {
					ip = candidate;
					break;
				}
			}
			if (!ip) continue;
			peers.push({ name: String(peer.HostName ?? peer.DNSName ?? ip), ip, online: peer.Online === true });
		}
		peers.sort((a, b) => Number(b.online) - Number(a.online));
		return peers[0] ?? null;
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		this.proc = null;
		if (proc && proc.exitCode === null) {
			proc.kill("SIGTERM");
			await Promise.race([new Promise((r) => proc.once("exit", r)), sleep(3000)]);
			if (proc.exitCode === null) proc.kill("SIGKILL");
		}
		if (this.dir) {
			fs.rmSync(this.dir, { recursive: true, force: true });
			this.dir = null;
		}
	}
}
