import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Config {
	/** Empty/undefined = the Tailscale control plane. Otherwise a Headscale (or other) URL. */
	loginServer?: string;
	/** Tagged (tag:agent), reusable pre-auth key. */
	authKey?: string;
	brainPort: number;
	/** Optional bearer token, must match BRAIN_TOKEN on the brain server. */
	brainToken?: string;
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

export function resetConfig(): void {
	fs.rmSync(FILE, { force: true });
}

export const CONFIG_PATH = FILE;
