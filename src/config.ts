import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Role = "brain" | "agent";

export interface Config {
	/** What this pi agent is: the memory host (brain) or a client (agent). */
	role?: Role;
	/** Tailscale login server override. Empty = the Tailscale control plane. */
	loginServer?: string;
	/** Pre-auth key used to join the tailnet. Tags are not required. */
	authKey?: string;
	brainPort: number;
	/** Optional bearer token, must match BRAIN_TOKEN on the brain server. */
	brainToken?: string;
	/** Agent: pin the brain to this address instead of probing the tailnet for it. */
	brainHost?: string;
	/** Mirror brain memory locally so reads work offline (agents only). Default true. */
	cache?: boolean;
	/** Pin the project namespace instead of deriving it from git. Escape hatch and CI use. */
	namespace?: string;
	/** Which remote is canonical when a repo has several (fork vs upstream). Default: origin. */
	scopeRemote?: string;
	/** Where memory goes when the workspace is not a git repository. Default: a machine-local path namespace. */
	scopeFallback?: "path" | "legacy";
}

const DIR = path.join(os.homedir(), ".pi", "agent", "pi-scale-memory");
const FILE = path.join(DIR, "config.json");

export function loadConfig(applyEnv = true): Config {
	let cfg: Config = { brainPort: 8787 };
	try {
		cfg = { ...cfg, ...JSON.parse(fs.readFileSync(FILE, "utf-8")) };
	} catch {
		/* first run */
	}
	if (!applyEnv) return cfg;
	const env = process.env;
	if (env.PI_SCALE_MEMORY_LOGIN_SERVER) cfg.loginServer = env.PI_SCALE_MEMORY_LOGIN_SERVER;
	if (env.PI_SCALE_MEMORY_AUTHKEY) cfg.authKey = env.PI_SCALE_MEMORY_AUTHKEY;
	if (env.PI_SCALE_MEMORY_PORT) cfg.brainPort = Number(env.PI_SCALE_MEMORY_PORT);
	if (env.PI_SCALE_MEMORY_TOKEN) cfg.brainToken = env.PI_SCALE_MEMORY_TOKEN;
	if (env.PI_SCALE_MEMORY_BRAIN_HOST) cfg.brainHost = env.PI_SCALE_MEMORY_BRAIN_HOST;
	if (env.PI_SCALE_MEMORY_CACHE === "0" || env.PI_SCALE_MEMORY_CACHE === "false") cfg.cache = false;
	if (env.PI_SCALE_MEMORY_NAMESPACE) cfg.namespace = env.PI_SCALE_MEMORY_NAMESPACE;
	if (env.PI_SCALE_MEMORY_SCOPE_REMOTE) cfg.scopeRemote = env.PI_SCALE_MEMORY_SCOPE_REMOTE;
	if (env.PI_SCALE_MEMORY_SCOPE_FALLBACK === "path" || env.PI_SCALE_MEMORY_SCOPE_FALLBACK === "legacy") {
		cfg.scopeFallback = env.PI_SCALE_MEMORY_SCOPE_FALLBACK;
	}
	return cfg;
}

export function saveConfig(cfg: Config): void {
	fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
	fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function updateConfig(patch: Partial<Config>): Config {
	const cfg = { ...loadConfig(false), ...patch };
	saveConfig(cfg);
	return cfg;
}

export function resetConfig(): void {
	fs.rmSync(FILE, { force: true });
}

export const CONFIG_PATH = FILE;
export const CONFIG_DIR = DIR;

/** Resolved at call time so tests can redirect state with PI_SCALE_MEMORY_CONFIG_DIR. */
export function configDir(): string {
	return process.env.PI_SCALE_MEMORY_CONFIG_DIR ?? DIR;
}
