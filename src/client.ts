import * as http from "node:http";
import { socksHttp } from "./socks.js";

export interface SearchHit {
	file: string;
	score: number;
	text: string;
	line?: number | null;
}

export interface SearchResponse {
	engine: string;
	mode: string;
	results: SearchHit[];
	note?: string;
}

export interface BrainHealth {
	ok: boolean;
	role: string;
	date: string;
	search?: { engine: string; mode: string; collection: string; ready: boolean; indexing: boolean; update: string };
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
 * Backoff for a brain that is not answering yet: quick at first, then steady.
 *
 * Waiting is expected in two ordinary cases. A node that has just joined has the
 * peer list but no paths to it yet, and a brain that was reset comes back under a
 * new address, so the naive one-shot discovery gives up during a window that
 * closes on its own.
 */
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000];

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

	async context(): Promise<string> {
		const res = await this.call("GET", "/v1/context");
		return res.context ?? "";
	}

	/** Full memory tree, for the agent-side offline mirror. */
	snapshot(): Promise<{ takenAt: string; files: Record<string, string> }> {
		return this.call("GET", "/v1/snapshot");
	}

	async read(target: string, date?: string): Promise<any> {
		const q = new URLSearchParams({ target });
		if (date) q.set("date", date);
		return this.call("GET", `/v1/read?${q}`);
	}

	async search(query: string, limit: number, mode?: string): Promise<SearchResponse> {
		const q = new URLSearchParams({ q: query, limit: String(limit) });
		if (mode) q.set("mode", mode);
		const res = await this.call("GET", `/v1/search?${q}`);
		return { engine: String(res.engine ?? "bm25"), mode: String(res.mode ?? "keyword"), results: res.results ?? [], note: res.note };
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
