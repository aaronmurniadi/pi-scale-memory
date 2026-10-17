import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Role = "brain" | "agent";

/** Headscale details recorded by /setup-headscale. Brain role only. */
export interface HeadscaleConfig {
	configPath: string;
	policyPath: string;
	policyMode: "file" | "database";
	serverUrl: string;
	/** Headscale user that owns the agent pre-auth keys. */
	user: string;
	layout: "system" | "user";
	installed: boolean;
}

export interface Config {
	/** What this pi agent is: the memory host (brain) or a client (agent). */
	role?: Role;
	/** Empty/undefined = the Tailscale control plane. Otherwise a Headscale (or other) URL. */
	loginServer?: string;
	/** Tagged (tag:agent) pre-auth key. */
	authKey?: string;
	brainPort: number;
	/** Optional bearer token, must match BRAIN_TOKEN on the brain server. */
	brainToken?: string;
	headscale?: HeadscaleConfig;
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
