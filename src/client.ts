import * as http from "node:http";
import { socksHttp } from "./socks.js";

export interface SearchHit {
	file: string;
	score: number;
	text: string;
	line?: number | null;
	/** Which tier answered: core, shared, or the project namespace. */
	tier?: string;
	collection?: string;
}

export interface SearchResponse {
	engine: string;
	mode: string;
	results: SearchHit[];
	note?: string;
	scope?: string;
	tiers?: string[];
}

/** The scopes a caller may ask for. `all` covers core plus shared plus the project. */
export type SearchScope = "all" | "project" | "shared" | "core" | "legacy";

export interface TierFiles {
	files: Record<string, string>;
}

/** The mirror payload: both cross-project tiers, plus one project when one is named. */
export interface Snapshot {
	takenAt: string;
	ns: string | null;
	core: TierFiles;
	shared: TierFiles;
	project: (TierFiles & { id: string }) | null;
}

export interface NamespaceEntry {
	id: string;
	label: string;
	key: string | null;
	archived: boolean;
	agents: string[];
	lastSeen: string | null;
	memory: number;
	scratchpad: number;
	daily: number;
	dailyFiles: number;
	lastWrite: string;
}

export interface NamespaceListing {
	active: string | null;
	default: string;
	core: { memory: number; scratchpad: number; daily: number; dailyFiles: number; lastWrite: string };
	shared: { memory: number; scratchpad: number; daily: number; dailyFiles: number; lastWrite: string };
	namespaces: NamespaceEntry[];
}

export interface BrainHealth {
	ok: boolean;
	role: string;
	date: string;
	/** Present on a brain that understands tiers; absent on the flat v0.1 brain. */
	scopes?: string[];
	defaultNs?: string;
	core?: boolean;
	search?: {
		engine: string;
		mode: string;
		collections?: string[];
		ready: boolean;
		indexing: boolean;
		update: string;
	};
}

export interface WriteRequest {
	path: string;
	body: Record<string, unknown>;
}

export interface TransportRequest {
	method: "GET" | "POST";
	path: string;
	headers: Record<string, string>;
	body?: string;
}

/**
 * Backoff for a brain that is not answering yet.
 *
 * A few tries is the right size for this. A node that has just joined needs a moment
 * to find paths to its peers, and a brain that was reset comes back under a new
 * address, so a single attempt gives up inside a window that closes on its own.
 * Beyond that, the cause is usually something only the user can change — no brain
 * running yet, the wrong port, a machine that is asleep — and a loop that retries
 * forever hides that instead of reporting it.
 */
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000];

/** How many times an agent retries on its own before it stops and asks the user. */
export const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;

/** Delay before retry number `attempt` (0 is the first retry). */
export function retryDelayMs(attempt: number): number {
	if (attempt < 0) return RETRY_DELAYS_MS[0];
	if (attempt >= RETRY_DELAYS_MS.length) return RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
	return RETRY_DELAYS_MS[attempt];
}

/** Moves one HTTP request to the brain, either over loopback or through the tailnet SOCKS5 proxy. */
export interface BrainTransport {
	(host: string, port: number, req: TransportRequest, timeoutMs?: number): Promise<{ status: number; body: string }>;
}

export function localTransport(): BrainTransport {
	return (host, port, req, timeoutMs) =>
		new Promise((resolve, reject) => {
			const request = http.request(
				{ host, port, method: req.method, path: req.path, headers: req.headers, timeout: timeoutMs ?? 15000 },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
				},
			);
			request.on("timeout", () => request.destroy(new Error("request timed out")));
			request.on("error", reject);
			if (req.body !== undefined) request.write(req.body);
			request.end();
		});
}

export function tailnetTransport(socksPort: number): BrainTransport {
	return (host, port, req, timeoutMs) =>
		socksHttp({
			proxyPort: socksPort,
			host,
			port,
			method: req.method,
			path: req.path,
			headers: req.headers,
			body: req.body,
			timeoutMs,
		});
}

export interface BrainClientOptions {
	/** Fixed host (local brain) or empty when the host is discovered through resolveHost. */
	host: string;
	port: number;
	token: string;
	agentId: string;
	transport: BrainTransport;
	/** Tailnet mode: look the brain up by tag. Omit for a fixed host. */
	resolveHost?: () => Promise<string | null>;
}

export class BrainClient {
	private host: string;
	private name = "";

	constructor(private opts: BrainClientOptions) {
		this.host = opts.host;
	}

	get agentId(): string {
		return this.opts.agentId;
	}

	get brainIp(): string | null {
		if (!this.host) return null;
		return this.host;
	}

	get brainName(): string {
		if (this.name) return this.name;
		if (this.host) return this.host;
		return "unknown";
	}

	get connected(): boolean {
		if (!this.opts.resolveHost) return true;
		return this.host.length > 0;
	}

	/** Tailnet mode: resolve (or re-resolve) the brain by tag. */
	async discover(waitMs = 30000): Promise<boolean> {
		if (!this.opts.resolveHost) return true;
		const deadline = Date.now() + waitMs;
		for (;;) {
			const host = await this.opts.resolveHost();
			if (host) {
				this.host = host;
				return true;
			}
			if (Date.now() >= deadline) break;
			await new Promise((r) => setTimeout(r, 2000));
		}
		this.host = "";
		return false;
	}

	setName(name: string): void {
		this.name = name;
	}

	private async hostFor(): Promise<string> {
		if (this.host) return this.host;
		if (!this.opts.resolveHost) throw new Error("brain host is not set");
		const host = await this.opts.resolveHost();
		if (!host) throw new Error("no peer answered as the brain");
		this.host = host;
		return host;
	}

	private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
		const host = await this.hostFor();
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
		let payload: string | undefined;
		if (body !== undefined) payload = JSON.stringify(body);

		let res: { status: number; body: string };
		try {
			res = await this.opts.transport(host, this.opts.port, { method, path, headers, body: payload });
		} catch (err) {
			// Tailnet mode: force re-discovery so a moved brain recovers on the next call.
			if (this.opts.resolveHost) this.host = "";
			throw err;
		}
		let json: any = {};
		try {
			json = JSON.parse(res.body);
		} catch {
			/* non-JSON body */
		}
		if (res.status >= 400) throw new Error(`brain ${res.status}: ${json.error ?? res.body}`);
		return json;
	}

	health(): Promise<BrainHealth> {
		return this.call("GET", "/v1/health");
	}

	async context(ns?: string | null): Promise<string> {
		const q = new URLSearchParams();
		if (ns) q.set("ns", ns);
		const suffix = q.toString();
		const res = await this.call("GET", `/v1/context${suffix ? `?${suffix}` : ""}`);
		return res.context ?? "";
	}

	/** Cross-project tiers plus one project, for the agent-side offline mirror. */
	snapshot(ns?: string | null): Promise<Snapshot> {
		const q = new URLSearchParams();
		if (ns) q.set("ns", ns);
		const suffix = q.toString();
		return this.call("GET", `/v1/snapshot${suffix ? `?${suffix}` : ""}`) as Promise<Snapshot>;
	}

	async read(target: string, opts: { ns?: string | null; date?: string } = {}): Promise<any> {
		const q = new URLSearchParams({ target });
		if (opts.ns) q.set("ns", opts.ns);
		if (opts.date) q.set("date", opts.date);
		return this.call("GET", `/v1/read?${q}`);
	}

	readCore(): Promise<{ content: string }> {
		return this.call("GET", "/v1/core");
	}

	/** The only writer to core memory. Reached only from the /core-memory command. */
	writeCore(body: { action: "append" | "remove" | "list"; content?: string; match?: string }): Promise<any> {
		return this.call("POST", "/v1/core", body);
	}

	namespaces(ns?: string | null): Promise<NamespaceListing> {
		const q = new URLSearchParams();
		if (ns) q.set("ns", ns);
		const suffix = q.toString();
		return this.call("GET", `/v1/namespaces${suffix ? `?${suffix}` : ""}`) as Promise<NamespaceListing>;
	}

	mergeNamespaces(from: string, into: string): Promise<any> {
		return this.call("POST", "/v1/ns/merge", { from, into });
	}

	async search(
		query: string,
		limit: number,
		mode?: string,
		opts: { ns?: string | null; scope?: SearchScope } = {},
	): Promise<SearchResponse> {
		const q = new URLSearchParams({ q: query, limit: String(limit) });
		if (mode) q.set("mode", mode);
		if (opts.ns) q.set("ns", opts.ns);
		if (opts.scope) q.set("scope", opts.scope);
		const res = await this.call("GET", `/v1/search?${q}`);
		return {
			engine: String(res.engine ?? "bm25"),
			mode: String(res.mode ?? "keyword"),
			results: res.results ?? [],
			note: res.note,
			scope: res.scope,
			tiers: res.tiers,
		};
	}

	forget(body: Record<string, unknown>) {
		return this.call("POST", "/v1/forget", body);
	}

	/** Append-style write: sent now, or queued for the periodic flush when the brain is unreachable. */
	async writeOrQueue(req: WriteRequest): Promise<{ queued: boolean; result?: any }> {
		try {
			return { queued: false, result: await this.call("POST", req.path, req.body) };
		} catch (err) {
			if (err instanceof Error && /^brain 4\d\d/.test(err.message)) throw err;
			this.outbox.push(req);
			return { queued: true };
		}
	}

	/** Send a write that must not be silently queued (overwrite, list). */
	writeNow(req: WriteRequest) {
		return this.call("POST", req.path, req.body);
	}

	get pending(): number {
		return this.outbox.length;
	}

	async flush(): Promise<number> {
		let sent = 0;
		while (this.outbox.length > 0) {
			const req = this.outbox[0];
			try {
				await this.call("POST", req.path, req.body);
			} catch (err) {
				if (!(err instanceof Error && /^brain 4\d\d/.test(err.message))) break;
			}
			this.outbox.shift();
			sent++;
		}
		return sent;
	}

	private outbox: WriteRequest[] = [];
}
