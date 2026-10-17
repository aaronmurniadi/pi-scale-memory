/**
 * pi-scale-memory — one shared memory for many pi agents, over Tailscale.
 *
 * Roles (/self-tag):
 *   brain — runs the memory server on loopback, is tagged tag:brain, and publishes
 *           it to the internet with Tailscale Funnel (/setup-funnel).
 *   agent — uses its own userspace tailscaled (no TUN device, no route changes,
 *           SOCKS5 proxy only) so joining a tailnet leaves the machine's system
 *           Tailscale alone. It either discovers the brain by tag or talks to the
 *           public Funnel URL, and mirrors the memory for offline reads.
 *
 * Commands:
 *   /self-tag               — set this pi agent's role (brain or agent)
 *   /setup-funnel           — brain only: token, join, publish, print the URL
 *   /generate-preauth       — brain only: mint a tag:agent key via the Tailscale API
 *   /join-tailnet           — agent: join the tailnet, or point at a public brain URL
 *   /brain                  — status | sync | reindex | reconnect | reset
 *   /update-pi-scale-memory — update the extension itself, then reload
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
import { BrainClient, localTransport, parseBrainUrl, publicTransport, tailnetTransport } from "./src/client.js";
import {
	CONFIG_DIR,
	CONFIG_PATH,
	type Config,
	loadConfig,
	resetConfig,
	type Role,
	saveConfig,
	updateConfig,
} from "./src/config.js";
import { createAuthKey } from "./src/apikeys.js";
import { brainLogPath, ensureBrainServer, stopBrainServer } from "./src/brain-server.js";
import { runFunnelSetup } from "./src/funnel.js";
import { inspectInstall, runUpdate } from "./src/update.js";
import { AGENT_TAG, tailscaleInstalled, UserspaceTailnet, type BrainPeer } from "./src/tailnet.js";
import type { Ui } from "./src/ui.js";

const FLUSH_INTERVAL_MS = 30_000;
/** How often an agent refreshes its offline mirror of the brain. */
const CACHE_SYNC_MS = Number(process.env.PI_SCALE_MEMORY_CACHE_SYNC_MS ?? 60_000);
const PERIODIC_EVERY_TURNS = Number(process.env.PI_SCALE_MEMORY_SUMMARY_EVERY_TURNS ?? 15);
const SUMMARY_MIN_MESSAGES = 4;
const SUMMARY_MAX_CHARS = 60_000;
const SUMMARY_TIMEOUT_MS = 25_000;
const SUMMARY_SYSTEM_PROMPT =
	"You extract durable memory from coding-agent conversations. Be terse and factual. Output markdown only.";
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));

function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

/** "90d" / "24h" / "30m" / "45s" -> seconds. Bare numbers are seconds. */
export function parseDurationSeconds(text: string): number | null {
	const match = text.trim().match(/^(\d+)\s*([smhdw])?$/i);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	let unit = "s";
	if (match[2]) unit = match[2].toLowerCase();
	let factor = 1;
	if (unit === "m") factor = 60;
	else if (unit === "h") factor = 3600;
	else if (unit === "d") factor = 86400;
	else if (unit === "w") factor = 604800;
	return value * factor;
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
	const tailnet = new UserspaceTailnet();
	let client: BrainClient | null = null;
	let snapshot = "";
	let flushTimer: ReturnType<typeof setInterval> | null = null;
	let turnsSinceCapture = 0;
	let capturedMessageCount = 0;
	let connecting: Promise<void> | null = null;
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
			const meta = await syncCache(client, cacheRoot);
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
		const cached = await contextWithFallback(null, cacheRoot);
		snapshot = cached.value;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`pi-scale-memory: brain unreachable, using cached memory taken ${cached.takenAt ?? "earlier"}. Reads work; writes are queued.`,
				"warning",
			);
		}
	}

	function requireClient(): BrainClient {
		if (!client) throw new Error(`${notConnected()}. Run /brain reconnect.`);
		return client;
	}

	function sessionTag(ctx: ExtensionContext): string {
		return ctx.sessionManager.getSessionId().slice(0, 8);
	}

	// --- brain role: the local memory server on loopback ---

	async function connectLocal(ctx: ExtensionContext, cfg: Config): Promise<void> {
		status(ctx, "brain: local");
		try {
			const server = await ensureBrainServer(
				EXT_DIR,
				{ port: cfg.brainPort, token: cfg.brainToken ?? "" },
				(message) => {
					if (ctx.hasUI) ctx.ui.notify(message, "info");
				},
			);
			if (!server.ok) throw new Error(server.detail);
			client = new BrainClient({
				host: "127.0.0.1",
				port: cfg.brainPort,
				token: cfg.brainToken ?? "",
				agentId,
				transport: localTransport(),
			});
			await client.health();
			snapshot = await client.context();
			lastError = "";
			let where = `local server on port ${cfg.brainPort}`;
			if (cfg.funnelUrl) where += `, public at ${cfg.funnelUrl}`;
			status(ctx, `brain: ${where}`);
			if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: brain role, using the local brain server (log: ${brainLogPath()})`, "info");
		} catch (err) {
			lastError = errMsg(err);
			status(ctx, "brain: offline");
			if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: ${lastError}`, "warning");
		}
	}

	// --- agent role: userspace tailscaled + brain discovery by tag ---

	async function discoverBrain(tailnetClient: UserspaceTailnet): Promise<string | null> {
		const peer: BrainPeer | null = await tailnetClient.findBrain();
		if (!peer) return null;
		if (!peer.online) return null;
		return peer.ip;
	}

	/** Agent mode without a tailnet: talk straight to the public Funnel URL. */
	async function connectPublic(ctx: ExtensionContext, cfg: Config, url: string): Promise<void> {
		status(ctx, "brain: public url…");
		try {
			const target = parseBrainUrl(url);
			const candidate = new BrainClient({
				host: target.host,
				port: target.port,
				token: cfg.brainToken ?? "",
				agentId,
				transport: publicTransport(),
			});
			await candidate.health();
			client = candidate;
			snapshot = await candidate.context();
			lastError = "";
			status(ctx, `brain: ${target.host}`);
			if (ctx.ui && ctx.hasUI) ctx.ui.notify(`pi-scale-memory: connected to the brain at ${url}`, "info");
		} catch (err) {
			lastError = errMsg(err);
			status(ctx, "brain: offline");
			if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: ${lastError}`, "warning");
		}
	}

	async function connectAgent(ctx: ExtensionContext, cfg: Config): Promise<void> {
		if (cfg.brainUrl) {
			await connectPublic(ctx, cfg, cfg.brainUrl);
			return;
		}
		if (!(await tailscaleInstalled())) {
			lastError = "tailscale/tailscaled not found in PATH";
			if (ctx.hasUI) ctx.ui.notify("pi-scale-memory: install Tailscale (tailscale + tailscaled) first.", "error");
			return;
		}
		if (!cfg.authKey && !cfg.loginServer) {
			lastError = "not joined yet";
			status(ctx, "brain: not joined");
			if (ctx.hasUI) ctx.ui.notify("pi-scale-memory: run /join-tailnet to join a tailnet or set a public brain URL.", "warning");
			return;
		}
		status(ctx, "brain: joining tailnet…");
		try {
			await tailnet.start({ loginServer: cfg.loginServer, authKey: cfg.authKey ?? "" });
			const candidate = new BrainClient({
				host: "",
				port: cfg.brainPort,
				token: cfg.brainToken ?? "",
				agentId,
				transport: tailnetTransport(tailnet),
				resolveHost: () => discoverBrain(tailnet),
			});
			status(ctx, "brain: searching…");
			if (!(await candidate.discover())) throw new Error("no online machine tagged tag:brain");
			await candidate.health();
			client = candidate;
			snapshot = await client.context();
			lastError = "";
			await syncCacheNow(ctx, cfg, true);
			status(ctx, `brain: ${client.brainName}`);
			if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: connected to brain ${client.brainName}`, "info");
		} catch (err) {
			lastError = errMsg(err);
			status(ctx, "brain: offline");
			if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: ${lastError}`, "warning");
		}
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
		await tailnet.stop();
		client = null;
		snapshot = "";
		lastError = "";
	}

	// --- periodic summaries stored to the brain ---

	async function summarize(ctx: ExtensionContext): Promise<string | null> {
		const branch = ctx.sessionManager.getBranch();
		const messages = branch.flatMap((e) => {
			if (e.type === "message") return [e.message];
			return [];
		});
		const fresh = messages.slice(capturedMessageCount);
		if (fresh.length < SUMMARY_MIN_MESSAGES) return null;
		const model = ctx.model;
		if (!model) return null;
		const registry = ctx.modelRegistry as any;
		let apiKey: string | undefined;
		if (typeof registry?.getApiKey === "function") apiKey = await registry.getApiKey(model);
		else if (typeof registry?.getApiKeyForProvider === "function") {
			apiKey = await registry.getApiKeyForProvider(model.provider);
		}
		if (!apiKey) return null;

		let text = serializeConversation(convertToLlm(fresh)).trim();
		if (!text) return null;
		if (text.length > SUMMARY_MAX_CHARS) text = text.slice(-SUMMARY_MAX_CHARS);
		const msgs: Message[] = [
			{ role: "user", content: [{ type: "text", text: summaryPrompt(text) }], timestamp: Date.now() },
		];
		try {
			const res = await complete(model, { systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: msgs }, { apiKey });
			const out = res.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();
			capturedMessageCount = messages.length;
			if (!out || isEmptySummary(out)) return null;
			return out;
		} catch {
			return null;
		}
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
					content: `## Session Summary (auto, ${label})\n\n${summary}`,
					agent: client.agentId,
					session: sessionTag(ctx),
				},
			});
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	// --- lifecycle ---
	pi.on("session_start", async (_event, ctx) => {
		turnsSinceCapture = 0;
		capturedMessageCount = 0;
		if (flushTimer) clearInterval(flushTimer);
		if (!connecting) {
			connecting = connect(ctx).finally(() => {
				connecting = null;
			});
		}
		await connecting;
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
		const header = [
			"\n\n## Memory (shared brain)",
			"(Loaded once at session start from the shared brain; other agents may have written since. Use memory_read / memory_search for the latest.)",
			"Use memory_write to persist important information; it is stored remotely and shared by all agents.",
			"- Decisions, preferences, durable facts → MEMORY.md (memory_write long_term)",
			"- Day-to-day notes → daily log (memory_write daily)",
			"- Things to fix later → scratchpad tool",
			"- Use #tags and [[links]] in content to improve search recall.",
			'- If someone says "remember this," write it immediately.',
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
			snapshot = await client.context();
		} catch {
			/* keep the previous snapshot */
		}
	});

	// --- /brain ---
	pi.registerCommand("brain", {
		description: "pi-scale-memory: status | sync | reconnect | reset",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
			if (sub === "reset") {
				await disconnect();
				resetConfig();
				ctx.ui.notify(`Config removed (${CONFIG_PATH}). Use /self-tag and /join-tailnet to set up again.`, "info");
				return;
			}
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
					const meta = await syncCache(client, cacheRoot);
					ctx.ui.notify(`Cache refreshed: ${meta.files} file(s) taken ${meta.takenAt} in ${cacheRoot}`, "info");
				} catch (e) {
					ctx.ui.notify(`Cache sync failed: ${errMsg(e)}`, "error");
				}
				return;
			}
			if (sub === "reindex") {
				if (!client) {
					ctx.ui.notify(`${notConnected()} — the brain owns the search index.`, "warning");
					return;
				}
				try {
					const h = await client.health();
					ctx.ui.notify(
						`Brain search: engine=${h.search?.engine ?? "?"} mode=${h.search?.mode ?? "?"} collection=${h.search?.collection ?? "?"} indexing=${h.search?.indexing ?? "?"}`,
						"info",
					);
				} catch (e) {
					ctx.ui.notify(`Could not read brain search state: ${errMsg(e)}`, "error");
				}
				return;
			}
			if (sub === "reconnect") {
				await disconnect();
				await connect(ctx);
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
			ctx.ui.notify(
				`Role: ${cfg.role ?? "unset"} | brain: ${client.brainName} (${where}) health=${health} search=${search} queued=${client.pending} | ${cacheInfo} | node: ${tailnet.hostname || "n/a"}`,
				"info",
			);
		},
	});

	// --- /self-tag ---
	pi.registerCommand("self-tag", {
		description: "Set this pi agent's role: brain (hosts memory) or agent (uses memory)",
		handler: async (args, ctx) => {
			const current = loadConfig(false).role;
			const arg = (args ?? "").trim().toLowerCase();
			let role: Role | null = null;
			if (arg === "brain" || arg === "agent") {
				role = arg;
			} else {
				const picked = await ctx.ui.select("Tag this pi agent as:", ["brain", "agent"]);
				if (!picked) return;
				if (picked === "brain" || picked === "agent") role = picked;
			}
			if (!role) return;
			updateConfig({ role });
			await disconnect();
			await connect(ctx);
			if (role === "brain") {
				ctx.ui.notify(
					"This pi agent is the brain: memory is served locally. Next: /setup-headscale to host the tailnet, then /generate-preauth for agent keys.",
					"info",
				);
				return;
			}
			ctx.ui.notify("This pi agent is an agent: memory comes from the machine tagged tag:brain. Next: /join-tailnet.", "info");
			if (current === "brain") ctx.ui.notify("Note: the local brain server keeps running if you started it.", "info");
		},
	});

	// --- /setup-funnel (brain only) ---
	pi.registerCommand("setup-funnel", {
		description: "Brain only: publish the memory API through Tailscale Funnel and print its URL",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(false);
			if (cfg.role !== "brain") {
				ctx.ui.notify("Only a brain publishes a funnel. Run /self-tag brain first.", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive setup requires the terminal UI.", "error");
				return;
			}
			await runFunnelSetup(uiFrom(ctx), EXT_DIR, cfg);
			await disconnect();
			await connect(ctx);
		},
	});

	// --- /join-tailnet ---
	pi.registerCommand("join-tailnet", {
		description: "Agent: join the tailnet as tag:agent, or point at a public brain URL",
		handler: async (_args, ctx) => {
			const mode = await ctx.ui.select("How should this agent reach the brain?", [
				"Join the tailnet as tag:agent (discover the brain by tag)",
				"Use a public brain URL (Funnel)",
			]);
			if (!mode) return;

			if (mode.startsWith("Use a public")) {
				const stored = loadConfig(false);
				const answer = await ctx.ui.input("Brain URL", stored.brainUrl ?? stored.funnelUrl ?? "https://brain.tailnet.ts.net");
				if (!answer?.trim()) return;
				let target: { host: string; port: number };
				try {
					target = parseBrainUrl(answer.trim());
				} catch (err) {
					ctx.ui.notify(errMsg(err), "error");
					return;
				}
				let token = stored.brainToken ?? "";
				if (!token) {
					const entered = await ctx.ui.input("Brain token", "from /setup-funnel on the brain");
					if (!entered?.trim()) return;
					token = entered.trim();
				}
				const url = answer.trim().replace(/\/+$/, "");
				updateConfig({ role: "agent", brainUrl: url, brainToken: token, authKey: undefined, loginServer: undefined });
				ctx.ui.notify(`Saved. Connecting to ${target.host}:${target.port}…`, "info");
				await disconnect();
				await connect(ctx);
				return;
			}

			const stored = loadConfig(false).authKey;
			let authKey = "";
			if (stored) {
				const keySource = await ctx.ui.select("Pre-auth key", ["Use the stored key", "Enter a new key"]);
				if (!keySource) return;
				if (keySource.startsWith("Use the stored")) authKey = stored;
			}
			if (!authKey) {
				const entered = await ctx.ui.input("Tailscale pre-auth key tagged tag:agent", "tskey-auth-...");
				if (!entered?.trim()) return;
				authKey = entered.trim();
			}
			updateConfig({ role: "agent", authKey, brainUrl: undefined });
			ctx.ui.notify("Saved. Joining as tag:agent…", "info");
			await disconnect();
			await connect(ctx);
		},
	});

	// --- /generate-preauth (brain only) ---
	pi.registerCommand("generate-preauth", {
		description: "Brain only: mint a tag:agent auth key through the Tailscale API",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(false);
			if (cfg.role !== "brain") {
				ctx.ui.notify("Only a brain mints agent keys. Run /self-tag brain first.", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive setup requires the terminal UI.", "error");
				return;
			}

			let apiToken = cfg.tailscaleApiToken ?? "";
			if (!apiToken) {
				const entered = await ctx.ui.input("Tailscale API access token (scope auth_keys)", "tskey-api-...");
				if (!entered?.trim()) {
					ctx.ui.notify(
						
"Create one at https://login.tailscale.com/admin/settings/keys (auth_keys scope), or create the agent key by hand in the admin console.",

						"warning",
					);
					return;
				}
				apiToken = entered.trim();
			}

			const expiry = await ctx.ui.input("Key expiry (e.g. 90d, 24h, 1h)", "90d");
			if (!expiry?.trim()) return;
			const seconds = parseDurationSeconds(expiry.trim());
			if (seconds === null) {
				ctx.ui.notify(`Could not read "${expiry.trim()}" as a duration. Try 30d, 24h or 1h.`, "error");
				return;
			}

			const scope = await ctx.ui.select("Key scope", [
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

			try {
				const created = await createAuthKey({
					apiToken,
					tags: [AGENT_TAG],
					reusable,
					ephemeral,
					preauthorized: true,
					expirySeconds: seconds,
				});
				updateConfig({ tailscaleApiToken: apiToken });
				ctx.ui.notify(
					[
						`Tailscale auth key for agents (${AGENT_TAG}):`,
						"",
						created.key,
						"",
						`Expires ${created.expires}. reusable=${created.reusable}, ephemeral=${created.ephemeral}.`,
						"On each agent: /join-tailnet → join the tailnet, then paste this key.",
					].join("\n"),
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`Could not create the key: ${errMsg(err)}`, "error");
			}
		},
	});

	// --- /update-pi-scale-memory ---
	pi.registerCommand("update-pi-scale-memory", {
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
			"Write to the shared remote memory (the brain). Two targets:",
			"- 'long_term': MEMORY.md (curated durable facts, decisions, preferences). Mode: 'append' or 'overwrite'.",
			"- 'daily': append to today's daily log (daily/<YYYY-MM-DD>.md).",
			"Use this when the user asks you to remember something, or when you learn important preferences/decisions.",
			"Use #tags (#decision, #preference, #lesson, #bug) and [[links]] in content to improve searchability.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "daily"] as const, {
				description: "'long_term' for MEMORY.md, 'daily' for today's log",
			}),
			content: Type.String({ description: "Content to write (Markdown)" }),
			mode: Type.Optional(
				StringEnum(["append", "overwrite"] as const, { description: "long_term only. Default: append" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const c = requireClient();
			const body = { ...params, agent: c.agentId, session: sessionTag(ctx) };
			if (params.target === "long_term" && params.mode === "overwrite") {
				await c.writeNow({ path: "/v1/write", body });
				return textResult("Overwrote MEMORY.md on the brain.");
			}
			const res = await c.writeOrQueue({ path: "/v1/write", body });
			if (res.queued) {
				return textResult(
					"Brain unreachable; write queued and will be sent automatically. It appears in the local cache after the next successful sync.",
					{ queued: true },
				);
			}
			return textResult(`Wrote to ${res.result?.file ?? params.target} on the brain.`);
		},
	});

	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: [
			"Read a shared memory file from the brain.",
			"- 'long_term': MEMORY.md",
			"- 'scratchpad': SCRATCHPAD.md",
			"- 'daily': a daily log (pass date YYYY-MM-DD, default today)",
			"- 'list': list daily log dates",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "scratchpad", "daily", "list"] as const, { description: "What to read" }),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD for daily" })),
		}),
		async execute(_id, params) {
			const res = await readWithFallback(offlineCapableClient(), cacheRoot, params.target, params.date);
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
			return textResult(text, { source: res.source, takenAt: res.takenAt });
		},
	});

	pi.registerTool({
		name: "scratchpad",
		label: "Scratchpad",
		description: [
			"Shared checklist of things to fix later or keep in mind (stored on the brain). Actions:",
			"add (new unchecked item), done / undo (match by substring), clear_done, list.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const, { description: "What to do" }),
			text: Type.Optional(Type.String({ description: "Item text for add, or substring for done/undo" })),
		}),
		async execute(_id, params) {
			const c = requireClient();
			const body = { ...params, agent: c.agentId };
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
			"Search all shared memory on the brain (MEMORY.md, SCRATCHPAD.md, daily logs).",
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
		}),
		async execute(_id, params) {
			const res = await searchWithFallback(
				offlineCapableClient(),
				cacheRoot,
				params.query,
				params.limit ?? 5,
				params.mode,
			);
			const lines: string[] = [];
			if (res.source === "cache") lines.push(offlineNote(res.takenAt));
			if (res.engine !== "qmd") lines.push(cacheLabel(res));
			if (res.note) lines.push(`(brain note: ${res.note})`);
			if (res.results.length === 0) lines.push("No matches.");
			else lines.push(res.results.map((r, i) => `### ${i + 1}. ${r.file} (score ${r.score})\n${r.text}`).join("\n\n"));
			return textResult(lines.join("\n\n"), {
				source: res.source,
				takenAt: res.takenAt,
				engine: res.engine,
				mode: res.mode,
				count: res.results.length,
			});
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Memory Forget",
		description:
			"Delete paragraphs containing a substring from MEMORY.md (or a daily log) on the brain. Use when a stored fact is wrong or outdated. A recovery record is kept on the brain.",
		parameters: Type.Object({
			match: Type.String({ description: "Case-insensitive substring identifying the entries to remove" }),
			target: Type.Optional(StringEnum(["long_term", "daily"] as const, { description: "Default: long_term" })),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD when target is daily" })),
		}),
		async execute(_id, params) {
			const res = await requireClient().forget(params);
			if (!res.removed) return textResult("Nothing matched.");
			return textResult(`Removed ${res.removed} paragraph(s). Recovery id: ${res.recoveryId}`);
		},
	});
}
