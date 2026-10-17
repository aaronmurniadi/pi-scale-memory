import { execFile } from "node:child_process";

export interface RunResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	missing: boolean;
}

export interface RunOptions {
	timeoutMs?: number;
	cwd?: string;
	/** Prefix the command with `sudo -n` (non-interactive; fails fast when a password is required). */
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
			{ timeout: opts.timeoutMs ?? 60000, maxBuffer: 32 * 1024 * 1024, cwd: opts.cwd },
			(err, stdout, stderr) => {
				const { code, missing } = exitCodeOf(err as NodeJS.ErrnoException | null);
				resolve({ ok: code === 0, code, stdout: String(stdout), stderr: String(stderr), missing });
			},
		);
	});
}

export async function has(cmd: string): Promise<boolean> {
	const r = await run("/bin/sh", ["-c", `command -v ${cmd}`], { timeoutMs: 5000 });
	return r.ok && r.stdout.trim().length > 0;
}

/** True when sudo can run without prompting. Credentials cached by a recent `sudo -v` also count. */
export async function sudoAvailable(): Promise<boolean> {
	const r = await run("sudo", ["-n", "true"], { timeoutMs: 5000 });
	return r.ok;
}

export function failed(r: RunResult): string {
	const text = `${r.stderr}\n${r.stdout}`.trim();
	if (r.missing) return "command not found";
	if (!text) return `exited with code ${r.code}`;
	return text.split("\n").slice(-4).join("\n");
}
