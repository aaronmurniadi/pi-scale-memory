import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const AGENT_TAG = "tag:agent";
export const BRAIN_TAG = "tag:brain";

export interface BrainPeer {
	name: string;
	ip: string;
	online: boolean;
}

function run(file: string, args: string[], timeoutMs = 30000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

export async function tailscaleInstalled(): Promise<boolean> {
	const [cli, daemon] = await Promise.all([run("tailscale", ["version"], 5000), run("tailscaled", ["--version"], 5000)]);
	return cli.ok && daemon.ok;
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

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export interface TailnetStartOptions {
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

		const deadline = Date.now() + 15000;
		while (!fs.existsSync(this.socket)) {
			if (!this.running) throw new Error("tailscaled exited during startup");
			if (Date.now() > deadline) throw new Error("tailscaled socket did not appear");
			await sleep(200);
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
		const up = await run("tailscale", args, 70000);
		if (!up.ok) {
			await this.stop();
			throw new Error(`tailscale up failed: ${(up.stderr || up.stdout).trim().split("\n").pop()}`);
		}
	}

	async findBrain(): Promise<BrainPeer | null> {
		const st = await run("tailscale", [`--socket=${this.socket}`, "status", "--json"], 15000);
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
			const ip = ips.find((i) => !i.includes(":")) ?? ips[0];
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
