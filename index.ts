/**
 * pi-scale-memory — shared remote memory for pi agents over a private tailnet.
 *
 * Each agent runs a userspace tailscaled (no TUN device, no route changes,
 * SOCKS5 proxy only), joins the tailnet as `tag:agent`, finds the machine
 * tagged `tag:brain`, and reads/writes memory on it. Memory layout and tools
 * follow pi-memory (MEMORY.md, SCRATCHPAD.md, daily/*.md), but live on the brain.
 */
import * as os from "node:os";
import { type Message, StringEnum, Type } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { BrainClient } from "./src/client.js";
import { CONFIG_PATH, type Config, loadConfig, resetConfig, saveConfig } from "./src/config.js";
import { tailscaleInstalled, UserspaceTailnet } from "./src/tailnet.js";

const FLUSH_INTERVAL_MS = 30_000;
const PERIODIC_EVERY_TURNS = Number(process.env.PI_SCALE_MEMORY_SUMMARY_EVERY_TURNS ?? 15);
const SUMMARY_MIN_MESSAGES = 4;
const SUMMARY_MAX_CHARS = 60_000;
const SUMMARY_TIMEOUT_MS = 25_000;
const SUMMARY_SYSTEM_PROMPT =
	"You extract durable memory from coding-agent conversations. Be terse and factual. Output markdown only.";

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

function mark(done: boolean): string {
	if (done) return "x";
	return " ";
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

export default function (pi: ExtensionAPI) {
	const tailnet = new UserspaceTailnet();
	let client: BrainClient | null = null;
	let snapshot = "";
	let flushTimer: ReturnType<typeof setInterval> | null = null;
	let turnsSinceCapture = 0;
	let capturedMessageCount = 0;
	let connecting: Promise<void> | null = null;
	let lastError = "";

	const agentId = `${os.hostname().split(".")[0]}`;

	function status(ctx: ExtensionContext, text: string | undefined) {
		if (ctx.hasUI) ctx.ui.setStatus("scale-memory", text);
	}

	async function prompt(ctx: ExtensionContext, cfg: Config): Promise<boolean> {
		if (!ctx.hasUI) return false;
		const stored = loadConfig(false);
		if (stored.authKey === undefined && cfg.authKey === undefined) {
			const net = await ctx.ui.select("pi-scale-memory: which tailnet?", [
				"Tailscale (default control plane)",
				"Self-hosted (Headscale)",
			]);
			if (!net) return false;
			if (net.startsWith("Self-hosted")) {
				const url = await ctx.ui.input("Login server URL", "https://headscale.example.com");
				if (!url?.trim()) return false;
				stored.loginServer = url.trim();
			} else {
				stored.loginServer = undefined;
			}
			const key = await ctx.ui.input("Pre-auth key (tagged tag:agent, reusable)", "tskey-auth-...");
			if (!key?.trim()) return false;
			stored.authKey = key.trim();
			saveConfig(stored);
			cfg.loginServer = stored.loginServer;
			cfg.authKey = stored.authKey;
		}
		return true;
	}

	async function connect(ctx: ExtensionContext): Promise<void> {
		if (!(await tailscaleInstalled())) {
			lastError = "tailscale/tailscaled not found in PATH";
			if (ctx.hasUI) ctx.ui.notify("pi-scale-memory: install Tailscale (tailscale + tailscaled) first.", "error");
			return;
		}
		const cfg = loadConfig();
		if (!cfg.authKey && !(await prompt(ctx, cfg))) {
			lastError = "not configured";
			return;
		}
		status(ctx, "brain: joining tailnet…");
		try {
			await tailnet.start({ loginServer: cfg.loginServer, authKey: cfg.authKey as string });
			client = new BrainClient(tailnet, cfg.brainPort, cfg.brainToken ?? "", agentId);
			status(ctx, "brain: searching…");
			if (!(await client.discover())) throw new Error("no online machine tagged tag:brain");
			await client.health();
			snapshot = await client.context();
			lastError = "";
			status(ctx, `brain: ${client.brainName}`);
			if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: connected to brain "${client.brainName}"`, "info");
		} catch (err) {
			lastError = errMsg(err);
			status(ctx, "brain: offline");
			if (ctx.hasUI) ctx.ui.notify(`pi-scale-memory: ${lastError}`, "warning");
		}
	}

	function sessionTag(ctx: ExtensionContext): string {
		return ctx.sessionManager.getSessionId().slice(0, 8);
	}

	function notConnected(): string {
		if (lastError) return `Brain not connected: ${lastError}`;
		return "Brain not connected";
	}

	function requireClient(): BrainClient {
		if (!client) throw new Error(`${notConnected()}. Try /brain reconnect.`);
		return client;
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
		else if (typeof registry?.getApiKeyForProvider === "function") apiKey = await registry.getApiKeyForProvider(model.provider);
		if (!apiKey) return null;

		let text = serializeConversation(convertToLlm(fresh)).trim();
		if (!text) return null;
		if (text.length > SUMMARY_MAX_CHARS) text = text.slice(-SUMMARY_MAX_CHARS);
		const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: summaryPrompt(text) }], timestamp: Date.now() }];
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
		}, FLUSH_INTERVAL_MS);
		flushTimer.unref();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (flushTimer) {
			clearInterval(flushTimer);
			flushTimer = null;
		}
		const reason = (event as { reason?: string }).reason;
		const transition = reason === "reload" || reason === "new" || reason === "resume" || reason === "fork";
		if (client && !transition) {
			try {
				await capture(ctx, "exit");
				await client.flush();
			} catch {
				/* best effort */
			}
		}
		if (!transition) {
			await tailnet.stop();
			client = null;
		}
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
			/* keep old snapshot */
		}
	});

	// --- /brain command ---
	pi.registerCommand("brain", {
		description: "pi-scale-memory: status | reconnect | reset",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
			if (sub === "reset") {
				await tailnet.stop();
				client = null;
				resetConfig();
				ctx.ui.notify(`Config removed (${CONFIG_PATH}). Use /brain reconnect to set up again.`, "info");
				return;
			}
			if (sub === "reconnect") {
				await tailnet.stop();
				client = null;
				await connect(ctx);
				return;
			}
			if (!client) {
				ctx.ui.notify(notConnected(), "warning");
				return;
			}
			let health = "unreachable";
			try {
				await client.health();
				health = "ok";
			} catch (e) {
				health = errMsg(e);
			}
			ctx.ui.notify(
				`Brain: ${client.brainName} (${client.brainIp ?? "?"}) health=${health} queued=${client.pending} node=${tailnet.hostname}`,
				"info",
			);
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
			target: StringEnum(["long_term", "daily"] as const, { description: "'long_term' for MEMORY.md, 'daily' for today's log" }),
			content: Type.String({ description: "Content to write (Markdown)" }),
			mode: Type.Optional(StringEnum(["append", "overwrite"] as const, { description: "long_term only. Default: append" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const c = requireClient();
			const body = { ...params, agent: c.agentId, session: sessionTag(ctx) };
			if (params.target === "long_term" && params.mode === "overwrite") {
				await c.writeNow({ path: "/v1/write", body });
				return textResult("Overwrote MEMORY.md on the brain.");
			}
			const res = await c.writeOrQueue({ path: "/v1/write", body });
			if (res.queued) return textResult("Brain unreachable; write queued and will be sent automatically.", { queued: true });
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
			const res = await requireClient().read(params.target, params.date);
			if (params.target === "list") {
				const files: string[] = res.files ?? [];
				if (files.length === 0) return textResult("No daily logs.");
				return textResult(files.join("\n"));
			}
			if (!res.content?.trim()) return textResult("(empty)");
			return textResult(res.content);
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
				if (res.queued) return textResult("Brain unreachable; item queued.", { queued: true });
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
		description:
			"Search all shared memory on the brain (MEMORY.md, SCRATCHPAD.md, daily logs) using BM25 keyword ranking. Supports #tags and [[links]] as terms.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default 5, max 20)" })),
		}),
		async execute(_id, params) {
			const results = await requireClient().search(params.query, params.limit ?? 5);
			if (results.length === 0) return textResult("No matches.");
			const out = results.map((r, i) => `### ${i + 1}. ${r.file} (score ${r.score})\n${r.text}`);
			return textResult(out.join("\n\n"), { count: results.length });
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
