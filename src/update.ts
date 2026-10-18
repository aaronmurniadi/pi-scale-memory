/**
 * /psm-update — update the extension itself.
 *
 * Two install shapes are supported:
 *   - a git checkout (this repo cloned locally, or pi installed from a local path):
 *     fast-forward pull;
 *   - a pi package (npm or git source listed in the pi settings): `pi update <source>`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { failureText, run } from "./tailnet.js";

export type InstallKind = "git" | "pi-package" | "unknown";

export interface InstallInfo {
	kind: InstallKind;
	dir: string;
	/** git: current short commit. */
	commit?: string;
	/** package.json version. */
	version?: string;
	/** git: uncommitted changes block a fast-forward pull. */
	dirty?: boolean;
	branch?: string;
	/** pi-package: the configured source string. */
	source?: string;
}

export function settingsPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

/** Find a configured package whose source looks like this extension. */
export function findPackageSource(settings: unknown, needle = "pi-scale-memory"): string | null {
	const packages = (settings as { packages?: unknown })?.packages;
	if (!Array.isArray(packages)) return null;
	for (const entry of packages) {
		let source = "";
		if (typeof entry === "string") source = entry;
		else if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") {
			source = (entry as { source: string }).source;
		}
		if (source.toLowerCase().includes(needle)) return source;
	}
	return null;
}

export function readVersion(dir: string): string | undefined {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
		if (typeof pkg.version === "string") return pkg.version;
	} catch {
		/* no package.json */
	}
	return undefined;
}

export async function inspectInstall(extDir: string): Promise<InstallInfo> {
	const info: InstallInfo = { kind: "unknown", dir: extDir, version: readVersion(extDir) };
	if (fs.existsSync(path.join(extDir, ".git"))) {
		info.kind = "git";
		const head = await run("git", ["-C", extDir, "rev-parse", "--short", "HEAD"], { timeoutMs: 15000 });
		if (head.ok) info.commit = head.stdout.trim();
		const branch = await run("git", ["-C", extDir, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 15000 });
		if (branch.ok) info.branch = branch.stdout.trim();
		const status = await run("git", ["-C", extDir, "status", "--porcelain"], { timeoutMs: 15000 });
		if (status.ok) info.dirty = status.stdout.trim().length > 0;
		return info;
	}
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
		const source = findPackageSource(settings);
		if (source) {
			info.kind = "pi-package";
			info.source = source;
		}
	} catch {
		/* settings unreadable */
	}
	return info;
}

export interface UpdateResult {
	ok: boolean;
	message: string;
	before?: string;
	after?: string;
}

export async function runUpdate(info: InstallInfo): Promise<UpdateResult> {
	if (info.kind === "git") {
		if (info.dirty) {
			return {
				ok: false,
				message: "This checkout has uncommitted changes. Commit or stash them, then run the update again.",
			};
		}
		if (info.branch && info.branch !== "HEAD") {
			/* on a normal branch */
		} else {
			return { ok: false, message: "Detached HEAD: check out a branch before updating." };
		}
		const pulled = await run("git", ["-C", info.dir, "pull", "--ff-only"], { timeoutMs: 120000 });
		if (!pulled.ok) return { ok: false, message: `git pull failed:\n${failureText(pulled)}` };
		const head = await run("git", ["-C", info.dir, "rev-parse", "--short", "HEAD"], { timeoutMs: 15000 });
		const after = head.ok ? head.stdout.trim() : undefined;
		const changed = info.commit !== after;
		let message = pulled.stdout.trim();
		if (!message) {
			if (changed) message = `updated ${info.commit ?? "?"} → ${after ?? "?"}`;
			else message = "already up to date";
		}
		return { ok: true, message, before: info.commit, after };
	}

	if (info.kind === "pi-package" && info.source) {
		const which = await run("/bin/sh", ["-c", "command -v pi"], { timeoutMs: 10000 });
		if (!which.ok) {
			return { ok: false, message: `Run this yourself (pi is not on PATH):\n  pi update ${info.source}` };
		}
		const updated = await run("pi", ["update", info.source], { timeoutMs: 300000 });
		if (!updated.ok) return { ok: false, message: `pi update failed:\n${failureText(updated)}` };
		return { ok: true, message: updated.stdout.trim() || `updated ${info.source}`, before: info.version };
	}

	return {
		ok: false,
		message: [
			"This copy is not a git checkout and is not listed as a pi package, so it cannot update itself.",
			"If you installed it from git, reinstall to update:",
			"  pi install git:github.com/aaronmurniadi/pi-scale-memory",
			`Otherwise update the directory by hand: ${info.dir}`,
		].join("\n"),
	};
}
