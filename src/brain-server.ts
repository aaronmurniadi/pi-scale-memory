/** Lifecycle of the local brain server process (the brain role). */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { daemonFiles, ensureDaemon, openLog, readDaemonPid, recordPid, stopDaemon } from "./daemon.js";

const DAEMON = "brain";

export function brainServerPath(extDir: string): string {
	return path.join(extDir, "brain", "server.mjs");
}

export function brainLogPath(): string {
	return daemonFiles(DAEMON).log;
}

export function brainPid(): number | null {
	return readDaemonPid(DAEMON);
}

export function healthRequest(port: number, token: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {};
		if (token) headers.authorization = `Bearer ${token}`;
		const req = http.request(
			{ host: "127.0.0.1", port, path: "/v1/health", method: "GET", headers, timeout: 4000 },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
			},
		);
		req.on("timeout", () => req.destroy(new Error("health check timed out")));
		req.on("error", reject);
		req.end();
	});
}

export interface BrainProbe {
	/** Something is listening and answered HTTP (any status). */
	listening: boolean;
	status: number;
}

export async function brainProbe(port: number, token = ""): Promise<BrainProbe> {
	try {
		const res = await healthRequest(port, token);
		return { listening: true, status: res.status };
	} catch {
		return { listening: false, status: 0 };
	}
}

export async function brainHealthy(port: number, token = ""): Promise<boolean> {
	const probe = await brainProbe(port, token);
	return probe.status === 200;
}

export interface SpawnOptions {
	port: number;
	token: string;
	/** Extra environment for the server process (tests override the qmd collection). */
	env?: Record<string, string>;
}

function spawnServer(extDir: string, opts: SpawnOptions): number | null {
	const server = brainServerPath(extDir);
	if (!fs.existsSync(server)) return null;
	const out = openLog(DAEMON);
	const child = spawn(process.execPath, [server], {
		detached: true,
		stdio: ["ignore", out, out],
		env: { ...process.env, ...opts.env, BRAIN_PORT: String(opts.port), BRAIN_TOKEN: opts.token },
	});
	child.unref();
	if (typeof child.pid === "number") {
		recordPid(DAEMON, child.pid);
		return child.pid;
	}
	return null;
}

export interface EnsureResult {
	ok: boolean;
	started: boolean;
	detail: string;
}

/**
 * Start the brain server if nothing is answering on the port.
 *
 * A healthy server started by someone else (systemd, a manual `node brain/server.mjs`)
 * cannot be adopted: its token is whatever its own environment says, so it is
 * reported instead of silently left in place when a token is required.
 */
export async function ensureBrainServer(
	extDir: string,
	opts: SpawnOptions,
	log: (message: string) => void,
): Promise<EnsureResult> {
	if ((await brainProbe(opts.port, opts.token)).status === 200) {
		return { ok: true, started: false, detail: "already running" };
	}
	const anonymous = await brainProbe(opts.port, "");
	if (anonymous.listening) {
		if (anonymous.status === 200) {
			if (opts.token) {
				return {
					ok: false,
					started: false,
					detail: `a brain server is already listening on ${opts.port} without requiring a token; restart it with BRAIN_TOKEN set`,
				};
			}
			return { ok: true, started: false, detail: "already running (no token)" };
		}
		if (anonymous.status === 401) {
			return {
				ok: false,
				started: false,
				detail: `a brain server is already listening on ${opts.port} with a different token; stop it, or set brainToken to match`,
			};
		}
		return { ok: false, started: false, detail: `port ${opts.port} is in use by another service (HTTP ${anonymous.status})` };
	}

	const result = await ensureDaemon({
		name: DAEMON,
		spawn: () => spawnServer(extDir, opts),
		probe: async () => brainHealthy(opts.port, opts.token),
		timeoutMs: 10000,
	});
	if (!result.ok) {
		return { ok: false, started: result.started, detail: `${result.detail}; log: ${brainLogPath()}` };
	}
	if (result.started) log(`brain server started (${result.detail}), log: ${brainLogPath()}`);
	return { ok: true, started: result.started, detail: result.detail };
}

/** Stop a brain server this extension started (identified by its pid file). */
export async function stopBrainServer(): Promise<{ stopped: boolean; detail: string }> {
	return stopDaemon(DAEMON);
}
