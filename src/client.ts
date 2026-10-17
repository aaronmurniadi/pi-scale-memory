import { socksHttp } from "./socks.js";
import type { UserspaceTailnet } from "./tailnet.js";

export interface WriteRequest {
	path: "/v1/write" | "/v1/scratchpad";
	body: Record<string, unknown>;
}

/** HTTP client for the brain server, routed through the userspace tailnet SOCKS5 proxy. */
export class BrainClient {
	brainIp: string | null = null;
	brainName = "";
	private outbox: WriteRequest[] = [];

	constructor(
		private tailnet: UserspaceTailnet,
		private port: number,
		private token: string,
		readonly agentId: string,
	) {}

	get pending(): number {
		return this.outbox.length;
	}

	get connected(): boolean {
		return this.brainIp !== null;
	}

	/** Look the brain up by tag, retrying while the tailnet netmap syncs. */
	async discover(waitMs = 30000): Promise<boolean> {
		const deadline = Date.now() + waitMs;
		do {
			const peer = await this.tailnet.findBrain();
			if (peer?.online) {
				this.brainIp = peer.ip;
				this.brainName = peer.name;
				return true;
			}
			await new Promise((r) => setTimeout(r, 2000));
		} while (Date.now() < deadline);
		this.brainIp = null;
		return false;
	}

	private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
		if (!this.brainIp && !(await this.discover(6000))) throw new Error("brain not found on tailnet (tag:brain)");
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		let payload: string | undefined;
		if (body !== undefined) payload = JSON.stringify(body);
		let res: { status: number; body: string };
		try {
			res = await socksHttp({
				proxyPort: this.tailnet.socksPort,
				host: this.brainIp as string,
				port: this.port,
				method,
				path,
				headers,
				body: payload,
			});
		} catch (err) {
			this.brainIp = null; // force re-discovery next time
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

	health() {
		return this.call("GET", "/v1/health");
	}

	async context(): Promise<string> {
		return (await this.call("GET", "/v1/context")).context ?? "";
	}

	async read(target: string, date?: string): Promise<any> {
		const q = new URLSearchParams({ target });
		if (date) q.set("date", date);
		return this.call("GET", `/v1/read?${q}`);
	}

	async search(query: string, limit: number): Promise<any[]> {
		const q = new URLSearchParams({ q: query, limit: String(limit) });
		return (await this.call("GET", `/v1/search?${q}`)).results ?? [];
	}

	forget(body: Record<string, unknown>) {
		return this.call("POST", "/v1/forget", body);
	}

	/** Append-style write: sent now, or queued for the periodic flush if the brain is unreachable. */
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
}
