/**
 * pi-scale-memory — one shared memory for many pi agents, over Tailscale.
 *
 * Roles (/psm-role):
 *   brain — runs the memory server on its own tailnet node and publishes it with
 *           `tailscale serve`.
 *   agent — uses its own userspace tailscaled (no TUN device, no route changes,
 *           SOCKS5 proxy only) so joining the tailnet leaves the machine's system
 *           Tailscale alone. It asks each peer which one is the brain, and mirrors
 *           the memory for offline reads.
 *
 * Commands:
 *   /psm-role                   — set this pi agent's role (brain or agent)
 *   /psm-join brain             — join this machine and host the memory here
 *   /psm-join agent             — join this machine as an agent
 *   /psm-memory                 — status | ns | pin | merge | compact | sync | search | connect
 *   /psm-core-memory            — write core memory by hand, --remove to delete, no args to show
 *   /psm-update                 — update the extension itself, then reload
 *   /psm-reset                  — delete all local state and start over
 *   /psm-install-qmd            — optional: install qmd for semantic search on the brain
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Message, StringEnum, Type } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	cacheDir,
	contextWithFallback,
	hasCache,
	metaOf,
	readWithFallback,
	searchWithFallback,
	syncCache,
} from "./src/cache.js";
import { BrainClient, localTransport, MAX_RETRY_ATTEMPTS, retryDelayMs, tailnetTransport } from "./src/client.js";
import { BUDGETS, DEFAULT_NS, SHARED } from "./brain/memory.mjs";
import { type NamespaceResolution, resolveForCwd } from "./src/namespace.js";
import { run } from "./src/shell.js";
import {
	CONFIG_DIR,
	type Config,
	loadConfig,
	type Role,
	saveConfig,
	updateConfig,
} from "./src/config.js";
import { brainLogPath, ensureBrainServer, stopBrainServer } from "./src/brain-server.js";
import { inspectInstall, runUpdate } from "./src/update.js";
import { reapOrphanedTailscaled, tailscaleInstalled } from "./src/tailnet.js";
import { findBrain, isBrainResponse } from "./src/discovery.js";
import {
	installCandidates,
	installQmd,
	noCandidateHelp,
	pickCandidate,
	QMD_PACKAGE,
	qmdStatus,
} from "./src/qmd-install.js";
import { describeReset, performReset, planReset, summarizeReset } from "./src/reset.js";
import {
	agentNodeStatus,
	agentPeers,
	agentPing,
	brainNodePaths,
	brainNodeRunning,
	ensureAgentNode,
	ensureBrainNode,
	nodeStatus,
	stopBrainNode,
	unpublishBrainPort,
} from "./src/tailnet-node.js";
import type { Ui } from "./src/ui.js";

const FLUSH_INTERVAL_MS = 30_000;
/**
 * How long a path warm-up may run before the peers are asked anyway. The point
 * is to start discovery early, not to wait for it: magicsock keeps working on a
 * peer that has not answered, and the probe that follows is what gets the
 * benefit. Peers that never answer must not hold up the search.
 */
const WARM_TIMEOUT_MS = 750;
/** How often an agent refreshes its offline mirror of the brain. */
const CACHE_SYNC_MS = Number(process.env.PI_SCALE_MEMORY_CACHE_SYNC_MS ?? 60_000);
const PERIODIC_EVERY_TURNS = Number(process.env.PI_SCALE_MEMORY_SUMMARY_EVERY_TURNS ?? 15);
const SUMMARY_MIN_MESSAGES = 4;
const SUMMARY_MAX_CHARS = 60_000;
const SUMMARY_TIMEOUT_MS = 25_000;
const SUMMARY_SYSTEM_PROMPT =
	"You extract durable memory from coding-agent conversations. Be terse and factual. Output markdown only.";
const COMPACT_MIN_CHARS = 2_000;
const COMPACT_SYSTEM_PROMPT =
	"You compress an agent memory file without losing what it is for. Output markdown bullets only, no preamble.";
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));

function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

function mark(done: boolean): string {
	if (done) return "x";
	return " ";
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function summaryPrompt(conversation: string): string {
	return [
		"Review the conversation and extract important decisions, lessons learned, notes, and follow-ups for a shared daily log.",
		"Return markdown only with these exact headings:",
		"### Decisions",
		"### Lessons Learned",
		"### Notes",
		"### Follow-ups",
		'Use bullet points under each heading. If there is nothing, write "None.".',
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");
}

function isEmptySummary(summary: string): boolean {
	const bullets = summary.split("\n").filter((l) => /^\s*[-*]\s+/.test(l));
	if (bullets.length === 0) return true;
	return bullets.every((l) => /^\s*[-*]\s+none\.?\s*$/i.test(l));
}

function compactPrompt(content: string, budget: number): string {
	return [
		"Rewrite this memory file so it fits the budget while keeping everything a future session needs.",
		"Keep: decisions, preferences, facts, conventions, and lessons that are still true.",
		"Drop: narrative, session play-by-play, timestamps, restatements of the same fact, and anything already obvious from the code.",
		"Merge duplicates into one line. Preserve #tags and [[links]]. Do not invent anything.",
		`Target: under ${budget} characters. Output markdown bullets only.`,
		"",
		"<memory>",
		content,
		"</psm-memory>",
	].join("\n");
}

function uiFrom(ctx: ExtensionContext): Ui {
	return {
		async confirm(title, message) {
			return ctx.ui.confirm(title, message);
		},
		async select(title, options) {
			return ctx.ui.select(title, options);
		},
		async input(title, placeholder) {
			return ctx.ui.input(title, placeholder);
		},
		notify(message, level) {
			ctx.ui.notify(message, level ?? "info");
		},
		progress(text) {
			if (ctx.hasUI) ctx.ui.setStatus("scale-memory", text);
		},
	};
}

export default function (pi: ExtensionAPI) {
	/**
	 * This machine's agent node, shared with every other session on the machine.
	 * It outlives a session on purpose: the node keeps its identity, so joining
	 * costs a pre-auth key once and nothing afterwards.
	 */
	let agentNode: { socksPort: number; hostname: string } | null = null;
	let client: BrainClient | null = null;
	let snapshot = "";
	/** Which project namespace this session reads and writes; resolved once at connect. */
	let activeNs: NamespaceResolution | null = null;
	let flushTimer: ReturnType<typeof setInterval> | null = null;
	let turnsSinceCapture = 0;
	let capturedMessageCount = 0;
	let connecting: Promise<void> | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryAttempt = 0;
	let lastError = "";
	let localBrainStarted = false;
	let lastCacheSync = 0;
	const cacheRoot = cacheDir();

	const agentId = `${os.hostname().split(".")[0]}`;

	function status(ctx: ExtensionContext, text: string | undefined) {
		if (ctx.hasUI) ctx.ui.setStatus("scale-memory", text);
	}

	function notConnected(): string {
		if (lastError) return `Brain not connected: ${lastError}`;
		return "Brain not connected";
	}

	/** Agents mirror the brain so reads survive an offline brain. The brain itself never needs one. */
	function cachingEnabled(cfg: Config): boolean {
		if (cfg.role === "brain") return false;
		return cfg.cache !== false;
	}

	async function syncCacheNow(ctx: ExtensionContext, cfg: Config, force = false): Promise<void> {
		if (!client) return;
		if (!cachingEnabled(cfg)) return;
		if (!force && Date.now() - lastCacheSync < CACHE_SYNC_MS) return;
		lastCacheSync = Date.now();
		try {
			const meta = await syncCache(client, cacheRoot, nsId());
			status(ctx, `brain: ${client.brainName} (cache: ${meta.files} files)`);
		} catch {
			/* the mirror is best-effort; the brain stays authoritative */
		}
	}

	/** Client for read paths that can fall back to the mirror, or null when offline. */
	function offlineCapableClient(): BrainClient | null {
		const cfg = loadConfig(false);
		if (!cachingEnabled(cfg)) return requireClient();
		return client;
	}

	function cacheLabel(res: { engine: string; source: string }): string {
		if (res.source === "cache") return "(keyword search over the cached mirror; the brain's semantic index is not reachable)";
		if (res.engine === "bm25") return "(keyword BM25 search — qmd is not installed on the brain)";
		return "";
	}

	function offlineNote(takenAt: string | null): string {
		if (takenAt) return `(brain unreachable — showing the cached copy taken ${takenAt}; it may be stale)`;
		return "(brain unreachable — showing the cached copy; it may be stale)";
	}

	async function useCachedSnapshot(ctx: ExtensionContext, cfg: Config): Promise<void> {
		if (!cachingEnabled(cfg)) return;
		if (!hasCache(cacheRoot)) return;
		const cached = await contextWithFallback(null, cacheRoot, nsId());
		snapshot = cached.value;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`pi-scale-memory: brain unreachable, using cached memory taken ${cached.takenAt ?? "earlier"}. Reads work; writes are queued.`,
				"warning",
			);
		}
	}

	function requireClient(): BrainClient {
		if (!client) throw new Error(`${notConnected()}. Run /psm-memory connect.`);
		return client;
	}

	function sessionTag(ctx: ExtensionContext): string {
		return ctx.sessionManager.getSessionId().slice(0, 8);
	}

	/** The namespace a project-scoped read or write goes to, or the legacy one when unresolved. */
	function nsId(): string {
		return activeNs?.ns ?? DEFAULT_NS;
	}

	/**
	 * Work out which project this session belongs to, from git, once per session.
	 *
	 * Two or three local git calls behind a short timeout, cached because a session's
	 * working directory does not change. Everything falls back rather than failing: a
	 * session in a non-repository directory still gets core and shared memory, and a
	 * broken repo lands in the legacy namespace instead of erroring.
	 */
	async function resolveActiveNs(ctx: ExtensionContext, cfg: Config): Promise<NamespaceResolution> {
		try {
			return await resolveForCwd(ctx.cwd, run, {
				pin: cfg.namespace,
				preferredRemote: cfg.scopeRemote,
				fallback: cfg.scopeFallback ?? "path",
				hostname: agentId,
			});
		} catch {
			return { ns: DEFAULT_NS, key: DEFAULT_NS, label: `${DEFAULT_NS} (unresolved)`, source: "fallback" };
		}
	}

	// --- brain role: the local memory server on loopback ---

	async function connectLocal(ctx: ExtensionContext, cfg: Config): Promise<void> {
		status(ctx, "brain: local");
		try {
			// The memory server has to be listening before anything publishes the port.
			// `tailscale serve` forwards to 127.0.0.1, so a published port with no
			// listener behind it refuses every agent that asks, and the agents conclude
			// there is no brain on the tailnet at all.
			const server = await ensureBrainServer(
				EXT_DIR,
				{ port: cfg.brainPort, token: cfg.brainToken ?? "" },
				(message) => {
					if (ctx.hasUI) ctx.ui.notify(message, "info");
				},
			);
			if (!server.ok) throw new Error(server.detail);

			// The brain reaches agents through its own userspace tailscale node,
			// published with `tailscale serve` (no sudo, no host tailscale changes).
			// Nothing is started when the node has never been joined.
			const joinable = Boolean(cfg.authKey) || fs.existsSync(brainNodePaths().state) || brainNodeRunning();
			if (joinable) {
				const node = await ensureBrainNode({
					port: cfg.brainPort,
					authKey: cfg.authKey,
					log: (message) => {
						if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: ${message}`, "info");
					},
				});
				if (!node.ok) {
					// A half-published port is worse than no port at all: agents would keep
					// asking a brain that cannot answer. Withdraw it again.
					await unpublishBrainPort(cfg.brainPort);
					if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: agents cannot reach this brain — ${node.detail}`, "warning");
				}
			} else if (ctx.hasUI) {
				ctx.ui.notify("pi-scale-memory: run /psm-join brain so agents can reach this brain.", "warning");
			}

			client = new BrainClient({
				host: "127.0.0.1",
				port: cfg.brainPort,
				token: cfg.brainToken ?? "",
				agentId,
				transport: localTransport(),
			});
			await client.health();
			activeNs = await resolveActiveNs(ctx, cfg);
			snapshot = await client.context(activeNs.ns);
			lastError = "";
			status(ctx, `brain: local server on port ${cfg.brainPort}`);
			if (ctx.hasUI && !(await qmdStatus()).installed) {
				ctx.ui.notify(
					"pi-scale-memory: qmd is not installed, so memory_search uses BM25. Run /psm-install-qmd for semantic search.",
					"info",
				);
			}
			if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: brain role, using the local brain server (log: ${brainLogPath()})`, "info");
		} catch (err) {
			lastError = errMsg(err);
			status(ctx, "brain: offline");
			if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: ${lastError}`, "warning");
		}
	}

	// --- agent role: userspace tailscaled + brain discovery by asking peers ---

	/**
	 * Identify the brain by asking each peer whether it serves the memory API.
	 * Tags are only a hint for probe order, so a tailnet with no tag policy works.
	 */
	async function discoverBrain(ctx: ExtensionContext, cfg: Config, announce = false): Promise<string | null> {
		const peers = await agentPeers();
		if (!agentNode) throw new Error("this machine's tailnet node is not up");
		const transport = tailnetTransport(agentNode.socksPort);
		// A node that has just joined knows its peers but has no paths to them yet,
		// and a dial in that state fails even though the peer is up and answering.
		// Asking the Tailscale layer first makes magicsock go find the endpoints.
		await Promise.all(peers.map((peer) => agentPing(peer.ip, WARM_TIMEOUT_MS)));
		const found = await findBrain(
			peers,
			async (host, timeoutMs) => {
				try {
					const res = await transport(
						host,
						cfg.brainPort,
						{
							method: "GET",
							path: "/v1/health",
							headers: cfg.brainToken ? { authorization: `Bearer ${cfg.brainToken}` } : {},
						},
						timeoutMs,
					);
					return isBrainResponse(res.status, res.body);
				} catch {
					return false;
				}
			},
			{
				host: cfg.brainHost,
				onProbe: (peer, isBrain) => {
					if (isBrain && announce && ctx.hasUI) ctx.ui.notify(`pi-scale-memory: ${peer} answered as the brain`, "info");
				},
			},
		);

		if (found.pinnedFailed && ctx.hasUI) {
			ctx.ui.notify(`pi-scale-memory: the pinned brain host did not answer; searched the tailnet instead.`, "warning");
		}
		if (found.brains.length > 1 && ctx.hasUI) {
			ctx.ui.notify(
				`${found.brains.length} peers answered as a brain (${found.brains.map((b) => b.name).join(", ")}); using ${found.brains[0].name}.`,
				"warning",
			);
		}
		if (!found.host && ctx.hasUI && found.probed > 0) {
			ctx.ui.notify(
				`pi-scale-memory: asked ${found.probed} peer(s) on port ${cfg.brainPort} and none answered as a brain. Is the brain running and reachable?`,
				"warning",
			);
		}
		return found.host;
	}

	async function connectAgent(ctx: ExtensionContext, cfg: Config): Promise<void> {
		if (!(await tailscaleInstalled())) {
			lastError = "tailscale/tailscaled not found in PATH";
			if (ctx.hasUI) ctx.ui.notify("pi-scale-memory: install Tailscale (tailscale + tailscaled) first.", "error");
			return;
		}
		if (!cfg.authKey && !cfg.loginServer) {
			lastError = "not joined yet";
			status(ctx, "brain: not joined");
			if (ctx.hasUI) ctx.ui.notify("pi-scale-memory: run /psm-join agent to join the tailnet.", "warning");
			return;
		}
		status(ctx, "brain: joining tailnet…");
		try {
			const node = await ensureAgentNode({
				loginServer: cfg.loginServer,
				authKey: cfg.authKey,
				log: (message) => {
					if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: ${message}`, "info");
				},
			});
			if (!node.ok || node.socksPort === undefined) {
				throw new Error(node.detail);
			}
			agentNode = { socksPort: node.socksPort, hostname: node.hostname ?? "" };
			const candidate = new BrainClient({
				host: "",
				port: cfg.brainPort,
				token: cfg.brainToken ?? "",
				agentId,
				transport: tailnetTransport(node.socksPort),
				resolveHost: () => discoverBrain(ctx, cfg),
			});
			status(ctx, "brain: searching peers…");
			if (!(await candidate.discover())) {
				throw new Error(`no peer answered as a brain on port ${cfg.brainPort}`);
			}
			const health = await candidate.health();
			client = candidate;
			activeNs = await resolveActiveNs(ctx, cfg);
			if (!health.scopes && ctx.hasUI) {
				ctx.ui.notify(
					"pi-scale-memory: this brain predates memory tiers, so writes go into its flat store and core memory is unavailable. Update the extension on the brain.",
					"warning",
				);
			}
			snapshot = await client.context(activeNs.ns);
			lastError = "";
			cancelAgentRetry();
			await syncCacheNow(ctx, cfg, true);
			status(ctx, `brain: ${client.brainName}`);
			if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: connected to brain ${client.brainName}`, "info");
		} catch (err) {
			lastError = errMsg(err);
			status(ctx, "brain: offline");
			// Only the first attempt warns. Saying it again every few seconds while a
			// brain is briefly away is noise, and the retry already reports itself.
			if (retryAttempt === 0 && ctx.hasUI) ctx.ui.notify(`pi-scale-memory: ${lastError}`, "warning");
			scheduleAgentRetry(ctx);
		}
	}

	/**
	 * Retry a brain that is not answering yet, a bounded number of times.
	 *
	 * A retry covers the cases that fix themselves: a node that has just joined has
	 * the peer list but no paths yet, and a reset brain comes back under a new
	 * address. Past a few tries the cause is usually something only the user can
	 * change — no brain running yet, the wrong port, a machine that is asleep — so
	 * the agent stops and says what to do instead of retrying in silence. Reads keep
	 * coming from the mirror while it is disconnected.
	 */
	function scheduleAgentRetry(ctx: ExtensionContext): void {
		if (retryTimer) return;
		if (retryAttempt >= MAX_RETRY_ATTEMPTS) {
			status(ctx, "brain: offline, run /psm-memory connect");
			if (ctx.hasUI) {
				ctx.ui.notify(
					`pi-scale-memory: gave up after ${MAX_RETRY_ATTEMPTS} tries (${lastError || "no peer answered as a brain"}). Run /psm-memory connect to try again.`,
					"warning",
				);
			}
			return;
		}
		const delay = retryDelayMs(retryAttempt);
		retryAttempt++;
		status(
			ctx,
			`brain: offline, retrying in ${Math.round(delay / 1000)}s (attempt ${retryAttempt}/${MAX_RETRY_ATTEMPTS})`,
		);
		retryTimer = setTimeout(() => {
			retryTimer = null;
			void reconnect(ctx);
		}, delay);
		retryTimer.unref();
	}

	function cancelAgentRetry(): void {
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		retryAttempt = 0;
	}

	/** Connect at most once at a time, however many callers ask. */
	async function reconnect(ctx: ExtensionContext): Promise<void> {
		if (!connecting) {
			connecting = connect(ctx).finally(() => {
				connecting = null;
			});
		}
		await connecting;
	}

	async function connect(ctx: ExtensionContext): Promise<void> {
		const cfg = loadConfig();
		if (cfg.role === "brain") {
			await connectLocal(ctx, cfg);
			return;
		}
		await connectAgent(ctx, cfg);
		if (!snapshot && cachingEnabled(cfg)) await useCachedSnapshot(ctx, cfg);
	}

	async function disconnect(): Promise<void> {
		if (flushTimer) {
			clearInterval(flushTimer);
			flushTimer = null;
		}
		cancelAgentRetry();
		// The node is shared per machine and stays up between sessions, so this only
		// drops our handle to it. /psm-reset stops it for good.
		agentNode = null;
		// Clear out anything an older version left running with its socket already
		// deleted, which is unreachable from then on.
		await reapOrphanedTailscaled();
		client = null;
		snapshot = "";
		activeNs = null;
		lastError = "";
	}

	// --- periodic summaries stored to the brain ---

	/** One model call, shared by the session summary and by /psm-memory compact. */
	async function askModel(ctx: ExtensionContext, system: string, prompt: string): Promise<string | null> {
		const model = ctx.model;
		if (!model) return null;
		const registry = ctx.modelRegistry as any;
		let apiKey: string | undefined;
		if (typeof registry?.getApiKey === "function") apiKey = await registry.getApiKey(model);
		else if (typeof registry?.getApiKeyForProvider === "function") {
			apiKey = await registry.getApiKeyForProvider(model.provider);
		}
		if (!apiKey) return null;
		const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }];
		try {
			const res = await complete(model, { systemPrompt: system, messages: msgs }, { apiKey });
			return res.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();
		} catch {
			return null;
		}
	}

	async function summarize(ctx: ExtensionContext): Promise<string | null> {
		const branch = ctx.sessionManager.getBranch();
		const messages = branch.flatMap((e) => {
			if (e.type === "message") return [e.message];
			return [];
		});
		const fresh = messages.slice(capturedMessageCount);
		if (fresh.length < SUMMARY_MIN_MESSAGES) return null;

		let text = serializeConversation(convertToLlm(fresh)).trim();
		if (!text) return null;
		if (text.length > SUMMARY_MAX_CHARS) text = text.slice(-SUMMARY_MAX_CHARS);
		const out = await askModel(ctx, SUMMARY_SYSTEM_PROMPT, summaryPrompt(text));
		capturedMessageCount = messages.length;
		if (!out || isEmptySummary(out)) return null;
		return out;
	}

	async function capture(ctx: ExtensionContext, label: string, timeoutMs = SUMMARY_TIMEOUT_MS) {
		if (!client) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const expired = new Promise<null>((r) => {
				timer = setTimeout(() => r(null), timeoutMs);
			});
			const summary = await Promise.race([summarize(ctx), expired]);
			if (!summary) return;
				await client.writeOrQueue({
					path: "/v1/write",
					body: {
						target: "daily",
						ns: nsId(),
						content: `## Session Summary (auto, ${label})\n\n${summary}`,
						agent: client.agentId,
						session: sessionTag(ctx),
						nsKey: activeNs?.key,
						nsLabel: activeNs?.label,
					},
				});
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Fold one tier's MEMORY.md down with the session model.
	 *
	 * The brain has no model of its own, so compaction runs on the agent and writes
	 * the result back as an overwrite. It refuses to touch a file that is already
	 * small, and refuses to write a result that is not smaller than the original, so
	 * a bad compaction cannot make memory worse than leaving it alone.
	 */
	async function compactNamespace(ctx: ExtensionContext, ns: string): Promise<void> {
		const c = client;
		if (!c) {
			ctx.ui.notify(`${notConnected()} — compaction needs the brain.`, "warning");
			return;
		}
		if (ns === "core") {
			// Refused before the model call, not after it: core is short by construction
			// and pruning it is a decision for the user, not a summariser.
			ctx.ui.notify(
				"Core memory is not compacted. It is short by construction, and its edits are yours: use /psm-core-memory --remove to drop an entry.",
				"info",
			);
			return;
		}
		// Compact to the tier's own budget, so a fold cannot leave the file still
		// over what gets injected.
		const budget = ns === SHARED ? BUDGETS.shared : BUDGETS.longTerm;
		let content = "";
		try {
			const res = await readWithFallback(c, cacheRoot, "long_term", { ns });
			content = String(res.value.content ?? "");
		} catch (e) {
			ctx.ui.notify(`Could not read ${ns}/MEMORY.md: ${errMsg(e)}`, "error");
			return;
		}
		const trimmed = content.trim();
		if (trimmed.length < COMPACT_MIN_CHARS) {
			ctx.ui.notify(`${ns}/MEMORY.md is ${trimmed.length} chars — nothing worth compacting.`, "info");
			return;
		}
		const before = content.length;
		const folded = await askModel(ctx, COMPACT_SYSTEM_PROMPT, compactPrompt(content, budget));
		if (!folded) {
			ctx.ui.notify("Compaction needs the session model and an API key; nothing was written.", "warning");
			return;
		}
		if (folded.length >= before) {
			ctx.ui.notify(`Compaction produced ${folded.length} chars from ${before}; kept the original.`, "info");
			return;
		}
		try {
			await c.writeNow({
				path: "/v1/write",
				body: { target: "long_term", mode: "overwrite", ns, content: folded, agent: c.agentId },
			});
		} catch (e) {
			ctx.ui.notify(`Compaction write failed: ${errMsg(e)}`, "error");
			return;
		}
		const saved = Math.ceil((before - folded.length) / 4);
		ctx.ui.notify(`Compacted ${ns}/MEMORY.md: ${before} → ${folded.length} chars (~${saved} tokens less in every session).`, "info");
	}

	// --- lifecycle ---
	pi.on("session_start", async (_event, ctx) => {
		turnsSinceCapture = 0;
		capturedMessageCount = 0;
		if (flushTimer) clearInterval(flushTimer);
		// A session that ended on a transition left a retry pending against its own
		// context; start this one clean instead.
		cancelAgentRetry();
		await reconnect(ctx);
		flushTimer = setInterval(async () => {
			if (!client) return;
			try {
				if (client.pending > 0) await client.flush();
			} catch {
				/* retry next tick */
			}
			await syncCacheNow(ctx, loadConfig());
		}, FLUSH_INTERVAL_MS);
		flushTimer.unref();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (flushTimer) {
			clearInterval(flushTimer);
			flushTimer = null;
		}
		const reason = (event as { reason?: string }).reason;
		let transition = false;
		if (reason === "reload" || reason === "new" || reason === "resume" || reason === "fork") transition = true;
		if (client && !transition) {
			try {
				await capture(ctx, "exit");
				await client.flush();
			} catch {
				/* best effort */
			}
		}
		if (!transition) await disconnect();
	});

	pi.on("before_agent_start", async (event) => {
		if (!snapshot) return;
		const where = activeNs ? `${activeNs.label} (${activeNs.source})` : "unresolved";
		const header = [
			"\n\n## Memory (shared brain)",
			`(Loaded once at session start from the shared brain; project tier: ${where}. Other agents may have written since — use memory_read / memory_search for the latest.)`,
			"",
			"Three tiers, all of them budgeted. Keep them small enough to be worth their tokens:",
			"- **Project memory** (default): decisions, findings and facts about this repository. memory_write, scope project.",
			"- **Shared memory** (scope shared): only what is true for every project, such as a convention you have now confirmed twice.",
			"- **Core memory** (scope core): the human's own rules, loaded in every session on every project. Write it only when the user explicitly asks for something to be core memory ('remember <file> as core memory'); never on your own initiative. They can also write it themselves with /psm-core-memory.",
			"",
			"Writing so memory stays useful:",
			"- Write the durable fact, not the conversation that produced it. One line beats a paragraph.",
			"- memory_search first; if the fact is already there, update that entry instead of adding a near-copy.",
			"- A near-duplicate write replaces the older entry automatically, so restating costs a round trip and adds nothing.",
			"- Project daily logs (memory_write daily) are for work notes; only today and yesterday are read back.",
			"- Shared memory is yours to prune: drop what turned out wrong or obvious with memory_forget, scope shared.",
			"- Use #tags and [[links]] in content to improve search recall.",
			'- If someone says "remember this," write it to project memory immediately.',
			"",
			snapshot,
		];
		return { systemPrompt: event.systemPrompt + header.join("\n") };
	});

	pi.on("agent_end", async (_event, ctx) => {
		turnsSinceCapture++;
		if (PERIODIC_EVERY_TURNS > 0 && turnsSinceCapture >= PERIODIC_EVERY_TURNS) {
			turnsSinceCapture = 0;
			// Fire and forget: never block the next prompt on a summary.
			void capture(ctx, "periodic");
		}
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		if (!client) return;
		await capture(ctx, "pre-compact");
		try {
			snapshot = await client.context(nsId());
		} catch {
			/* keep the previous snapshot */
		}
	});

	// --- /psm-memory ---
	pi.registerCommand("psm-memory", {
		description: "pi-scale-memory: status | ns | pin | merge | compact | sync | search | connect",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
			if (sub === "sync") {
				const cfg = loadConfig(false);
				if (!cachingEnabled(cfg)) {
					ctx.ui.notify("Caching is off (brain role, or PI_SCALE_MEMORY_CACHE=0).", "info");
					return;
				}
				if (!client) {
					ctx.ui.notify(`${notConnected()} — nothing to sync from.`, "warning");
					return;
				}
				try {
					const meta = await syncCache(client, cacheRoot, nsId());
					ctx.ui.notify(`Cache refreshed: ${meta.files} file(s) taken ${meta.takenAt} in ${cacheRoot}`, "info");
				} catch (e) {
					ctx.ui.notify(`Cache sync failed: ${errMsg(e)}`, "error");
				}
				return;
			}
			if (sub === "search") {
				if (!client) {
					ctx.ui.notify(`${notConnected()} — the brain owns the search index.`, "warning");
					return;
				}
				try {
					const h = await client.health();
					ctx.ui.notify(
						`Brain search: engine=${h.search?.engine ?? "?"} mode=${h.search?.mode ?? "?"} collections=${h.search?.collections?.join(",") ?? "?"} indexing=${h.search?.indexing ?? "?"} | scopes: ${h.scopes?.join(",") ?? "flat (pre-tier brain)"}`,
						"info",
					);
				} catch (e) {
					ctx.ui.notify(`Could not read brain search state: ${errMsg(e)}`, "error");
				}
				return;
			}
			if (sub === "connect") {
				await stopBrainNode();

				await disconnect();
				await connect(ctx);
				return;
			}
			// `ns` answers with this machine's namespace and the brain's list of them;
			// `pin` is the one that writes, so a read never looks like a write.
			if (sub === "ns") {
				const lines: string[] = [];
				if (!activeNs) {
					lines.push("Namespace: not resolved yet.");
				} else {
					const pin = loadConfig(false).namespace;
					lines.push(
						`Namespace: ${activeNs.ns}`,
						`key: ${activeNs.key}`,
						`resolved from: ${activeNs.source}`,
						`pin: ${pin ?? "(none)"} (set with /psm-memory pin <ns>, clear with /psm-memory pin --clear)`,
						"",
					);
				}
				if (!client) {
					lines.push(`${notConnected()} — the brain owns the namespace list.`);
					ctx.ui.notify(lines.join("\n"), "warning");
					return;
				}
				try {
					const listing = await client.namespaces(nsId());
					const tokens = (n: number) => `~${Math.ceil(n / 4)} tokens`;
					lines.push(
						`core:   ${listing.core.memory} chars ${tokens(listing.core.memory)} (loaded in every session)`,
						`shared: ${listing.shared.memory} chars ${tokens(listing.shared.memory)} (loaded in every session)`,
						"",
					);
					for (const n of listing.namespaces) {
						const here = n.id === nsId() ? "*" : " ";
						let flags = "";
						if (n.archived) flags += " [archived]";
						if (n.id === listing.default) flags += " [default]";
						lines.push(
							`${here} ${n.id}${flags} — mem ${n.memory} | scratch ${n.scratchpad} | daily ${n.dailyFiles} file(s), ${n.daily} chars | ${n.label}`,
						);
					}
				} catch (e) {
					lines.push(`Could not list namespaces: ${errMsg(e)}`);
					ctx.ui.notify(lines.join("\n"), "error");
					return;
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "pin") {
				const wanted = (args ?? "").trim().split(/\s+/).slice(1).join(" ").trim();
				if (!wanted) {
					ctx.ui.notify("Usage: /psm-memory pin <ns> | /psm-memory pin --clear", "warning");
					return;
				}
				if (wanted === "--clear") {
					updateConfig({ namespace: undefined });
					activeNs = await resolveActiveNs(ctx, loadConfig(false));
					ctx.ui.notify(`Pin cleared; this workspace resolves to ${activeNs.ns}.`, "info");
					return;
				}
				updateConfig({ namespace: wanted });
				activeNs = await resolveActiveNs(ctx, loadConfig(false));
				ctx.ui.notify(
					`Pinned this machine to '${wanted}'. Every session on this machine now uses it; /psm-memory pin --clear removes the pin.`,
					"info",
				);
				if (client) {
					try {
						snapshot = await client.context(nsId());
					} catch {
						/* keep the previous snapshot */
					}
				}
				return;
			}
			if (sub === "merge") {
				const parts = (args ?? "").trim().split(/\s+/).slice(1);
				const from = parts[0];
				const into = parts[1];
				if (!from || !into) {
					ctx.ui.notify("Usage: /psm-memory merge <from-ns> <into-ns>", "warning");
					return;
				}
				if (!client) {
					ctx.ui.notify(`${notConnected()} — the brain owns the namespaces.`, "warning");
					return;
				}
				try {
					const res = await client.mergeNamespaces(from, into);
					const daily = res.moved?.daily ?? 0;
					ctx.ui.notify(
						`Merged ${from} into ${into}: ${daily} daily log(s), ${res.moved?.memory ? "MEMORY.md appended" : "MEMORY.md unchanged"}.`,
						"info",
					);
				} catch (e) {
					ctx.ui.notify(`Merge failed: ${errMsg(e)}`, "error");
				}
				return;
			}
			if (sub === "compact") {
				const target = (args ?? "").trim().split(/\s+/)[1] ?? nsId();
				await compactNamespace(ctx, target);
				return;
			}
			const cfg = loadConfig(false);
			if (!client) {
				const meta = metaOf(cacheRoot);
				if (meta) {
					ctx.ui.notify(
						`${notConnected()} (role: ${cfg.role ?? "unset"}) — offline, reading from the cache taken ${meta.takenAt}`,
						"warning",
					);
					return;
				}
				ctx.ui.notify(`${notConnected()} (role: ${cfg.role ?? "unset"})`, "warning");
				return;
			}
			let health = "ok";
			let search = "unknown";
			try {
				const h = await client.health();
				if (h.search) {
					let suffix = "";
					if (h.search.indexing) suffix = " (indexing)";
					search = `${h.search.engine}/${h.search.mode}${suffix}`;
				}
			} catch (e) {
				health = errMsg(e);
			}
			const where = client.brainIp ?? "?";
			let cacheInfo = "cache: none";
			const meta = metaOf(cacheRoot);
			if (meta) cacheInfo = `cache: ${meta.files} file(s) taken ${meta.takenAt}`;
			// The node is machine-wide, so report it from the node itself: it is there
			// even for a session that has not connected to a brain yet.
			const agent = await agentNodeStatus();
			let nodeInfo = `node: ${agent?.hostname || "not joined (run /psm-join agent)"}`;
			if (cfg.role === "brain") {
				const node = await nodeStatus();
				if (node) nodeInfo = `node: ${node.hostname} ${node.ip} tags=[${node.tags.join(",")}]`;
				else nodeInfo = "node: not joined (run /psm-join brain)";
			}
			// What memory costs: core and shared are injected in every session, so their
			// size is a standing token bill rather than a one-off.
			let tierInfo = "";
			let nsInfo = `ns: ${nsId()}`;
			if (activeNs) nsInfo += ` (${activeNs.label}, ${activeNs.source})`;
			try {
				const listing = await client.namespaces(nsId());
				const project = listing.namespaces.find((n) => n.id === nsId());
				const projectChars = project ? project.memory + project.scratchpad : 0;
				const standing = listing.core.memory + listing.shared.memory;
				tierInfo = ` | tiers: core ${listing.core.memory}b shared ${listing.shared.memory}b project ${projectChars}b (~${Math.ceil((standing + projectChars) / 4)} tok/session)`;
			} catch {
				/* sizes are a nicety, not a status requirement */
			}
			ctx.ui.notify(
				`Role: ${cfg.role ?? "unset"} | brain: ${client.brainName} (${where}) health=${health} search=${search} queued=${client.pending} | ${cacheInfo} | ${nsInfo}${tierInfo} | ${nodeInfo}`,
				"info",
			);
		},
	});

	// --- /psm-core-memory: the human's writer to core memory ---
	pi.registerCommand("psm-core-memory", {
		description:
			"pi-scale-memory: write core memory (loaded in every session, every project). No arguments shows it, --remove <match> deletes",
		handler: async (args, ctx) => {
			const c = client;
			if (!c) {
				ctx.ui.notify(`${notConnected()} — core memory lives on the brain. Nothing was written.`, "warning");
				return;
			}
			const raw = (args ?? "").trim();
			try {
				if (!raw) {
					const out = await c.readCore();
					const content = String(out.content ?? "").trim();
					if (!content) {
						ctx.ui.notify("Core memory is empty. Add to it with /psm-core-memory <memory>.", "info");
						return;
					}
					ctx.ui.notify(
						`Core memory (${content.length} chars, ~${Math.ceil(content.length / 4)} tokens in every session):\n\n${content}`,
						"info",
					);
					return;
				}
				if (raw === "--remove" || raw.startsWith("--remove ")) {
					const match = raw.slice("--remove".length).trim();
					if (!match) {
						ctx.ui.notify("Usage: /psm-core-memory --remove <match>", "warning");
						return;
					}
					const res = await c.writeCore({ action: "remove", match });
					if (!res.removed) {
						ctx.ui.notify("Nothing in core memory matched; nothing was removed.", "info");
						return;
					}
					ctx.ui.notify(`Removed ${res.removed} core entr(y/ies). Recovery id: ${res.recoveryId}`, "info");
					return;
				}
				if (raw.startsWith("--")) {
					ctx.ui.notify("Usage: /psm-core-memory <memory> | /psm-core-memory --remove <match> | /psm-core-memory", "warning");
					return;
				}
				const res = await c.writeCore({ action: "append", content: raw });
				if (res.deduped) {
					ctx.ui.notify("Core memory already said that; the existing entry was updated in place.", "info");
					return;
				}
				ctx.ui.notify("Added to core memory. It is loaded in every session, on every project.", "info");
			} catch (e) {
				// Core writes are never queued: a rule you believe was saved must not be
				// sitting in an outbox that could still fail.
				ctx.ui.notify(`Core memory write failed: ${errMsg(e)} — nothing was stored.`, "error");
			}
		},
	});

	// --- /psm-role ---
	pi.registerCommand("psm-role", {
		description: "Set this pi agent's role: brain (hosts memory) or agent (uses memory)",
		handler: async (args, ctx) => {
			const current = loadConfig(false).role;
			const arg = (args ?? "").trim().toLowerCase();
			let role: Role | null = null;
			if (arg === "brain" || arg === "agent") {
				role = arg;
			} else {
				const picked = await ctx.ui.select("Set this pi agent's role:", ["brain", "agent"]);
				if (!picked) return;
				if (picked === "brain" || picked === "agent") role = picked;
			}
			if (!role) return;
			updateConfig({ role });
			await disconnect();
			await connect(ctx);
			if (role === "brain") {
				ctx.ui.notify(
					"This pi agent is the brain: memory is served locally. Next: /psm-join brain, then create a reusable pre-auth key in the Tailscale admin console for the agents.",
					"info",
				);
				return;
			}
			ctx.ui.notify("This pi agent is an agent: it asks the tailnet which peer is the brain. Next: /psm-join agent.", "info");
			if (current === "brain") ctx.ui.notify("Note: the local brain server keeps running if you started it.", "info");
		},
	});

	// --- joining helpers (shared by the two role-specific join commands) ---

	async function askPreauthKey(ctx: ExtensionContext, forWhom: string): Promise<string | null> {
		const stored = loadConfig(false).authKey;
		if (stored) {
			const source = await ctx.ui.select(`Pre-auth key for ${forWhom}`, ["Use the stored key", "Enter a new key"]);
			if (!source) return null;
			if (source.startsWith("Use the stored")) return stored;
		}
		const entered = await ctx.ui.input(
			`Pre-auth key for ${forWhom} (create one in the Tailscale admin console; tags optional)`,
			"tskey-auth-...",
		);
		if (!entered?.trim()) return null;
		return entered.trim();
	}

	/** Agent device: userspace tailscaled, then ask the tailnet which peer is the brain. */
	async function joinAsAgent(ctx: ExtensionContext): Promise<void> {
		const key = await askPreauthKey(ctx, "this agent");
		if (!key) return;
		const cfg = updateConfig({ role: "agent", authKey: key });
		ctx.ui.notify("Saved. Joining the tailnet and looking for the brain…", "info");
		await disconnect();
		await connect(ctx);
		if (client) {
			ctx.ui.notify(
				`Joined as ${agentNode?.hostname || "this machine"} and connected to brain "${client.brainName}".`,
				"info",
			);
			return;
		}
		ctx.ui.notify(
			`Joined the tailnet, but no peer answered as a brain on port ${cfg.brainPort} yet. It tries ${MAX_RETRY_ATTEMPTS} times on its own; if none of them finds a brain, run /psm-memory connect to try again — and /psm-join brain on the machine that should host one.`,
			"warning",
		);
	}

	/** Brain device: our own userspace tailscaled, hosting the memory. */
	async function joinAsBrain(ctx: ExtensionContext): Promise<void> {
		if (!(await tailscaleInstalled())) {
			ctx.ui.notify("Tailscale is required (tailscale + tailscaled on PATH).", "error");
			return;
		}
		const cfg = loadConfig(false);
		const status = await nodeStatus();
		if (status && status.backendState === "Running") {
			let tags = "no tags";
			if (status.tags.length > 0) tags = `tags: ${status.tags.join(", ")}`;
			ctx.ui.notify(
				`This brain already has its own tailnet node (${status.hostname || "?"} at ${status.ip || status.dnsName || "?"}, ${tags}).`,
				"info",
			);
		}
		ctx.ui.notify(
			[
				"This joins using a private userspace tailscale: no sudo,",
				"and the machine's own Tailscale is left untouched.",
			].join("\n"),
			"info",
		);

		const key = await askPreauthKey(ctx, "this brain");
		if (!key) return;

		// Joining publishes the memory port, so the server has to be answering first.
		// An agent that probes while the port is up but nothing is behind it reads
		// that as "no brain on this tailnet".
		const server = await ensureBrainServer(
			EXT_DIR,
			{ port: cfg.brainPort, token: cfg.brainToken ?? "" },
			(message) => ctx.ui.notify(message, "info"),
		);
		if (!server.ok) {
			ctx.ui.notify(server.detail, "error");
			return;
		}

		const node = await ensureBrainNode({
			port: cfg.brainPort,
			authKey: key,
			log: (message) => ctx.ui.notify(`pi-scale-memory: ${message}`, "info"),
		});
		if (!node.ok) {
			ctx.ui.notify(node.detail, "error");
			return;
		}

		updateConfig({ role: "brain", authKey: key });
		await disconnect();
		await connect(ctx);
		ctx.ui.notify(
			[
				`This machine is the brain, reachable on the tailnet as ${node.detail}.`,
				`The memory API is published to the tailnet on port ${cfg.brainPort} (proxied to 127.0.0.1).`,
				"",
				"Next: create a reusable pre-auth key in the Tailscale admin console for the agents,",
				`and make sure the ACL lets them reach this brain on port ${cfg.brainPort}.`,
			].join("\n"),
			"info",
		);
	}

	// --- qmd (optional semantic search backend, brain side) ---

	/** Install qmd into a prefix that is actually on PATH, then restart the brain. */
	async function installQmdFlow(ctx: ExtensionContext): Promise<void> {
		const existing = await qmdStatus();
		if (existing.installed) {
			ctx.ui.notify(`qmd is already installed (${existing.version}) at ${existing.dir}.`, "info");
			return;
		}

		const candidates = await installCandidates();
		const chosen = pickCandidate(candidates);
		if (!chosen) {
			ctx.ui.notify(noCandidateHelp(candidates), "error");
			return;
		}

		const command = `npm install -g --prefix=${chosen.prefix} ${QMD_PACKAGE}`;
		if (!(await ctx.ui.confirm("Install qmd?", command))) return;

		const result = await installQmd(chosen, (message) => {
			if (ctx.hasUI) ctx.ui.setStatus("scale-memory", message);
		});
		if (!result.ok) {
			ctx.ui.notify(`qmd install failed:\n${result.detail}`, "error");
			return;
		}

		// The brain server probes qmd at startup, so it has to come back up.
		if (loadConfig(false).role === "brain") {
			await stopBrainServer();
			await connect(ctx);
			ctx.ui.notify(`${result.detail} Restarted the brain server, which now indexes with qmd.`, "info");
			return;
		}
		ctx.ui.notify(`${result.detail} The brain machine is where qmd matters.`, "info");
	}

	// --- /psm-install-qmd ---
	pi.registerCommand("psm-install-qmd", {
		description: "Install qmd (semantic search for the brain) into a prefix on your PATH",
		handler: async (_args, ctx) => {
			await installQmdFlow(ctx);
		},
	});

	// --- full reset (used by /psm-reset) ---
	async function resetEverything(ctx: ExtensionContext): Promise<void> {
		const plan = planReset();
		if (!(await ctx.ui.confirm("Reset pi-scale-memory completely?", describeReset(plan)))) {
			ctx.ui.notify("Reset cancelled. Nothing was changed.", "info");
			return;
		}

		// The agent node is machine-wide and is logged out by the reset itself, so
		// there is nothing session-specific to log out here.
		await disconnect();

		const outcome = await performReset((message) => ctx.ui.notify(`pi-scale-memory: ${message}`, "info"));
		ctx.ui.notify(summarizeReset(outcome), "info");
	}

	// --- /psm-reset ---
	pi.registerCommand("psm-reset", {
		description: "Delete all pi-scale-memory state (config, cache, tailscale nodes) and start over",
		handler: async (_args, ctx) => {
			await resetEverything(ctx);
		},
	});

	// --- /psm-join: one command, the role as its argument ---
	pi.registerCommand("psm-join", {
		description: "Join the tailnet: /psm-join agent (this machine uses the memory) or /psm-join brain (this machine hosts it)",
		handler: async (args, ctx) => {
			const role = (args ?? "").trim().toLowerCase();
			if (role === "agent") {
				await joinAsAgent(ctx);
				return;
			}
			if (role === "brain") {
				await joinAsBrain(ctx);
				return;
			}
			ctx.ui.notify("Usage: /psm-join agent | /psm-join brain", "warning");
		},
	});

	// --- /psm-update ---
	pi.registerCommand("psm-update", {
		description: "Update this extension (git pull or pi update), then reload it",
		handler: async (_args, ctx) => {
			const info = await inspectInstall(EXT_DIR);
			const where = info.kind === "git" ? `git checkout ${info.commit ?? "?"}` : `${info.kind}${info.source ? ` ${info.source}` : ""}`;
			if (!(await ctx.ui.confirm(`Update pi-scale-memory?`, `Source: ${where}\nDirectory: ${EXT_DIR}`))) return;

			const result = await runUpdate(info);
			if (!result.ok) {
				ctx.ui.notify(result.message, "error");
				return;
			}

			const version = info.version ?? "?";
			if (info.kind === "git" && result.before === result.after) {
				ctx.ui.notify(`Already up to date (${result.after ?? version}). Reloading anyway.`, "info");
			} else {
				ctx.ui.notify(`Updated ${result.before ?? ""} → ${result.after ?? ""} (v${version}). Reloading.`.trim(), "info");
			}

			// The brain server is a separate process; restart it so it runs the new code.
			if (loadConfig(false).role === "brain") {
				const stopped = await stopBrainServer();
				if (stopped.stopped) ctx.ui.notify(`Restarting the brain server (${stopped.detail})`, "info");
			}
			await ctx.reload();
		},
	});

	// --- tools (same surface as pi-memory, backed by the brain) ---
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
			description: [
				"Write to memory on the brain. Three tiers:",
				"- 'project' (default): this repository's memory, shared with every agent working on it.",
				"- 'shared': memory that applies to every project. Conventions and lessons only, not project findings.",
				"- 'core': the human's rules, loaded in every session on every project. Use it only when the user explicitly asks for something to be core memory; for anything else they want remembered everywhere, use 'shared' or point them at /psm-core-memory.",
				"Targets: 'long_term' (MEMORY.md, curated) and 'daily' (project only, append-only work notes). Core is long_term only and is never queued.",
				"Search first: a write that restates an existing entry replaces it instead of adding a near-copy.",
			].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "daily"] as const, {
				description: "'long_term' for MEMORY.md, 'daily' for today's log",
			}),
			scope: Type.Optional(
				StringEnum(["project", "shared", "core"] as const, {
					description: "Default: project. 'shared' applies to every project and keeps no daily log. 'core' is the human's tier: only on their explicit request",
				}),
			),
			content: Type.String({ description: "Content to write (Markdown)" }),
			mode: Type.Optional(
				StringEnum(["append", "overwrite"] as const, { description: "long_term only. Default: append" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const c = requireClient();
			const scope = params.scope ?? "project";
			if (scope === "shared" && params.target === "daily") {
				return textResult("The shared tier holds MEMORY.md only. Write daily notes to project memory (scope project).");
			}
			if (scope === "core") {
				if (params.target !== "long_term") {
					return textResult("Core memory is one file: write it with scope 'core' and target 'long_term'.");
				}
				// Never queued, like /psm-core-memory: requireClient throws when the brain is
				// unreachable, and a rule the user believes was saved must not sit in an outbox.
				const res = await c.writeCore({ action: "append", content: params.content });
				if (res.deduped) {
					return textResult("Core memory already said that; the existing entry was updated in place.", { scope: "core", deduped: true });
				}
				return textResult("Added to core memory. It is loaded in every session, on every project.", { scope: "core" });
			}
			const ns = scope === "shared" ? SHARED : nsId();
			const body = {
				target: params.target,
				content: params.content,
				mode: params.mode,
				ns,
				agent: c.agentId,
				session: sessionTag(ctx),
				nsKey: activeNs?.key,
				nsLabel: activeNs?.label,
			};
			if (params.target === "long_term" && params.mode === "overwrite") {
				await c.writeNow({ path: "/v1/write", body });
				return textResult(`Overwrote ${ns}/MEMORY.md on the brain.`, { ns });
			}
			const res = await c.writeOrQueue({ path: "/v1/write", body });
			if (res.queued) {
				return textResult(
					"Brain unreachable; write queued and will be sent automatically. It appears in the local cache after the next successful sync.",
					{ queued: true, ns },
				);
			}
			if (res.result?.deduped) {
				return textResult(
					`Updated the existing entry in ${res.result.file}: this restated something already stored, so it replaced it rather than adding a near-copy.`,
					{ ns, deduped: true },
				);
			}
			return textResult(`Wrote to ${res.result?.file ?? params.target} on the brain.`, { ns });
		},
	});

	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: [
			"Read a memory file from the brain.",
			"Tiers:",
			"- 'project' (default): this repository's MEMORY.md, SCRATCHPAD.md or daily logs.",
			"- 'shared': the cross-project MEMORY.md, managed by agents.",
			"- 'core': the human-authored core memory (long_term only).",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "scratchpad", "daily", "list"] as const, { description: "What to read" }),
			scope: Type.Optional(
				StringEnum(["project", "shared", "core"] as const, { description: "Default: project" }),
			),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD for daily" })),
		}),
		async execute(_id, params) {
			const scope = params.scope ?? "project";
			if (scope === "core" && params.target !== "long_term") {
				return textResult("Core memory is a single file: read it with scope 'core' and target 'long_term'.");
			}
			const ns = scope === "core" ? "core" : scope === "shared" ? SHARED : nsId();
			const res = await readWithFallback(offlineCapableClient(), cacheRoot, params.target, { ns, date: params.date });
			let text = "";
			if (params.target === "list") {
				const raw = res.value.files;
				let files: string[] = [];
				if (Array.isArray(raw)) files = raw.map(String);
				if (files.length === 0) text = "No daily logs.";
				else text = files.join("\n");
			} else if (!String(res.value.content ?? "").trim()) {
				text = "(empty)";
			} else {
				text = String(res.value.content);
			}
			if (res.source === "cache") text = `${offlineNote(res.takenAt)}\n\n${text}`;
			return textResult(text, { source: res.source, takenAt: res.takenAt, ns, scope });
		},
	});

	pi.registerTool({
		name: "scratchpad",
		label: "Scratchpad",
		description: [
			"This project's checklist of things to fix later or keep in mind (stored on the brain, per repository). Actions:",
			"add (new unchecked item), done / undo (match by substring), clear_done, list.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const, { description: "What to do" }),
			text: Type.Optional(Type.String({ description: "Item text for add, or substring for done/undo" })),
		}),
		async execute(_id, params) {
			const c = requireClient();
			const body = { ...params, ns: nsId(), agent: c.agentId };
			let items: { done: boolean; text: string }[];
			if (params.action === "add") {
				const res = await c.writeOrQueue({ path: "/v1/scratchpad", body });
				if (res.queued) return textResult("Brain unreachable; item queued for the next sync.", { queued: true });
				items = res.result?.items ?? [];
			} else {
				items = (await c.writeNow({ path: "/v1/scratchpad", body })).items ?? [];
			}
			if (items.length === 0) return textResult("Scratchpad is empty.");
			return textResult(items.map((i) => `- [${mark(i.done)}] ${i.text}`).join("\n"));
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: [
			"Search memory on the brain. The default scope covers core memory, shared memory and this project.",
			"Results are labelled with the tier they came from, and never include another project.",
			"qmd powers the search when the brain has it installed:",
			"- mode 'keyword': BM25 full-text, fastest.",
			"- mode 'semantic' (default): vector similarity, finds paraphrases.",
			"- mode 'deep': hybrid plus LLM reranking, best quality but slower.",
			"Supports #tags and [[links]] as terms. If the brain is unreachable, the local",
			"cached copy is searched with BM25 instead and the result says so.",
		].join("\n"),
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default 5, max 20)" })),
			mode: Type.Optional(
				StringEnum(["keyword", "semantic", "deep"] as const, {
					description: "Search mode. Default: the brain's configured mode.",
				}),
			),
			scope: Type.Optional(
				StringEnum(["all", "project", "shared", "core"] as const, {
					description: "Default: all (core + shared + this project). Narrow it when you know where the answer should be.",
				}),
			),
		}),
		async execute(_id, params) {
			const res = await searchWithFallback(offlineCapableClient(), cacheRoot, params.query, params.limit ?? 5, {
				mode: params.mode,
				ns: nsId(),
				scope: params.scope ?? "all",
			});
			const lines: string[] = [];
			if (res.source === "cache") lines.push(offlineNote(res.takenAt));
			if (res.engine !== "qmd") lines.push(cacheLabel(res));
			if (res.note) lines.push(`(brain note: ${res.note})`);
			if (res.tiers && res.tiers.length > 0) lines.push(`(tiers searched: ${res.tiers.join(", ")})`);
			if (res.results.length === 0) lines.push("No matches.");
			else {
				lines.push(
					res.results
						.map((r, i) => `### ${i + 1}. [${r.tier ?? "project"}] ${r.file} (score ${r.score})\n${r.text}`)
						.join("\n\n"),
				);
			}
			return textResult(lines.join("\n\n"), {
				source: res.source,
				takenAt: res.takenAt,
				engine: res.engine,
				mode: res.mode,
				scope: res.scope,
				count: res.results.length,
			});
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Memory Forget",
		description: [
			"Delete paragraphs containing a substring from MEMORY.md (or a daily log) on the brain.",
			"Use when a stored fact is wrong, outdated, or not worth its tokens any more.",
			"Core memory is out of reach here: the user removes those with /psm-core-memory --remove.",
			"A recovery record is kept on the brain.",
		].join("\n"),
		parameters: Type.Object({
			match: Type.String({ description: "Case-insensitive substring identifying the entries to remove" }),
			target: Type.Optional(StringEnum(["long_term", "daily"] as const, { description: "Default: long_term" })),
			scope: Type.Optional(
				StringEnum(["project", "shared"] as const, { description: "Default: project" }),
			),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD when target is daily" })),
		}),
		async execute(_id, params) {
			const scope = params.scope ?? "project";
			const ns = scope === "shared" ? SHARED : nsId();
			const res = await requireClient().forget({
				match: params.match,
				target: params.target,
				date: params.date,
				ns,
			});
			if (!res.removed) return textResult("Nothing matched.", { ns, removed: 0 });
			return textResult(`Removed ${res.removed} paragraph(s) from ${ns}. Recovery id: ${res.recoveryId}`, {
				ns,
				removed: res.removed,
			});
		},
	});
}
