/**
 * Which project namespace a pi session belongs to.
 *
 * Identity is the canonical git repository, not the directory: two clones of
 * `github.com/acme/api` on two machines are the same project, and a directory
 * reused for a different repo is not. Resolution is a ladder, first hit wins:
 *
 *   1. an explicit pin (config `namespace`, or PI_SCALE_MEMORY_NAMESPACE)
 *   2. the canonical remote of the preferred remote (default `origin`)
 *   3. a repo with no usable remote -> this machine's copy of it
 *   4. not a repo at all -> this machine's directory (or the legacy namespace)
 *
 * Rungs 3 and 4 include the hostname on purpose. They cannot be shared across
 * machines, and pretending otherwise would silently mix two different directories
 * that happen to have the same path.
 *
 * Everything here is pure apart from `detectGit`, which takes the runner as an
 * argument so the ladder is testable without a repository.
 */
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_NS, isValidNs } from "../brain/memory.mjs";

export interface Remote {
	name: string;
	url: string;
}

export interface GitFacts {
	toplevel: string;
	/** Usually `<root>/.git`; shared by every worktree of one repository. */
	commonDir: string | null;
	remotes: Remote[];
	/** Non-empty when this repo is checked out inside another one as a submodule. */
	superproject: string | null;
}

export type NamespaceSource = "pin" | "remote" | "toplevel" | "path" | "fallback";

export interface NamespaceResolution {
	/** Filesystem-safe id used on the brain. */
	ns: string;
	/** The canonical thing this namespace was derived from, for display and the registry. */
	key: string;
	label: string;
	source: NamespaceSource;
}

/** The subset of src/shell.ts `run` this module needs, injected for tests. */
export type GitRunner = (
	file: string,
	args: string[],
	opts?: { cwd?: string; timeoutMs?: number },
) => Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean; code: number | null }>;

export function sha8(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/**
 * One canonical key for one repository, whatever URL form it arrives in:
 * `https://user:token@github.com/acme/api.git`, `git@github.com:acme/api.git` and
 * `ssh://git@github.com:22/acme/api` are all `github.com/acme/api`.
 *
 * Credentials are dropped before anything is hashed, logged or stored: remote URLs
 * can carry tokens. A local path or a `file://` URL has no host and returns null,
 * which sends resolution to the path rungs.
 */
export function canonicalRemote(url: string): string | null {
	const trimmed = String(url ?? "").trim();
	if (!trimmed) return null;

	let host = "";
	let repoPath = "";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		try {
			const parsed = new URL(trimmed);
			if (parsed.protocol === "file:") return null;
			host = parsed.hostname;
			repoPath = parsed.pathname;
		} catch {
			return null;
		}
	} else {
		// scp-like: [user@]host:path
		const match = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
		if (!match) return null;
		host = match[1];
		repoPath = match[2];
	}

	repoPath = repoPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
	if (!host || !repoPath) return null;
	return `${host.toLowerCase()}/${repoPath.toLowerCase()}`;
}

/** `github.com/acme/api` -> `api-9f3c1a2b`, which is a legal namespace id. */
export function nsIdFromKey(key: string): string {
	const parts = key.split("/").filter(Boolean);
	const slug = (parts[parts.length - 1] ?? "project")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.replace(/-+$/, "")
		.slice(0, 40);
	const base = slug || "project";
	return `${base}-${sha8(key)}`;
}

/**
 * The root of the main worktree. `git rev-parse --git-common-dir` points at
 * `<root>/.git` for a linked worktree as well, so every worktree of one repository
 * resolves to the same local namespace instead of one per checkout.
 */
export function mainWorktreeRoot(toplevel: string, commonDir: string | null): string {
	if (!commonDir) return toplevel;
	const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(toplevel, commonDir);
	if (path.basename(absolute) !== ".git") return toplevel;
	return path.dirname(absolute);
}

/** Preferred remote: the configured one, else `origin`, else a stable alphabetical pick. */
export function pickRemote(remotes: Remote[], preferred?: string | null): Remote | null {
	if (remotes.length === 0) return null;
	if (preferred) {
		const named = remotes.find((r) => r.name === preferred);
		if (named) return named;
	}
	const origin = remotes.find((r) => r.name === "origin");
	if (origin) return origin;
	return [...remotes].sort((a, b) => a.name.localeCompare(b.name))[0];
}

export interface ResolveInput {
	cwd: string;
	git: GitFacts | null;
	hostname: string;
	pin?: string | null;
	preferredRemote?: string | null;
	/** What to do when nothing resolves. Default: derive one from the path. */
	fallback?: "path" | "legacy";
}

export function resolveNamespace(input: ResolveInput): NamespaceResolution {
	const { cwd, git, hostname, pin, preferredRemote, fallback } = input;

	if (pin && pin.trim()) {
		const wanted = pin.trim().toLowerCase();
		if (isValidNs(wanted)) return { ns: wanted, key: `pin/${wanted}`, label: wanted, source: "pin" };
	}

	if (git) {
		const remote = pickRemote(git.remotes, preferredRemote);
		const canonical = remote ? canonicalRemote(remote.url) : null;
		if (canonical) return { ns: nsIdFromKey(canonical), key: canonical, label: canonical, source: "remote" };
	}

	if (git?.toplevel) {
		const root = mainWorktreeRoot(git.toplevel, git.commonDir);
		const name = path.basename(root) || "repo";
		return {
			ns: `local-${sha8(`${hostname}\n${root}`)}`,
			key: `local/${name}`,
			label: `local:${name}`,
			source: "toplevel",
		};
	}

	if (fallback === "legacy") {
		return { ns: DEFAULT_NS, key: DEFAULT_NS, label: `${DEFAULT_NS} (unscoped)`, source: "fallback" };
	}

	const name = path.basename(cwd) || "workspace";
	return {
		ns: `path-${sha8(`${hostname}\n${cwd}`)}`,
		key: `path/${name}`,
		label: `path:${name}`,
		source: "path",
	};
}

/** Read the repository facts once per session. Returns null outside a git worktree. */
export async function detectGit(cwd: string, run: GitRunner): Promise<GitFacts | null> {
	const git = async (args: string[]): Promise<string | null> => {
		const res = await run("git", ["-C", cwd, ...args], { timeoutMs: 5_000 });
		if (!res.ok) return null;
		const out = res.stdout.trim();
		return out || null;
	};

	const toplevel = await git(["rev-parse", "--show-toplevel"]);
	if (!toplevel) return null;

	const [commonDir, remoteText, superproject] = await Promise.all([
		git(["rev-parse", "--git-common-dir"]),
		git(["remote", "-v"]),
		git(["rev-parse", "--show-superproject-working-tree"]),
	]);

	const remotes: Remote[] = [];
	for (const line of (remoteText ?? "").split("\n")) {
		// `origin\thttps://github.com/acme/api.git (fetch)`
		const match = line.match(/^(\S+)\s+(.+?)\s+\(fetch\)$/);
		if (!match) continue;
		if (remotes.some((r) => r.name === match[1])) continue;
		remotes.push({ name: match[1], url: match[2] });
	}

	return { toplevel, commonDir, remotes, superproject };
}

export interface ResolveForCwdOptions {
	pin?: string | null;
	preferredRemote?: string | null;
	fallback?: "path" | "legacy";
	hostname?: string;
}

/** The whole ladder for one working directory. Never throws: a broken repo is rung 4. */
export async function resolveForCwd(
	cwd: string,
	run: GitRunner,
	opts: ResolveForCwdOptions = {},
): Promise<NamespaceResolution> {
	const hostname = opts.hostname ?? (os.hostname().split(".")[0] || "unknown");
	let git: GitFacts | null = null;
	try {
		git = await detectGit(cwd, run);
	} catch {
		git = null;
	}
	return resolveNamespace({
		cwd,
		git,
		hostname,
		pin: opts.pin ?? null,
		preferredRemote: opts.preferredRemote ?? null,
		fallback: opts.fallback ?? "path",
	});
}
