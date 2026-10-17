/**
 * Tailscale API: minting tag:agent auth keys.
 *
 * Auth keys are normally created in the admin console. With an API access token
 * (tskey-api-..., scope auth_keys) this can be done from here instead, which is
 * what /generate-preauth uses. The tailnet is addressed as "-", meaning the
 * tailnet that owns the token, so no tailnet name has to be configured.
 */
import * as https from "node:https";

const API_HOST = "api.tailscale.com";

export interface CreateAuthKeyOptions {
	apiToken: string;
	tags: string[];
	reusable: boolean;
	ephemeral: boolean;
	preauthorized: boolean;
	expirySeconds: number;
	tailnet?: string;
}

export interface CreatedAuthKey {
	key: string;
	id: string;
	expires: string;
	reusable: boolean;
	ephemeral: boolean;
	tags: string[];
}

/** The request body the API expects. Pure so the shape can be tested. */
export function authKeyBody(opts: CreateAuthKeyOptions): Record<string, unknown> {
	return {
		capabilities: {
			devices: {
				create: {
					reusable: opts.reusable,
					ephemeral: opts.ephemeral,
					preauthorized: opts.preauthorized,
					tags: opts.tags,
				},
			},
		},
		expirySeconds: opts.expirySeconds,
	};
}

export function authKeyPath(tailnet: string): string {
	return `/api/v2/tailnet/${encodeURIComponent(tailnet)}/keys`;
}

export function parseCreatedKey(raw: string): CreatedAuthKey {
	const json = JSON.parse(raw);
	const capabilities = json?.capabilities?.devices?.create ?? {};
	const tags = Array.isArray(capabilities.tags) ? capabilities.tags.map(String) : [];
	return {
		key: String(json?.key ?? ""),
		id: String(json?.id ?? ""),
		expires: String(json?.expires ?? ""),
		reusable: capabilities.reusable === true,
		ephemeral: capabilities.ephemeral === true,
		tags,
	};
}

function request(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body ?? {});
		const req = https.request(
			{
				host: API_HOST,
				path,
				method,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					accept: "application/json",
					"content-length": Buffer.byteLength(payload),
				},
				timeout: 30000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
			},
		);
		req.on("timeout", () => req.destroy(new Error("Tailscale API request timed out")));
		req.on("error", reject);
		req.write(payload);
		req.end();
	});
}

export async function createAuthKey(opts: CreateAuthKeyOptions): Promise<CreatedAuthKey> {
	let tailnet = "-";
	if (opts.tailnet) tailnet = opts.tailnet;
	const res = await request("POST", authKeyPath(tailnet), opts.apiToken, authKeyBody(opts));
	if (res.status !== 200 && res.status !== 201) {
		let detail = res.body;
		try {
			const parsed = JSON.parse(res.body);
			detail = String(parsed.message ?? parsed.error ?? res.body);
		} catch {
			/* keep the raw body */
		}
		throw new Error(`Tailscale API returned ${res.status}: ${detail}`);
	}
	return parseCreatedKey(res.body);
}
