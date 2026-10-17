/**
 * Finding the brain without relying on tags.
 *
 * A Tailscale node can see its whole netmap, so an agent does not have to scan
 * anything: it enumerates the peers it can already reach and asks each one
 * whether it is a brain. The brain identifies itself in its own /v1/health
 * response, which is a positive answer instead of an inference from a tag.
 *
 * No tags are involved at any point.
 */
import type { BrainPeer } from "./tailnet.js";

export const BRAIN_SERVICE = "pi-scale-memory";

/** True when a /v1/health body is this extension's brain. */
export function isBrainResponse(status: number, body: string): boolean {
	if (status !== 200) return false;
	try {
		const parsed = JSON.parse(body);
		if (parsed?.service !== BRAIN_SERVICE) return false;
		return parsed?.role === "brain";
	} catch {
		return false;
	}
}

/**
 * Probe order: online peers first, then the rest. Offline peers are tried last
 * rather than dropped, because the netmap's online flag lags behind reality.
 * Names break ties so the order is stable between runs.
 */
export function rankCandidates(peers: BrainPeer[]): BrainPeer[] {
	return [...peers].sort((a, b) => {
		const byOnline = Number(b.online) - Number(a.online);
		if (byOnline !== 0) return byOnline;
		return a.name.localeCompare(b.name);
	});
}

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

export interface FindOptions {
	timeoutMs?: number;
	concurrency?: number;
	/** Optional pinned address, probed before the scan. */
	host?: string;
	onProbe?: (peer: string, isBrain: boolean) => void;
}

export interface FindResult {
	/** The address to use, or null when nothing answered. */
	host: string | null;
	/** Every responder, so the caller can warn about ambiguity. */
	brains: BrainPeer[];
	/** How many peers were asked. */
	probed: number;
	pinnedFailed?: boolean;
}

/**
 * Ask every peer whether it is a brain. `probe` is injected so this stays
 * testable, and so the caller decides how the connection is made (through the
 * tailnet SOCKS proxy, in practice).
 */
export async function findBrain(
	peers: BrainPeer[],
	probe: (host: string, timeoutMs: number) => Promise<boolean>,
	opts: FindOptions = {},
): Promise<FindResult> {
	const timeoutMs = opts.timeoutMs ?? 2500;
	const concurrency = opts.concurrency ?? 8;

	if (opts.host) {
		if (await probe(opts.host, timeoutMs)) return { host: opts.host, brains: [], probed: 1 };
		// A pinned address that does not answer falls through to the scan.
		const result = await findBrain(peers, probe, { ...opts, host: undefined });
		return { ...result, pinnedFailed: true };
	}

	const candidates = rankCandidates(peers);
	const answers = await mapWithLimit(candidates, concurrency, async (peer) => {
		const isBrain = await probe(peer.ip, timeoutMs);
		opts.onProbe?.(peer.name, isBrain);
		return isBrain;
	});

	const brains: BrainPeer[] = [];
	for (let i = 0; i < candidates.length; i++) {
		if (answers[i]) brains.push(candidates[i]);
	}
	if (brains.length === 0) return { host: null, brains: [], probed: candidates.length };
	return { host: brains[0].ip, brains, probed: candidates.length };
}
