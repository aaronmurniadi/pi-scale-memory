import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { failed, has, run, sudoAvailable, type RunResult } from "./shell.js";
import type { Ui } from "./ui.js";

const RELEASE_BASE = "https://github.com/juanfont/headscale/releases/download";
const RELEASES_API = "https://api.github.com/repos/juanfont/headscale/releases/latest";
/** Config keys (prefixes.v4/v6, policy.mode) were introduced in this series. */
export const MIN_VERSION = "0.26";

export type HsLayout = "system" | "user";

export interface HsPaths {
	layout: HsLayout;
	dir: string;
	configPath: string;
	policyPath: string;
	noiseKeyPath: string;
	socket: string;
	dataDir: string;
	/** Owner of the files/process for the system layout (deb package user). */
	owner?: string;
}

export interface HsUser {
	id: string;
	name: string;
}

export interface ReleaseInfo {
	version: string;
	assets: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/unit.ts)
// ---------------------------------------------------------------------------

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x > y) return 1;
		if (x < y) return -1;
	}
	return 0;
}

export function parseVersion(output: string): string | null {
	const m = output.match(/v?(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return `${m[1]}.${m[2]}.${m[3]}`;
}

export function assetArch(): string | null {
	if (process.arch === "x64") return "amd64";
	if (process.arch === "arm64") return "arm64";
	return null;
}

export function checksumFor(checksums: string, assetName: string): string | null {
	for (const line of checksums.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2) continue;
		const file = parts[parts.length - 1].replace(/^\*/, "");
		if (path.basename(file) === assetName) return parts[0].toLowerCase();
	}
	return null;
}

export function parseUsers(raw: string): HsUser[] {
	const users: HsUser[] = [];
	const push = (id: unknown, name: unknown) => {
		if (name === undefined || name === null) return;
		users.push({ id: String(id ?? ""), name: String(name) });
	};
	const trimmed = raw.trim();
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			let list: any[] = parsed.users;
			if (Array.isArray(parsed)) list = parsed;
			if (!Array.isArray(list)) list = [];
			for (const entry of list) {
				const id = entry.id ?? entry.ID;
				const name = entry.name ?? entry.Name ?? entry.email ?? entry.Email;
				push(id, name);
			}
			return users;
		} catch {
			/* fall through to table parsing */
		}
	}
	// Human-readable table: ID | Name | Email | ...
	for (const line of trimmed.split("\n")) {
		const cols = line.split("|").map((c) => c.trim());
		if (cols.length < 2) continue;
		if (!/^\d+$/.test(cols[0])) continue;
		push(cols[0], cols[1]);
	}
	return users;
}

export function parsePreauthKey(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			let entry = parsed;
			if (Array.isArray(parsed)) entry = parsed[0];
			if (entry && typeof entry === "object") {
				const key = entry.key ?? entry.Key;
				if (key) return String(key);
			}
		} catch {
			/* fall through to regex */
		}
	}
	const modern = trimmed.match(/hskey-auth-[A-Za-z0-9_-]+/);
	if (modern) return modern[0];
	const legacy = trimmed.match(/\b[0-9a-f]{48,}\b/);
	if (legacy) return legacy[0];
	return null;
}

/** huJSON policy: any Headscale user may tag nodes, agents may only reach the brain API. */
export function renderPolicy(users: HsUser[], brainPort: number): string {
	const members = users.map((u) => `"${u.name}@"`);
	const lines = [
		"{",
		"  // Every Headscale user allowed to run agents. Add users here (or re-run",
		"  // /generate-preauth, which rewrites this file from the live user list).",
		'  "groups": {',
		`    "group:agents": [${members.join(", ")}]`,
		"  },",
		"",
		"  // Who may apply the tags (pre-auth keys and --advertise-tags).",
		"  // tagOwners accepts only users, groups and tags: no wildcard, no autogroup.",
		'  "tagOwners": {',
		'    "tag:agent": ["group:agents"],',
		'    "tag:brain": ["group:agents"]',
		"  },",
		"",
		'  "acls": [',
		"    // Agents may only reach the brain memory API, nothing else.",
		"    {",
		'      "action": "accept",',
		'      "src": ["tag:agent"],',
		`      "dst": ["tag:brain:${brainPort}"]`,
		"    }",
		"  ]",
		"}",
		"",
	];
	return lines.join("\n");
}

export function renderConfig(paths: HsPaths, serverUrl: string, policyMode: string): string {
	const port = new URL(serverUrl).port;
	let listenPort = "8080";
	if (port) listenPort = port;
	return [
		"# Generated by pi-scale-memory.",
		`server_url: ${serverUrl}`,
		`listen_addr: 0.0.0.0:${listenPort}`,
		"metrics_listen_addr: 127.0.0.1:9090",
		"grpc_listen_addr: 127.0.0.1:50443",
		"grpc_allow_insecure: false",
		"noise:",
		`  private_key_path: ${paths.noiseKeyPath}`,
		"prefixes:",
		"  v4: 100.64.0.0/10",
		"  v6: fd7a:115c:a1e0::/48",
		"  allocation: sequential",
		"database:",
		"  type: sqlite",
		"  sqlite:",
		`    path: ${paths.dataDir}/db.sqlite`,
		"policy:",
		`  mode: ${policyMode}`,
		`  path: ${paths.policyPath}`,
		"dns:",
		"  magic_dns: false",
		"  base_domain: pi-scale-memory.internal",
		"log:",
		"  level: info",
		"  format: text",
		"derp:",
		"  server:",
		"    enabled: false",
		"  urls:",
		"    - https://controlplane.tailscale.com/derpmap/default",
		"  auto_update_enabled: true",
		"  update_frequency: 24h",
		`unix_socket: ${paths.socket}`,
		"",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Paths and detection
// ---------------------------------------------------------------------------

export function userPaths(): HsPaths {
	const dir = process.env.PI_SCALE_MEMORY_HEADSCALE_DIR ?? path.join(os.homedir(), ".config", "headscale");
	const dataDir = path.join(os.homedir(), ".local", "share", "headscale");
	return {
		layout: "user",
		dir,
		dataDir,
		configPath: path.join(dir, "config.yaml"),
		policyPath: path.join(dir, "acl.hujson"),
		noiseKeyPath: path.join(dir, "noise_private.key"),
		socket: path.join(dir, "headscale.sock"),
	};
}

export function systemPaths(): HsPaths {
	const dir = "/etc/headscale";
	const dataDir = "/var/lib/headscale";
	return {
		layout: "system",
		dir,
		dataDir,
		configPath: path.join(dir, "config.yaml"),
		policyPath: path.join(dir, "acl.hujson"),
		noiseKeyPath: path.join(dir, "noise_private.key"),
		socket: "/var/run/headscale/headscale.sock",
		owner: "headscale",
	};
}

export function choosePaths(): HsPaths {
	if (process.env.PI_SCALE_MEMORY_HEADSCALE_DIR) return userPaths();
	if (process.platform === "linux" && fs.existsSync("/etc/headscale")) return systemPaths();
	return userPaths();
}

export async function headscaleVersion(): Promise<string | null> {
	const r = await run("headscale", ["version"], { timeoutMs: 10000 });
	if (r.missing) return null;
	const parsed = parseVersion(`${r.stdout}\n${r.stderr}`);
	if (parsed) return parsed;
	if (r.ok) return "unknown";
	return null;
}

// ---------------------------------------------------------------------------
// HTTP downloads (no external dependencies)
// ---------------------------------------------------------------------------

function httpGet(url: string, redirectsLeft = 5): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const onResponse = (res: http.IncomingMessage) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				if (redirectsLeft <= 0) {
					reject(new Error(`too many redirects for ${url}`));
					return;
				}
				httpGet(new URL(res.headers.location, url).toString(), redirectsLeft - 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				res.resume();
				reject(new Error(`GET ${url} returned ${status}`));
				return;
			}
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve(Buffer.concat(chunks)));
		};
		const options = { headers: { "user-agent": "pi-scale-memory", accept: "application/octet-stream, application/json" } };
		let req: http.ClientRequest;
		if (url.startsWith("https:")) req = https.get(url, options, onResponse);
		else req = http.get(url, options, onResponse);
		req.on("error", reject);
		req.setTimeout(120000, () => req.destroy(new Error(`GET ${url} timed out`)));
	});
}

async function downloadTo(url: string, dest: string): Promise<void> {
	const body = await httpGet(url);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, body, { mode: 0o755 });
}

export async function latestRelease(): Promise<ReleaseInfo> {
	const body = await httpGet(RELEASES_API);
	const parsed = JSON.parse(body.toString("utf-8"));
	const tag = String(parsed.tag_name ?? "");
	const version = tag.replace(/^v/, "");
	const assets: string[] = (parsed.assets ?? []).map((a: { name: string }) => String(a.name));
	if (!version) throw new Error("could not read the latest headscale release version");
	return { version, assets };
}

async function verifyChecksum(file: string, version: string): Promise<string> {
	const name = path.basename(file);
	const text = (await httpGet(`${RELEASE_BASE}/v${version}/checksums.txt`)).toString("utf-8");
	const expected = checksumFor(text, name);
	if (!expected) throw new Error(`no checksum published for ${name}`);
	const actual = await new Promise<string>((resolve, reject) => {
		run("/usr/bin/shasum", ["-a", "256", file], { timeoutMs: 120000 }).then((r) => {
			if (r.missing) {
				run("sha256sum", [file], { timeoutMs: 120000 }).then((r2) => {
					if (!r2.ok) reject(new Error(failed(r2)));
					else resolve((r2.stdout.trim().split(/\s+/)[0] ?? "").toLowerCase());
				});
				return;
			}
			if (!r.ok) reject(new Error(failed(r)));
			else resolve((r.stdout.trim().split(/\s+/)[0] ?? "").toLowerCase());
		}, reject);
	});
	if (actual !== expected) throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
	return actual;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export type InstallMethod = "deb" | "binary";

export async function detectInstallMethod(): Promise<InstallMethod> {
	if (process.platform !== "linux") return "binary";
	const isDebian = fs.existsSync("/etc/debian_version");
	if (isDebian && (await has("apt-get"))) return "deb";
	return "binary";
}

/**
 * Install Headscale from official GitHub release artifacts. There is no Homebrew
 * formula for headscale, so macOS uses the release binary like other non-Debian hosts.
 * Returns the install directory that must be on PATH, or null when nothing was installed.
 */
export async function installHeadscale(ui: Ui, method: InstallMethod): Promise<string | null> {
	const release = await latestRelease();
	const version = release.version;
	const arch = assetArch();
	if (!arch) {
		ui.notify(`Unsupported CPU architecture: ${process.arch}. Install headscale manually.`, "error");
		return null;
	}
	if (process.platform === "win32") {
		ui.notify("Windows is not supported by this setup. Install headscale manually.", "error");
		return null;
	}

	let osName = "linux";
	if (process.platform === "darwin") osName = "darwin";
	let useSudo = needsSystemBin();
	if (method === "deb") useSudo = true;

	if (method === "deb") {
		const asset = `headscale_${version}_${osName}_${arch}.deb`;
		const tmp = path.join(os.tmpdir(), asset);
		const cmds = [
			`curl -fsSL -o ${tmp} ${RELEASE_BASE}/v${version}/${asset}`,
			`sudo apt install -y ${tmp}`,
		];
		if (!(await ui.confirm(`Install headscale ${version} (Debian package)?`, cmds.join("\n")))) return null;
		if (!(await sudoAvailable())) {
			ui.notify(
				"sudo needs a password in this terminal. Run these, then re-run /setup-headscale:\n" + cmds.join("\n"),
				"warning",
			);
			return null;
		}
		try {
			await downloadTo(`${RELEASE_BASE}/v${version}/${asset}`, tmp);
			await verifyChecksum(tmp, version);
		} catch (err) {
			ui.notify(`Download failed: ${errText(err)}`, "error");
			return null;
		}
		const r = await run("apt-get", ["install", "-y", tmp], { sudo: true, timeoutMs: 600000 });
		if (!r.ok) {
			ui.notify(`apt install failed: ${failed(r)}`, "error");
			return null;
		}
		return "/usr/bin";
	}

	const asset = `headscale_${version}_${osName}_${arch}`;
	let binDir = path.join(os.homedir(), ".local", "bin");
	if (useSudo) binDir = "/usr/local/bin";
	const dest = path.join(binDir, "headscale");
	const cmds = [`curl -fsSL -o ${dest} ${RELEASE_BASE}/v${version}/${asset}`, `chmod +x ${dest}`];
	if (!(await ui.confirm(`Install headscale ${version} binary to ${dest}?`, cmds.join("\n")))) return null;
	if (useSudo && !(await sudoAvailable())) {
		ui.notify(
			"sudo needs a password in this terminal. Run these, then re-run /setup-headscale:\n" + cmds.join("\n"),
			"warning",
		);
		return null;
	}

	const tmp = path.join(os.tmpdir(), asset);
	try {
		await downloadTo(`${RELEASE_BASE}/v${version}/${asset}`, tmp);
		await verifyChecksum(tmp, version);
	} catch (err) {
		ui.notify(`Download failed: ${errText(err)}`, "error");
		return null;
	}
	if (useSudo) {
		const r = await run("install", ["-m", "0755", tmp, dest], { sudo: true, timeoutMs: 60000 });
		if (!r.ok) {
			ui.notify(`install failed: ${failed(r)}`, "error");
			return null;
		}
	} else {
		fs.mkdirSync(binDir, { recursive: true });
		fs.copyFileSync(tmp, dest);
		fs.chmodSync(dest, 0o755);
	}
	return binDir;
}

function needsSystemBin(): boolean {
	return process.platform === "linux" && fs.existsSync("/usr/local/bin");
}

function errText(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

// ---------------------------------------------------------------------------
// Config, service, policy
// ---------------------------------------------------------------------------

async function ensureDir(dir: string, sudo: boolean): Promise<void> {
	if (sudo) {
		await run("mkdir", ["-p", dir], { sudo: true });
		return;
	}
	fs.mkdirSync(dir, { recursive: true });
}

export async function writeFileElevated(
	file: string,
	content: string,
	mode: number,
	opts: { sudo: boolean; owner?: string },
): Promise<void> {
	if (!opts.sudo) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content, { mode });
		return;
	}
	const tmp = path.join(os.tmpdir(), `psm-${path.basename(file)}`);
	fs.writeFileSync(tmp, content, { mode: 0o600 });
	await ensureDir(path.dirname(file), true);
	const octal = mode.toString(8).padStart(4, "0");
	const args = ["-m", octal];
	if (opts.owner) args.push("-o", opts.owner, "-g", opts.owner);
	args.push(tmp, file);
	const r = await run("install", args, { sudo: true });
	if (!r.ok) throw new Error(`could not write ${file}: ${failed(r)}`);
	fs.rmSync(tmp, { force: true });
}

export async function generateNoiseKey(): Promise<string> {
	const r = await run("headscale", ["generate", "private-key"], { timeoutMs: 20000 });
	if (!r.ok) throw new Error(`headscale generate private-key failed: ${failed(r)}`);
	const raw = r.stdout.trim();
	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed.private_key) return String(parsed.private_key);
		} catch {
			/* fall through to token parsing */
		}
	}
	const token = raw.split(/\s+/).pop() ?? "";
	if (!token) throw new Error("headscale generate private-key produced no output");
	return token;
}

export async function configTest(paths: HsPaths): Promise<RunResult> {
	return run("headscale", ["configtest", "-c", paths.configPath], { timeoutMs: 30000 });
}

export function hasSystemdUnit(): boolean {
	if (process.platform !== "linux") return false;
	return (
		fs.existsSync("/lib/systemd/system/headscale.service") ||
		fs.existsSync("/usr/lib/systemd/system/headscale.service") ||
		fs.existsSync("/etc/systemd/system/headscale.service")
	);
}

export async function startService(paths: HsPaths): Promise<{ ok: boolean; detail: string }> {
	if (paths.layout === "system" && hasSystemdUnit()) {
		const r = await run("systemctl", ["enable", "--now", "headscale"], { sudo: true, timeoutMs: 120000 });
		if (!r.ok) return { ok: false, detail: `systemctl failed: ${failed(r)}` };
		const waited = await waitFor(
			async () => {
				const s = await run("systemctl", ["is-active", "headscale"], { timeoutMs: 10000 });
				return s.stdout.trim() === "active";
			},
			30000,
		);
		if (!waited) return { ok: false, detail: "headscale.service did not become active" };
		return { ok: true, detail: "systemd: headscale.service active" };
	}

	const running = await waitFor(async () => fs.existsSync(paths.socket), 1500);
	if (running) return { ok: true, detail: "already running" };

	fs.mkdirSync(paths.dir, { recursive: true });
	const logPath = path.join(paths.dir, "headscale.log");
	const out = fs.openSync(logPath, "a");
	const child = spawn("headscale", ["serve", "-c", paths.configPath], { detached: true, stdio: ["ignore", out, out] });
	child.unref();
	const up = await waitFor(async () => fs.existsSync(paths.socket), 30000);
	if (!up) return { ok: false, detail: `headscale did not start; see ${logPath}` };
	return { ok: true, detail: `background process (log: ${logPath})` };
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return true;
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 500));
	}
}

// ---------------------------------------------------------------------------
// CLI client
// ---------------------------------------------------------------------------

export async function hs(paths: HsPaths, args: string[], timeoutMs = 30000): Promise<RunResult> {
	const full = ["-c", paths.configPath, ...args];
	const r = await run("headscale", full, { timeoutMs });
	if (r.ok) return r;
	const permissionIssue = /permission denied|dial unix|no such file or directory|connection refused/i.test(r.stderr);
	if (!permissionIssue) return r;
	if (!(await sudoAvailable())) return r;
	return run("headscale", full, { sudo: true, timeoutMs });
}

export async function listUsers(paths: HsPaths): Promise<HsUser[]> {
	const r = await hs(paths, ["users", "list", "-o", "json"]);
	if (!r.ok) throw new Error(`headscale users list failed: ${failed(r)}`);
	return parseUsers(r.stdout);
}

export async function createUser(paths: HsPaths, name: string): Promise<void> {
	const users = await listUsers(paths);
	if (users.some((u) => u.name === name)) return;
	const r = await hs(paths, ["users", "create", name]);
	if (!r.ok) throw new Error(`headscale users create failed: ${failed(r)}`);
}

export async function createPreauthKey(
	paths: HsPaths,
	opts: { user: HsUser; tags: string[]; reusable: boolean; ephemeral: boolean; expiration: string },
): Promise<string> {
	const args = ["preauthkeys", "create", "--user", opts.user.id, "--expiration", opts.expiration, "-o", "json"];
	if (opts.reusable) args.push("--reusable");
	if (opts.ephemeral) args.push("--ephemeral");
	for (const tag of opts.tags) args.push("--tags", tag);
	const r = await hs(paths, args);
	if (!r.ok) throw new Error(`headscale preauthkeys create failed: ${failed(r)}`);
	const key = parsePreauthKey(r.stdout);
	if (!key) throw new Error(`could not read the pre-auth key from: ${r.stdout.trim()}`);
	return key;
}

export async function policyCheck(paths: HsPaths): Promise<void> {
	const r = await hs(paths, ["policy", "check", "--file", paths.policyPath]);
	if (!r.ok) {
		const detail = `${r.stderr}\n${r.stdout}`.trim();
		if (/unknown command/i.test(detail)) return;
		throw new Error(`policy check failed: ${detail.split("\n").slice(-4).join("\n")}`);
	}
}

export async function applyPolicy(paths: HsPaths, mode: string): Promise<string> {
	if (mode === "database") {
		const r = await hs(paths, ["policy", "set", "--file", paths.policyPath]);
		if (!r.ok) throw new Error(`headscale policy set failed: ${failed(r)}`);
		return "policy stored in the database";
	}
	if (paths.layout === "system" && hasSystemdUnit()) {
		const r = await run("systemctl", ["reload", "headscale"], { sudo: true, timeoutMs: 30000 });
		if (r.ok) return "systemctl reload headscale";
	}
	const r = await run("/bin/sh", ["-c", "pkill -HUP -x headscale"], { timeoutMs: 10000, sudo: paths.layout === "system" });
	if (r.ok) return "SIGHUP to headscale";
	return "policy file written; restart headscale to apply it";
}
