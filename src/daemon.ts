/**
 * Detached background processes this extension manages (the brain server, the
 * brain's own tailscaled).
 *
 * State lives under the extension config dir: a pid file per daemon plus a log.
 * A daemon started outside this extension (systemd, or by hand) has no pid file
 * and is never killed by us.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "./config.js";
import { waitFor } from "./tailnet.js";

export interface DaemonFiles {
	pid: string;
	log: string;
}

export function daemonFiles(name: string): DaemonFiles {
	const dir = configDir();
	return { pid: path.join(dir, `${name}.pid`), log: path.join(dir, `${name}.log`) };
}

export function readDaemonPid(name: string): number | null {
	try {
		const raw = Number(fs.readFileSync(daemonFiles(name).pid, "utf-8").trim());
		if (Number.isInteger(raw) && raw > 0) return raw;
	} catch {
		/* no pid file */
	}
	return null;
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function daemonRunning(name: string): boolean {
	const pid = readDaemonPid(name);
	if (pid === null) return false;
	return isAlive(pid);
}

export function openLog(name: string): number {
	const files = daemonFiles(name);
	fs.mkdirSync(path.dirname(files.log), { recursive: true });
	return fs.openSync(files.log, "a");
}

export function recordPid(name: string, pid: number): void {
	const files = daemonFiles(name);
	fs.mkdirSync(path.dirname(files.pid), { recursive: true });
	fs.writeFileSync(files.pid, String(pid), { mode: 0o600 });
}

export interface EnsureDaemonOptions {
	name: string;
	/** Start the process; return its pid, or null when it could not start. */
	spawn: () => number | null;
	/** True once the daemon is usable. */
	probe: () => Promise<boolean>;
	timeoutMs?: number;
}

export interface EnsureDaemonResult {
	ok: boolean;
	started: boolean;
	detail: string;
}

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
	if (await opts.probe()) return { ok: true, started: false, detail: "already running" };
	const pid = opts.spawn();
	if (pid === null) return { ok: false, started: false, detail: "could not start" };
	const ready = await waitFor(opts.probe, opts.timeoutMs ?? 10000);
	if (!ready) return { ok: false, started: true, detail: `pid ${pid} did not become ready` };
	return { ok: true, started: true, detail: `started pid ${pid}` };
}

export async function stopDaemon(name: string): Promise<{ stopped: boolean; detail: string }> {
	const pid = readDaemonPid(name);
	const files = daemonFiles(name);
	if (pid === null) return { stopped: false, detail: "not started by this extension" };
	if (!isAlive(pid)) {
		fs.rmSync(files.pid, { force: true });
		return { stopped: false, detail: "not running any more" };
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		/* already gone */
	}
	const dead = await waitFor(async () => !isAlive(pid), 5000);
	if (!dead) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
	fs.rmSync(files.pid, { force: true });
	return { stopped: true, detail: `stopped pid ${pid}` };
}
