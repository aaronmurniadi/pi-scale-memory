/**
 * The brain-log panel.
 *
 * On the machine that serves the memory, this is a live view of every read and
 * write the brain handles. Pi's interactive layout is a vertical stack with no
 * split-pane API, so the panel is a non-capturing overlay rather than a real
 * column: on a terminal wider than 80 columns it sits on the right, a third of
 * the width and the full height; at or below that it becomes a five-row strip
 * across the top. Both shapes leave the editor focused.
 *
 * The lines come from the activity log the brain server appends to
 * (`BRAIN_DIR/activity.jsonl`, or `BRAIN_ACTIVITY_LOG`). This module mirrors
 * that path and the line shape; see brain/server.mjs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type OverlayOptions, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/** `right` = a column on the right; `top` = a strip across the top. */
export type PanelMode = "right" | "top";

/** Above this many columns the panel takes a right-hand column; at or below it, a top strip. */
export const PANEL_WIDE_COLUMNS = 80;
/** Rows the top strip occupies, title included. */
export const PANEL_TOP_ROWS = 5;
/** How often the panel looks for new lines. */
export const PANEL_POLL_MS = 1_000;
/** How often the panel checks whether a resize changed its shape. */
const PANEL_WATCH_MS = 250;
/** Entries kept in memory: more than any panel can show, fewer than a session's traffic. */
const PANEL_KEEP_ENTRIES = 200;
/** How much of an existing log is read when the panel opens. */
const PANEL_PRIME_BYTES = 64 * 1024;

export function panelModeFor(columns: number): PanelMode {
	if (columns > PANEL_WIDE_COLUMNS) return "right";
	return "top";
}

/** Where the brain server writes its activity log. Mirrors brain/server.mjs. */
export function brainActivityPath(): string {
	const override = process.env.BRAIN_ACTIVITY_LOG;
	if (override) return override;
	const dir = process.env.BRAIN_DIR ?? path.join(os.homedir(), ".pi-scale-brain");
	return path.join(dir, "activity.jsonl");
}

/** One line of the activity log, as brain/server.mjs writes it. */
export interface ActivityEntry {
	t: string;
	op: string;
	ns?: string | null;
	target?: string | null;
	mode?: string | null;
	scope?: string | null;
	q?: string | null;
	hits?: number;
	action?: string | null;
	removed?: number;
	deduped?: boolean;
	agent?: string | null;
	from?: string | null;
	into?: string | null;
	status?: number;
	ms?: number;
}

/** A line that is not one of the brain's records (truncated tail, junk) parses to null. */
export function parseActivityLine(line: string): ActivityEntry | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const raw = JSON.parse(trimmed) as Record<string, unknown>;
		if (typeof raw.t !== "string" || typeof raw.op !== "string") return null;
		return raw as unknown as ActivityEntry;
	} catch {
		return null;
	}
}

function pad2(n: number): string {
	if (n < 10) return `0${n}`;
	return String(n);
}

/** Wall-clock time for a log line, in the reader's local zone. */
export function clockOf(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "--:--:--";
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Everything after the operation word: which namespace, and what happened to it. */
export function formatEntry(entry: ActivityEntry): string {
	const ns = entry.ns ? String(entry.ns) : "";
	switch (entry.op) {
		case "read":
			return [ns, entry.target ?? "long_term"].filter(nonEmpty).join(" ");
		case "write": {
			const parts = [ns, entry.target ?? "", entry.mode ?? ""].filter(nonEmpty);
			if (entry.deduped) parts.push("deduped");
			return parts.join(" ");
		}
		case "search": {
			const parts: string[] = [];
			if (ns) parts.push(ns);
			if (entry.q) parts.push(`"${entry.q}"`);
			parts.push(`${entry.hits ?? 0} hits`);
			return parts.join(" ");
		}
		case "scratchpad":
			return [ns, entry.action ?? "list"].filter(nonEmpty).join(" ");
		case "forget":
			return [ns, entry.target ?? "long_term", `-${entry.removed ?? 0}`].filter(nonEmpty).join(" ");
		case "core":
			return entry.action ?? "append";
		case "merge":
			return `${entry.from ?? "?"} → ${entry.into ?? "?"}`;
		case "context":
		case "snapshot":
		case "namespaces":
			return ns;
		case "error":
			if (typeof entry.status === "number") return `HTTP ${entry.status}`;
			return "";
		default:
			return ns;
	}
}

function nonEmpty(part: string): boolean {
	return part.length > 0;
}

function opColor(op: string): ThemeColor {
	switch (op) {
		case "search":
			return "accent";
		case "write":
		case "core":
		case "scratchpad":
			return "success";
		case "forget":
		case "merge":
			return "warning";
		case "context":
		case "snapshot":
		case "namespaces":
			return "muted";
		case "error":
			return "error";
		default:
			return "text";
	}
}

/**
 * Tails the activity log: reads the existing tail once, then only what is
 * appended. Survives the file being trimmed in place, which the server does
 * when the log passes its size cap.
 */
export class ActivityTail {
	readonly entries: ActivityEntry[] = [];
	private offset = 0;
	private partial = "";
	private primed = false;

	constructor(
		private readonly file: string,
		private readonly keep = PANEL_KEEP_ENTRIES,
	) {}

	/** Load the tail of the existing log so the panel opens with context. */
	prime(): void {
		this.primed = true;
		let text = "";
		let from = 0;
		try {
			const stat = fs.statSync(this.file);
			from = Math.max(0, stat.size - PANEL_PRIME_BYTES);
			const fd = fs.openSync(this.file, "r");
			try {
				const buf = Buffer.alloc(stat.size - from);
				fs.readSync(fd, buf, 0, buf.length, from);
				text = buf.toString("utf-8");
			} finally {
				fs.closeSync(fd);
			}
			this.offset = stat.size;
		} catch {
			this.offset = 0;
			return;
		}
		const lines = text.split("\n");
		// A window that starts mid-file starts mid-line; that fragment is not an entry.
		if (from > 0) lines.shift();
		this.push(lines);
	}

	/** Read anything appended since the last poll; returns how many entries were added. */
	poll(): number {
		if (!this.primed) {
			this.prime();
			return this.entries.length;
		}
		let size: number;
		try {
			size = fs.statSync(this.file).size;
		} catch {
			return 0;
		}
		if (size < this.offset) {
			// Trimmed in place: the old offset points past the end, so start over.
			this.offset = 0;
			this.partial = "";
		}
		if (size === this.offset) return 0;
		let text: string;
		try {
			const fd = fs.openSync(this.file, "r");
			try {
				const buf = Buffer.alloc(size - this.offset);
				fs.readSync(fd, buf, 0, buf.length, this.offset);
				text = buf.toString("utf-8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return 0;
		}
		this.offset = size;
		const lines = `${this.partial}${text}`.split("\n");
		this.partial = lines.pop() ?? "";
		return this.push(lines);
	}

	private push(lines: string[]): number {
		let added = 0;
		for (const line of lines) {
			const entry = parseActivityLine(line);
			if (!entry) continue;
			this.entries.push(entry);
			added++;
		}
		if (this.entries.length > this.keep) this.entries.splice(0, this.entries.length - this.keep);
		return added;
	}
}

/** Draws the tail of the activity log. Read-only: it never takes focus. */
export class BrainLogPanel {
	private readonly tail: ActivityTail;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		logPath: string,
		private readonly mode: PanelMode,
		pollMs = PANEL_POLL_MS,
	) {
		this.tail = new ActivityTail(logPath);
		this.tail.prime();
		this.timer = setInterval(() => {
			if (this.tail.poll() > 0) this.tui.requestRender();
		}, pollMs);
		this.timer.unref?.();
	}

	invalidate(): void {
		/* nothing is cached; theme is applied at render time */
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const maxLines = this.maxLines();
		const lines = [this.theme.fg("accent", truncateToWidth(" brain log", w))];
		const entries = this.tail.entries;
		const room = Math.max(0, maxLines - 1);
		const shown = entries.slice(Math.max(0, entries.length - room));
		if (shown.length === 0) {
			lines.push(this.theme.fg("dim", truncateToWidth(" waiting for memory activity", w)));
		}
		for (const entry of shown) lines.push(this.renderEntry(entry, w));
		while (lines.length < maxLines) lines.push("");
		return lines;
	}

	private maxLines(): number {
		if (this.mode === "top") return PANEL_TOP_ROWS;
		return Math.max(1, this.tui.terminal.rows);
	}

	private renderEntry(entry: ActivityEntry, width: number): string {
		const stamp = this.theme.fg("dim", `${clockOf(entry.t)} `);
		const label = this.theme.fg(opColor(entry.op), entry.op);
		const used = visibleWidth(stamp) + visibleWidth(entry.op) + 1;
		const detail = truncateToWidth(` ${formatEntry(entry)}`, Math.max(0, width - used));
		return `${stamp}${label}${this.theme.fg("muted", detail)}`;
	}
}

export interface BrainLogPanelHandle {
	stop(): void;
}

function reason(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Put the panel on screen and keep it the right shape.
 *
 * Overlay geometry is fixed when the overlay is shown, so a resize that crosses
 * the wide/narrow line closes the panel and opens the next one.
 */
export function mountBrainLogPanel(ctx: ExtensionContext, logPath = brainActivityPath()): BrainLogPanelHandle {
	let stopped = false;
	let panel: BrainLogPanel | null = null;
	let tui: TUI | null = null;
	let mode: PanelMode | null = null;
	let close: (() => void) | null = null;
	let watch: ReturnType<typeof setInterval> | null = null;

	const geometry = (): OverlayOptions => {
		const columns = tui ? tui.terminal.columns : 0;
		const rows = tui ? tui.terminal.rows : PANEL_TOP_ROWS;
		if (panelModeFor(columns) === "right") {
			return { width: Math.floor(columns / 3), maxHeight: rows, anchor: "top-right", nonCapturing: true };
		}
		return { width: columns, maxHeight: PANEL_TOP_ROWS, anchor: "top-left", nonCapturing: true };
	};

	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (watch) {
			clearInterval(watch);
			watch = null;
		}
		const done = close;
		close = null;
		if (panel) panel.dispose();
		panel = null;
		if (done) done();
	};

	const open = () => {
		if (stopped) return;
		mode = null;
		let opened: Promise<undefined>;
		try {
			opened = ctx.ui.custom<undefined>(
				(next, theme, _keybindings, done) => {
					tui = next;
					mode = panelModeFor(next.terminal.columns);
					close = () => done(undefined);
					panel = new BrainLogPanel(next, theme, logPath, mode);
					return panel;
				},
				{ overlay: true, overlayOptions: geometry },
			);
		} catch (err) {
			ctx.ui.notify(`pi-scale-memory: brain log panel unavailable (${reason(err)}).`, "warning");
			stop();
			return;
		}
		void opened.catch((err: unknown) => {
			ctx.ui.notify(`pi-scale-memory: brain log panel unavailable (${reason(err)}).`, "warning");
			stop();
		});
	};

	const rebuild = () => {
		const done = close;
		close = null;
		if (panel) panel.dispose();
		panel = null;
		if (done) done();
		open();
	};

	open();
	watch = setInterval(() => {
		if (stopped || !tui || mode === null) return;
		if (panelModeFor(tui.terminal.columns) !== mode) rebuild();
	}, PANEL_WATCH_MS);
	watch.unref?.();

	return { stop };
}
