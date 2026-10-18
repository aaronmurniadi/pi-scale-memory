import * as http from "node:http";
import * as net from "node:net";

/** Open a TCP connection to host:port through a local SOCKS5 proxy (no auth). */
export function socksConnect(
	proxyPort: number,
	host: string,
	port: number,
	timeoutMs = 15000,
): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(proxyPort, "127.0.0.1");
		let buf = Buffer.alloc(0);
		let stage: "greeting" | "reply" = "greeting";
		let settled = false;

		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			sock.destroy();
			reject(err);
		};

		// A port the far side drops, or a peer that went away, never replies at all.
		// Without this the handshake would wait forever and no caller timeout would
		// ever be reached.
		sock.setTimeout(timeoutMs, () => fail(new Error("SOCKS5 connect timed out")));

		sock.once("error", fail);
		sock.once("connect", () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
		sock.on("data", function onData(chunk: Buffer) {
			buf = Buffer.concat([buf, chunk]);
			if (stage === "greeting") {
				if (buf.length < 2) return;
				if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("SOCKS5 handshake rejected"));
				buf = buf.subarray(2);
				stage = "reply";
				const hostBuf = Buffer.from(host);
				const req = Buffer.concat([
					Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
					hostBuf,
					Buffer.from([(port >> 8) & 0xff, port & 0xff]),
				]);
				sock.write(req);
				return;
			}
			if (buf.length < 4) return;
			if (buf[1] !== 0x00) return fail(new Error(`SOCKS5 connect failed (code ${buf[1]})`));
			let need = 4;
			if (buf[3] === 0x01) need += 4 + 2;
			else if (buf[3] === 0x04) need += 16 + 2;
			else if (buf.length >= 5) need += 1 + buf[4] + 2;
			else return;
			if (buf.length < need) return;
			const rest = buf.subarray(need);
			sock.off("data", onData);
			sock.off("error", fail);
			sock.setTimeout(0);
			if (rest.length) sock.unshift(rest);
			settled = true;
			resolve(sock);
		});
	});
}

export interface SocksHttpOptions {
	proxyPort: number;
	host: string;
	port: number;
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
}

export async function socksHttp(opts: SocksHttpOptions): Promise<{ status: number; body: string }> {
	// One budget for the whole request: the SOCKS dial and the HTTP exchange share
	// it, so a probe cannot outlive the deadline its caller gave it.
	const timeoutMs = opts.timeoutMs ?? 15000;
	const deadline = Date.now() + timeoutMs;
	const sock = await socksConnect(opts.proxyPort, opts.host, opts.port, timeoutMs);
	return new Promise((resolve, reject) => {
		// `agent` has to stay unset. Node only honours `createConnection` when no
		// agent is chosen, so `agent: false` silently builds a default agent
		// instead: the socket the handshake just opened is thrown away and the
		// request dials the peer's tailnet address over the host's own network,
		// where nothing routes it. That is indistinguishable from a brain that
		// never answers. With no agent the socket is used for one request and closed.
		const req = http.request(
			{
				createConnection: () => sock,
				host: opts.host,
				port: opts.port,
				method: opts.method,
				path: opts.path,
				headers: opts.headers,
				timeout: Math.max(1, deadline - Date.now()),
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
			},
		);
		req.on("timeout", () => req.destroy(new Error("request timed out")));
		req.on("error", reject);
		if (opts.body) req.write(opts.body);
		req.end();
	});
}
