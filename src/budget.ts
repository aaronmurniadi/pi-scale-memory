/**
 * Time-boxing for best-effort work.
 *
 * Nothing here cancels anything: a model call or a socket write that has already
 * been handed off cannot be taken back. The point is only to stop the caller
 * waiting, which is what a path the user is watching — quitting pi — has to be
 * able to promise.
 */

/**
 * Resolve with `work`'s value, or with null when `ms` passes first.
 *
 * The work is left to settle on its own, and its result is consumed either way,
 * so an abandoned promise that later rejects cannot surface as an unhandled
 * rejection and take the process down after the caller has given up on it.
 */
export function withBudget<T>(ms: number, work: Promise<T>): Promise<T | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}

/**
 * A positive finite number of milliseconds, or `fallback` when the value is
 * unset, unparseable, or out of range.
 *
 * A budget is a promise about how long something may take, so a typo in the
 * environment must not be allowed to break it in either direction: nonsense
 * falls back, and a value above `max` is clamped, because "wait ten minutes" is
 * the bug this exists to prevent.
 */
export function budgetMs(raw: string | undefined, fallback: number, max: number): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(value, max);
}
