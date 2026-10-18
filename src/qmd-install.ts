/**
 * Installing qmd, the optional semantic-search backend.
 *
 * Only the brain needs it, and it is genuinely optional: without it the brain
 * searches with its built-in BM25.
 *
 * The subtlety is where a global install lands. `npm install -g` writes into the
 * npm global prefix, which on a machine using a node version manager can be a
 * directory that is not on PATH — the install reports success and the binary is
 * still not findable. So a prefix whose bin directory is genuinely on PATH is
 * chosen explicitly, and the result is verified by running qmd afterwards.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "./tailnet.js";

export const QMD_PACKAGE = "@tobilu/qmd";

export interface QmdStatus {
	installed: boolean;
	/** Directory containing the qmd binary, when it resolves. */
	dir: string;
	version: string;
}

export interface Candidate {
	prefix: string;
	binDir: string;
	onPath: boolean;
	writable: boolean;
}

export function resolveBinDir(prefix: string, platform = process.platform): string {
	if (platform === "win32") return prefix;
	return path.join(prefix, "bin");
}

export function pathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = env.PATH ?? env.Path ?? "";
	return raw.split(path.delimiter).filter(Boolean);
}

export function isOnPath(binDir: string, entries: string[]): boolean {
	return entries.includes(binDir);
}

function writableOrCreatable(dir: string): boolean {
	try {
		if (fs.existsSync(dir)) fs.accessSync(dir, fs.constants.W_OK);
		else fs.accessSync(path.dirname(dir), fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** The npm global prefix, or null when npm is not usable. */
export async function npmPrefix(): Promise<string | null> {
	const res = await run("npm", ["prefix", "-g"], { timeoutMs: 30000 });
	if (!res.ok) return null;
	const value = res.stdout.trim();
	if (!value) return null;
	return value;
}

/**
 * Prefixes worth trying, best first: the npm default when its bin is on PATH,
 * then user-level locations that usually are (~/.local, and the node that pi
 * itself ships).
 */
export async function installCandidates(env: NodeJS.ProcessEnv = process.env): Promise<Candidate[]> {
	const entries = pathEntries(env);
	const prefixes: string[] = [];

	const npmDefault = await npmPrefix();
	if (npmDefault) prefixes.push(npmDefault);
	prefixes.push(path.join(os.homedir(), ".local"));

	const nodeDir = path.dirname(process.execPath);
	const piNodePrefix = path.dirname(nodeDir);
	if (path.basename(nodeDir) === "bin") prefixes.push(piNodePrefix);

	const seen = new Set<string>();
	const candidates: Candidate[] = [];
	for (const prefix of prefixes) {
		if (seen.has(prefix)) continue;
		seen.add(prefix);
		const binDir = resolveBinDir(prefix);
		candidates.push({
			prefix,
			binDir,
			onPath: isOnPath(binDir, entries) || isOnPath(prefix, entries),
			writable: writableOrCreatable(binDir),
		});
	}
	return candidates;
}

/** The prefix whose bin directory is on PATH; nothing else is worth installing into. */
export function pickCandidate(candidates: Candidate[]): Candidate | null {
	for (const candidate of candidates) {
		if (candidate.onPath && candidate.writable) return candidate;
	}
	return null;
}

export function installCommand(prefix: string): string[] {
	return ["install", "-g", `--prefix=${prefix}`, QMD_PACKAGE];
}

export async function qmdStatus(): Promise<QmdStatus> {
	const res = await run("qmd", ["--version"], { timeoutMs: 30000 });
	if (res.missing) return { installed: false, dir: "", version: "" };
	const version = `${res.stdout}\n${res.stderr}`.trim().split("\n")[0] ?? "";
	if (!res.ok) return { installed: false, dir: "", version };
	const which = await run("/bin/sh", ["-c", "command -v qmd"], { timeoutMs: 10000 });
	return { installed: true, dir: path.dirname(which.stdout.trim()), version };
}

export interface InstallResult {
	ok: boolean;
	detail: string;
	status?: QmdStatus;
}

/** Run the install, then prove it worked by running qmd. */
export async function installQmd(candidate: Candidate, onProgress?: (message: string) => void): Promise<InstallResult> {
	const args = installCommand(candidate.prefix);
	onProgress?.(`running npm ${args.join(" ")} (this can take a few minutes)`);
	const res = await run("npm", args, { timeoutMs: 900000 });
	if (!res.ok) {
		const detail = `${res.stderr}\n${res.stdout}`.trim().split("\n").slice(-4).join("\n");
		return { ok: false, detail: detail || "npm install failed" };
	}

	const status = await qmdStatus();
	if (!status.installed) {
		return {
			ok: false,
			detail: [
				"npm reported success, but qmd still does not resolve.",
				`It was installed under ${candidate.prefix}; add ${candidate.binDir} to PATH and restart pi.`,
			].join("\n"),
		};
	}
	return { ok: true, detail: `qmd ${status.version} installed at ${status.dir}`, status };
}

export function noCandidateHelp(candidates: Candidate[]): string {
	const lines = [
		"No writable install location is on PATH, so an automatic install would not be usable.",
		"",
		"Prefixes considered:",
	];
	for (const candidate of candidates) {
		let flags = "not on PATH";
		if (candidate.onPath && candidate.writable) flags = "usable";
		else if (candidate.onPath) flags = "not writable";
		lines.push(`  ${candidate.prefix} (${flags})`);
	}
	lines.push(
		"",
		`Install it yourself into a directory on your PATH, e.g.:`,
		`  npm install -g --prefix="${path.join(os.homedir(), ".local")}" ${QMD_PACKAGE}`,
		`  export PATH="${path.join(os.homedir(), ".local", "bin")}:$PATH"`,
	);
	return lines.join("\n");
}
