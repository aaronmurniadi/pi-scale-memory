/**
 * /setup-funnel — make the brain reachable, and publish it through Tailscale Funnel.
 *
 * Funnel is a hard requirement for the brain: it is what gives the memory API a
 * stable public HTTPS URL. Funnel only works on the Tailscale control plane
 * (Headscale cannot serve it), so this command expects a real Tailscale login.
 */
import * as crypto from "node:crypto";
import * as https from "node:https";
import { type Config, loadConfig, saveConfig } from "./config.js";
import { ensureBrainServer, stopBrainServer } from "./brain-server.js";
import {
	BRAIN_TAG,
	enableFunnel,
	failureText,
	FUNNEL_PORTS,
	funnelDnsWarning,
	funnelStatus,
	funnelUrl,
	joinSystem,
	systemStatus,
	tailscaleInstalled,
	waitFor,
} from "./tailnet.js";
import type { Ui } from "./ui.js";

export function newBrainToken(): string {
	return crypto.randomBytes(32).toString("hex");
}

/** Probe the public URL so the user is told about a funnel that does not actually work. */
export function publicHealth(url: string, token: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const target = new URL("/v1/health", url);
		const req = https.request(
			{
				host: target.hostname,
				port: target.port || 443,
				path: target.pathname,
				method: "GET",
				headers: { authorization: `Bearer ${token}` },
				timeout: 10000,
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
		req.end();
	});
}

async function ensureJoined(ui: Ui): Promise<boolean> {
	let status = await systemStatus();
	if (status && status.backendState === "Running") {
		ui.notify(
			`Tailscale is up on this machine (${status.dnsName || status.hostName || "no MagicDNS name"}${status.tags.length ? `, ${status.tags.join(",")}` : ""})`,
			"info",
		);
		return true;
	}
	const state = status?.backendState ?? "not running";
	const key = await ui.input(`Tailscale pre-auth key tagged ${BRAIN_TAG} (this machine is ${state})`, "tskey-auth-...");
	if (!key?.trim()) return false;
	const joined = await joinSystem(key.trim(), [BRAIN_TAG]);
	if (!joined.ok) {
		ui.notify(`tailscale up failed:\n${failureText(joined)}`, "error");
		return false;
	}
	status = await systemStatus();
	if (!status || status.backendState !== "Running") {
		ui.notify("tailscale does not report itself as running yet; re-run /setup-funnel in a moment.", "warning");
		return false;
	}
	return true;
}

async function choosePort(ui: Ui, brainPort: number): Promise<number> {
	const existing = await funnelStatus();
	if (existing.ok && existing.stdout.trim() && !/No serve config/i.test(existing.stdout)) {
		ui.notify(`Existing serve/funnel config:\n${existing.stdout.trim()}`, "info");
	}
	const answer = await ui.select(`Publish the memory API on which public port? (local ${brainPort})`, [
		"443 (https://<machine>.<tailnet>.ts.net)",
		"8443 (https://<machine>.<tailnet>.ts.net:8443)",
		"10000 (https://<machine>.<tailnet>.ts.net:10000)",
	]);
	if (!answer) return 0;
	const port = Number(answer.split(" ")[0]);
	if (FUNNEL_PORTS.includes(port)) return port;
	return 443;
}

/**
 * Wire the brain up: token, local server, tailnet membership, funnel, verification.
 * Returns the public URL, or null when something stopped the flow.
 */
export async function runFunnelSetup(ui: Ui, extDir: string, cfg: Config): Promise<string | null> {
	if (!(await tailscaleInstalled())) {
		ui.notify("Tailscale is required (tailscale + tailscaled on PATH).", "error");
		return null;
	}

	// 1. A publicly reachable memory API must not be anonymous.
	let token = cfg.brainToken ?? "";
	if (!token) {
		token = newBrainToken();
		ui.notify("No brain token was set. Generated one; agents will need it.", "info");
	}

	// 2. (Re)start the local server so it runs with that token.
	const stopped = await stopBrainServer();
	if (stopped.stopped) ui.notify(`Restarting the brain server to apply the token (${stopped.detail})`, "info");
	const server = await ensureBrainServer(extDir, { port: cfg.brainPort, token }, (m) => ui.notify(m, "info"));
	if (!server.ok) {
		ui.notify(`Brain server: ${server.detail}`, "error");
		return null;
	}

	// 3. Tailscale must be up, and Funnel needs the standard tailnet domain.
	if (!(await ensureJoined(ui))) return null;
	const status = await systemStatus();
	if (!status) {
		ui.notify("Could not read tailscale status.", "error");
		return null;
	}
	const warning = funnelDnsWarning(status.dnsName);
	if (warning) ui.notify(warning, "warning");

	// 4. Publish.
	const publicPort = await choosePort(ui, cfg.brainPort);
	if (!publicPort) return null;
	ui.progress?.(`tailscale: publishing port ${cfg.brainPort} on ${publicPort}…`);
	const published = await enableFunnel(cfg.brainPort, publicPort);
	if (!published.ok) {
		ui.notify(
			[
				`tailscale funnel failed:\n${failureText(published)}`,
				"",
				"Common causes: HTTPS or the funnel node attribute is not enabled for the tailnet (the admin console link Tailscale prints above), a custom MagicDNS domain, or another service already on that port.",
			].join("\n"),
			"error",
		);
		return null;
	}

	const url = funnelUrl(status.dnsName, publicPort);

	// 5. Verify from the outside before claiming success.
	ui.progress?.("verifying the public URL…");
	const reachable = await waitFor(async () => {
		try {
			return (await publicHealth(url, token)) === 200;
		} catch {
			return false;
		}
	}, 30000);

	const saved: Config = { ...loadConfig(false), role: "brain", brainToken: token, funnelUrl: url };
	saveConfig(saved);

	if (!reachable) {
		ui.notify(
			`Funnel is configured and the URL is ${url}, but /v1/health did not answer yet. Public URLs can take a minute to propagate; check with:\n  curl -s ${url}/v1/health -H 'Authorization: Bearer <token>'`,
			"warning",
		);
		return url;
	}

	ui.notify(
		[
			"The memory API is public.",
			"",
			`URL:   ${url}`,
			`Token: ${token}`,
			"",
			"On each agent: /join-tailnet-agent → \"Use a public brain URL\", then paste the URL and the token.",
			`Tailnet-only access still works too: agents joined with a ${BRAIN_TAG} ACL grant can discover this machine by tag.`,
			"",
			"Anyone with the URL *and* the token can read and write the shared memory. Keep the token secret.",
		].join("\n"),
		"info",
	);
	return url;
}
