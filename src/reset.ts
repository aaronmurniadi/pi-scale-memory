/**
 * A complete wipe of everything this extension created on a machine: config,
 * cache, the brain's tailscale node, logs and pid files, plus leftovers from
 * crashed sessions. Device entries in the tailnet itself are not ours to delete
 * (that needs the admin console or the Tailscale API), so they are reported.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { brainLogPath, stopBrainServer } from "./brain-server.js";
import { configDir } from "./config.js";
import { daemonFiles, readDaemonPid } from "./daemon.js";
import { PSM_TMP_PREFIX, reapOrphanedTailscaled, run } from "./tailnet.js";
import { agentNodePaths, brainNodePaths, logoutAgentNode, stopAgentNode, stopBrainNode } from "./tailnet-node.js";

/** Sessions that crashed leave their userspace tailscaled socket dir behind. */
export const TMP_PREFIX = PSM_TMP_PREFIX;
export const STALE_AFTER_MS = 60 * 60 * 1000;

export interface TmpEntry {
	path: string;
	mtimeMs: number;
}

/** Pick the leftover session dirs that are old enough to be safe to delete. */
export function staleTempDirs(entries: TmpEntry[], now: number, minAgeMs = STALE_AFTER_MS): string[] {
	return entries
		.filter((entry) => path.basename(entry.path).startsWith(TMP_PREFIX))
		.filter((entry) => now - entry.mtimeMs >= minAgeMs)
		.map((entry) => entry.path)
		.sort();
}

export function readTmpEntries(tmpDir = os.tmpdir()): TmpEntry[] {
	let names: string[] = [];
	try {
		names = fs.readdirSync(tmpDir);
	} catch {
		return [];
	}
	const entries: TmpEntry[] = [];
	for (const name of names) {
		if (!name.startsWith(TMP_PREFIX)) continue;
		const full = path.join(tmpDir, name);
		try {
			entries.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
		} catch {
			/* vanished */
		}
	}
	return entries;
}

export interface ResetPlan {
	/** Removed outright. */
	remove: string[];
	/** Daemons this extension started, stopped first. */
	stop: string[];
	/** Files that exist right now, for the confirmation text. */
	present: string[];
}

export function planReset(now = Date.now(), tmpDir = os.tmpdir()): ResetPlan {
	const dir = configDir();
	const remove = [dir];
	const stale = staleTempDirs(readTmpEntries(tmpDir), now);
	remove.push(...stale);

	const stop: string[] = [];
	const brainPid = readDaemonPid("brain");
	if (brainPid !== null) stop.push(`brain server (pid ${brainPid})`);
	const nodePid = readDaemonPid("brain-tailscaled");
	if (nodePid !== null) stop.push(`the brain's tailscale node (pid ${nodePid})`);
	const agentPid = readDaemonPid("agent-tailscaled");
	if (agentPid !== null) stop.push(`this machine's agent node (pid ${agentPid})`);

	const present = remove.filter((p) => fs.existsSync(p));
	return { remove, stop, present };
}

export function describeReset(plan: ResetPlan): string {
	const lines: string[] = [];
	if (plan.stop.length > 0) {
		lines.push("Stops:", ...plan.stop.map((s) => `  - ${s}`), "");
	}
	lines.push("Deletes:");
	for (const p of plan.remove) {
		let suffix = "";
		if (fs.existsSync(p)) suffix = " (exists)";
		else suffix = " (not present)";
		lines.push(`  - ${p}${suffix}`);
	}
	lines.push(
		"",
		"This removes the saved role, pre-auth keys, brain token, cached memory and the",
		"brain's tailscale state, so you can start over with /join brain or",
		"/join agent.",
		"",
		"Machine entries this created stay in the Tailscale admin console until you delete",
		"them or they expire.",
	);
	return lines.join("\n");
}

export interface ResetOutcome {
	stopped: string[];
	removed: string[];
	loggedOut: string[];
}

/** Stop what we started, log the nodes out, then delete the state. */
export async function performReset(log: (message: string) => void): Promise<ResetOutcome> {
	const outcome: ResetOutcome = { stopped: [], removed: [], loggedOut: [] };
	const node = brainNodePaths();
	const agent = agentNodePaths();

	// Log out before the sockets disappear, so neither node lingers as a live
	// device holding an expired key. The agent node is machine-wide, so this is
	// the only place it gets logged out.
	if (fs.existsSync(node.socket)) {
		const res = await run("tailscale", [`--socket=${node.socket}`, "logout"], { timeoutMs: 20000 });
		if (res.ok) outcome.loggedOut.push("the brain's tailscale node");
	}
	if (fs.existsSync(agent.socket) && (await logoutAgentNode())) {
		outcome.loggedOut.push("this machine's agent node");
	}

	const server = await stopBrainServer();
	if (server.stopped) {
		outcome.stopped.push(`brain server (${server.detail})`);
		log(`stopped the ${server.detail}`);
	}
	const nodeStopped = await stopBrainNode();
	if (nodeStopped.stopped) {
		outcome.stopped.push(`brain tailscale node (${nodeStopped.detail})`);
		log(`stopped the brain's tailscale node (${nodeStopped.detail})`);
	}
	const agentStopped = await stopAgentNode();
	if (agentStopped.stopped) {
		outcome.stopped.push(`agent tailscale node (${agentStopped.detail})`);
		log(`stopped this machine's agent node (${agentStopped.detail})`);
	}

	// Those same crashed sessions leave their tailscaled running with no socket to
	// reach it by, so end them before the dirs they belong to are removed.
	const reaped = await reapOrphanedTailscaled();
	if (reaped > 0) {
		outcome.stopped.push(`${reaped} leftover tailscale node(s)`);
		log(`stopped ${reaped} leftover tailscale node(s)`);
	}

	const plan = planReset();
	for (const target of plan.remove) {
		try {
			fs.rmSync(target, { recursive: true, force: true });
			outcome.removed.push(target);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			log(`could not remove ${target}: ${detail}`);
		}
	}
	return outcome;
}

export function summarizeReset(outcome: ResetOutcome): string {
	const lines: string[] = [];
	if (outcome.loggedOut.length > 0) lines.push(`Logged out: ${outcome.loggedOut.join(", ")}.`);
	if (outcome.stopped.length > 0) lines.push(`Stopped: ${outcome.stopped.join(", ")}.`);
	if (outcome.removed.length > 0) lines.push(`Removed ${outcome.removed.length} path(s).`);
	else lines.push("Nothing was left to remove.");
	lines.push(
		"",
		"Start over with /join brain or /join agent.",
		`Log: ${brainLogPath()} is gone as well, so a fresh session starts clean.`,
	);
	return lines.join("\n");
}

export { daemonFiles };
