import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type HeadscaleConfig, loadConfig, saveConfig } from "./config.js";
import * as hs from "./headscale.js";
import { failed, has, run, sudoAvailable } from "./shell.js";
import type { Ui } from "./ui.js";

const TAG_AGENT = "tag:agent";
const TAG_BRAIN = "tag:brain";

function errText(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function isPrivateV4(ip: string): boolean {
	if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("127.")) return true;
	const m = ip.match(/^172\.(\d+)\./);
	if (m) {
		const second = Number(m[1]);
		if (second >= 16 && second <= 31) return true;
	}
	return false;
}

/** First non-internal IPv4, used to guess a reachable server_url. */
export function guessServerUrl(port = "8080"): string {
	const all = os.networkInterfaces();
	for (const name of Object.keys(all)) {
		for (const addr of all[name] ?? []) {
			if (addr.family !== "IPv4") continue;
			if (addr.internal) continue;
			return `http://${addr.address}:${port}`;
		}
	}
	return `http://127.0.0.1:${port}`;
}

export function joinCommand(serverUrl: string, authKey: string): string {
	return `tailscale up --login-server ${serverUrl} --auth-key ${authKey}`;
}

/** Read policy.mode from an existing config so we do not fight an operator's setup. */
export function readPolicyMode(configPath: string): "file" | "database" {
	let text = "";
	try {
		text = fs.readFileSync(configPath, "utf-8");
	} catch {
		return "file";
	}
	let inPolicy = false;
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (/^policy:\s*$/.test(line)) {
			inPolicy = true;
			continue;
		}
		if (!inPolicy) continue;
		if (/^\S/.test(line)) break;
		const m = line.match(/^\s+mode:\s*(\S+)/);
		if (!m) continue;
		const value = m[1].trim().replace(/^["']|["']$/g, "");
		if (value === "database" || value === "db") return "database";
		return "file";
	}
	return "file";
}

async function ensureHeadscaleInstalled(ui: Ui): Promise<boolean> {
	let version = await hs.headscaleVersion();
	if (version) return true;

	const method = await hs.detectInstallMethod();
	let noun = "the release binary";
	if (method === "deb") noun = "the Debian package";
	ui.notify(`headscale is not installed. Setting up ${noun} from GitHub releases.`, "info");
	const dir = await hs.installHeadscale(ui, method);
	if (!dir) return false;

	const onPath = (process.env.PATH ?? "").split(path.delimiter).includes(dir);
	version = await hs.headscaleVersion();
	if (version) return true;
	if (!onPath) {
		ui.notify(
			`headscale was installed to ${dir}, which is not on PATH. Add it (export PATH="${dir}:$PATH") and re-run /setup-headscale.`,
			"error",
		);
		return false;
	}
	ui.notify("headscale was installed but is not runnable. Check the install output.", "error");
	return false;
}

interface Prepared {
	paths: hs.HsPaths;
	serverUrl: string;
	policyMode: "file" | "database";
}

/** Config paths, server_url, noise key, config file, service. Returns null when the user backed out. */
async function prepareHeadscale(ui: Ui, brainPort: number): Promise<Prepared | null> {
	const paths = hs.choosePaths();
	ui.notify(`Headscale layout: ${paths.layout} (${paths.dir})`, "info");

	const guess = guessServerUrl();
	const answer = await ui.input("URL agents will use to reach this headscale", guess);
	if (!answer?.trim()) return null;
	let serverUrl = answer.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//.test(serverUrl)) {
		ui.notify("The URL must start with http:// or https://", "error");
		return null;
	}
	try {
		new URL(serverUrl);
	} catch {
		ui.notify(`Not a valid URL: ${serverUrl}`, "error");
		return null;
	}
	const host = new URL(serverUrl).hostname;
	if (serverUrl.startsWith("http://") && !isPrivateV4(host) && host !== "localhost") {
		ui.notify(
			"Warning: plain http on a non-private address. Pre-auth keys and node keys cross the network unencrypted; use https or a private network.",
			"warning",
		);
	}

	const policyMode = readPolicyMode(paths.configPath);
	const sudo = paths.layout === "system";
	if (sudo && !(await sudoAvailable())) {
		ui.notify(
			`Writing to ${paths.dir} needs sudo without a password prompt. Run \`sudo -v\` in a terminal, then re-run /setup-headscale.`,
			"warning",
		);
		return null;
	}

	try {
		if (!sudo) fs.mkdirSync(paths.dir, { recursive: true });
		if (!sudo) fs.mkdirSync(paths.dataDir, { recursive: true });

		let noiseKey = "";
		if (fs.existsSync(paths.noiseKeyPath)) {
			noiseKey = fs.readFileSync(paths.noiseKeyPath, "utf-8").trim();
		}
		if (!noiseKey) {
			ui.progress?.("headscale: generating the server key…");
			noiseKey = await hs.generateNoiseKey();
			await hs.writeFileElevated(paths.noiseKeyPath, `${noiseKey}\n`, 0o600, { sudo, owner: paths.owner });
		}

		if (fs.existsSync(paths.configPath)) {
			const backup = `${paths.configPath}.bak-${Date.now()}`;
			fs.copyFileSync(paths.configPath, backup);
			ui.notify(`Existing config backed up to ${backup}`, "info");
		}
		await hs.writeFileElevated(paths.configPath, hs.renderConfig(paths, serverUrl, policyMode), 0o644, {
			sudo,
			owner: paths.owner,
		});

		ui.progress?.("headscale: validating config…");
		const test = await hs.configTest(paths);
		const testOut = `${test.stderr}\n${test.stdout}`;
		if (!test.ok && !/unknown command/i.test(testOut)) {
			ui.notify(`Config rejected by headscale:\n${testOut.trim().split("\n").slice(-6).join("\n")}`, "error");
			return null;
		}

		ui.progress?.("headscale: starting the service…");
		const started = await hs.startService(paths);
		if (!started.ok) {
			ui.notify(`Could not start headscale: ${started.detail}`, "error");
			return null;
		}
		ui.notify(`Headscale running (${started.detail})`, "info");
	} catch (err) {
		ui.notify(`Headscale setup failed: ${errText(err)}`, "error");
		return null;
	}

	return { paths, serverUrl, policyMode };
}

/** Rewrite the ACL from the live user list and apply it. Keeps "any user" true over time. */
async function refreshPolicy(ui: Ui, prep: Prepared, brainPort: number): Promise<hs.HsUser[]> {
	const users = await hs.listUsers(prep.paths);
	const policy = hs.renderPolicy(users, brainPort);
	await hs.writeFileElevated(prep.paths.policyPath, policy, 0o644, {
		sudo: prep.paths.layout === "system",
		owner: prep.paths.owner,
	});
	await hs.policyCheck(prep.paths);
	const how = await hs.applyPolicy(prep.paths, prep.policyMode);
	ui.notify(`ACL policy updated for ${users.length} user(s) via ${how}`, "info");
	return users;
}

function toConfig(prep: Prepared, user: string, installed: boolean): HeadscaleConfig {
	return {
		configPath: prep.paths.configPath,
		policyPath: prep.paths.policyPath,
		policyMode: prep.policyMode,
		serverUrl: prep.serverUrl,
		user,
		layout: prep.paths.layout,
		installed,
	};
}

export async function runHeadscaleSetup(ui: Ui, brainPort: number): Promise<void> {
	const version = await hs.headscaleVersion();
	if (version) {
		if (hs.compareVersions(version, hs.MIN_VERSION) < 0) {
			ui.notify(
				`headscale ${version} is older than ${hs.MIN_VERSION}. This setup writes the newer config keys (prefixes, policy.mode). Upgrade headscale first.`,
				"error",
			);
			return;
		}
		ui.notify(`headscale ${version} already installed`, "info");
	} else {
		if (!(await ensureHeadscaleInstalled(ui))) return;
	}

	const prep = await prepareHeadscale(ui, brainPort);
	if (!prep) return;

	const defaultUser = os.userInfo().username.replace(/[^a-zA-Z0-9._@-]/g, "");
	const answer = await ui.input("Headscale user that will own agent pre-auth keys", defaultUser);
	if (!answer?.trim()) return;
	const userName = answer.trim();

	try {
		ui.progress?.("headscale: creating the user…");
		await hs.createUser(prep.paths, userName);
		await refreshPolicy(ui, prep, brainPort);
	} catch (err) {
		ui.notify(`Headscale user/policy step failed: ${errText(err)}`, "error");
		return;
	}

	const hscfg = toConfig(prep, userName, true);
	const cfg = loadConfig(false);
	cfg.role = "brain";
	cfg.loginServer = prep.serverUrl;
	cfg.headscale = hscfg;
	saveConfig(cfg);

	ui.notify("Headscale is ready. Next: join this machine as tag:brain, then /generate-preauth.", "info");
	await joinBrain(ui, prep.paths, prep.serverUrl, hscfg);
}

/** Create a brain pre-auth key and (optionally) join this machine with the system tailscale. */
async function joinBrain(ui: Ui, paths: hs.HsPaths, serverUrl: string, hscfg: HeadscaleConfig): Promise<void> {
	let users: hs.HsUser[];
	try {
		users = await hs.listUsers(paths);
	} catch (err) {
		ui.notify(`Could not list headscale users: ${errText(err)}`, "error");
		return;
	}
	const owner = users.find((u) => u.name === hscfg.user);
	if (!owner) {
		ui.notify(`Headscale user ${hscfg.user} disappeared; re-run /setup-headscale.`, "error");
		return;
	}

	let key = "";
	try {
		key = await hs.createPreauthKey(paths, {
			user: owner,
			tags: [TAG_BRAIN],
			reusable: false,
			ephemeral: false,
			expiration: "1h",
		});
	} catch (err) {
		ui.notify(`Could not create the tag:brain key: ${errText(err)}`, "error");
		return;
	}

	const cmd = joinCommand(serverUrl, key);
	if (!(await has("tailscale"))) {
		ui.notify(`tailscale is not installed here. Run this on the brain machine:\n${cmd}`, "warning");
		return;
	}
	if (!(await ui.confirm("Join this machine to the tailnet as tag:brain now?", cmd))) {
		ui.notify(`Skipped. Run later:\n${cmd}`, "info");
		return;
	}

	ui.progress?.("tailscale: joining as tag:brain…");
	let r = await run("tailscale", ["up", `--login-server=${serverUrl}`, `--auth-key=${key}`], { timeoutMs: 120000 });
	if (!r.ok && /permission denied|must be root|access denied/i.test(r.stderr)) {
		r = await run("tailscale", ["up", `--login-server=${serverUrl}`, `--auth-key=${key}`], {
			sudo: true,
			timeoutMs: 120000,
		});
	}
	if (!r.ok) {
		ui.notify(`tailscale up failed:\n${failed(r)}\n\nRetry manually:\n${cmd}`, "error");
		return;
	}
	ui.notify("This machine is now tagged tag:brain.", "info");
}

/** /generate-preauth: tag:agent key for other machines. */
export async function generateAgentKey(ui: Ui, brainPort: number): Promise<void> {
	const cfg = loadConfig(false);
	if (!cfg.headscale) {
		ui.notify("No headscale setup recorded. Run /setup-headscale first.", "error");
		return;
	}
	const paths = pathForConfig(cfg.headscale);
	const prep: Prepared = { paths, serverUrl: cfg.headscale.serverUrl, policyMode: cfg.headscale.policyMode };

	const expiration = await ui.input("Key expiry (e.g. 90d, 24h)", "90d");
	if (!expiration?.trim()) return;

	const scope = await ui.select("Key scope", [
		"Reusable + ephemeral (recommended: one key for many agents)",
		"Single-use (one machine, then expired)",
	]);
	if (!scope) return;
	let reusable = true;
	let ephemeral = true;
	if (scope.startsWith("Single-use")) {
		reusable = false;
		ephemeral = false;
	}

	let users: hs.HsUser[];
	try {
		users = await refreshPolicy(ui, prep, brainPort);
	} catch (err) {
		ui.notify(`Could not refresh the ACL policy: ${errText(err)}`, "error");
		return;
	}
	const owner = users.find((u) => u.name === cfg.headscale?.user);
	if (!owner) {
		ui.notify(`Headscale user ${cfg.headscale.user} not found. Run /setup-headscale again.`, "error");
		return;
	}

	let key = "";
	try {
		key = await hs.createPreauthKey(paths, {
			user: owner,
			tags: [TAG_AGENT],
			reusable,
			ephemeral,
			expiration: expiration.trim(),
		});
	} catch (err) {
		ui.notify(`Could not create the tag:agent key: ${errText(err)}`, "error");
		return;
	}

	ui.notify(
		[
			"Pre-auth key for agents (tag:agent):",
			"",
			key,
			"",
			`Expires in ${expiration.trim()}; reusable=${reusable}, ephemeral=${ephemeral}.`,
			`Agents join with: /join-tailnet (server URL ${prep.serverUrl}, then paste this key).`,
		].join("\n"),
		"info",
	);
}

function pathForConfig(hscfg: HeadscaleConfig): hs.HsPaths {
	if (hscfg.layout === "system") return hs.systemPaths();
	return hs.userPaths();
}
