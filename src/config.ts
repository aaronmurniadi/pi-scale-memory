import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Role = "brain" | "agent";

export interface Config {
	/** What this pi agent is: the memory host (brain) or a client (agent). */
	role?: Role;
	/** Tailscale login server override. Empty = the Tailscale control plane. */
	loginServer?: string;
	/** Tagged (tag:agent) pre-auth key used to join the tailnet. */
	authKey?: string;
	brainPort: number;
	/** Optional bearer token, must match BRAIN_TOKEN on the brain server. */
	brainToken?: string;
	/** Mirror brain memory locally so reads work offline (agents only). Default true. */
	cache?: boolean;
	/** Tailscale API access token (tskey-api-...) used by /generate-preauth. */
	tailscaleApiToken?: string;
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
	if (env.PI_SCALE_MEMORY_TAILSCALE_API_TOKEN) cfg.tailscaleApiToken = env.PI_SCALE_MEMORY_TAILSCALE_API_TOKEN;
	if (env.PI_SCALE_MEMORY_CACHE === "0" || env.PI_SCALE_MEMORY_CACHE === "false") cfg.cache = false;
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
