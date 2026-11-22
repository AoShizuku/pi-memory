// Drawing helpers, same design language as /provider, /background, /agents and /sessions (plugins/design_style.md):
// selection rows carry an accent bar plus the theme's selection surface; destructive keys need a second press.

import { homedir } from "node:os";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Overlays: centred, 90% wide, at most 80% of the terminal high (design_style.md §7). */
export const OVERLAY_OPTIONS = { width: "90%", maxHeight: "80%", anchor: "center" } as const;

export interface PanelHost {
	requestRender(): void;
	readonly terminal: { readonly rows: number };
}

/** Cut to the width and pad, so a row's surface reaches the right edge. */
export function fit(content: string, width: number): string {
	const cut = truncateToWidth(content, Math.max(0, width), "…");
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/**
 * A titled rule, `─ left ───── right ─`, the full width (design_style.md §4.1): a bottom panel's top edge, and
 * the same shape for a divider inside a panel. Labels come in already colored; only the rule is painted here.
 * When the row is narrow the fill shrinks to one `─` first, then each right label is tried in turn (full form,
 * then shorter ones) and finally dropped, and last the left label is cut with `…`. The leading `─ ` and the
 * closing `─` always stay.
 */
export function titledRule(
	width: number,
	paint: (rule: string) => string,
	left: string,
	right: string | readonly string[] = [],
): string {
	const rule = (count: number) => paint("─".repeat(count));
	if (width < 4) return rule(Math.max(0, width));
	const leftWidth = visibleWidth(left);
	for (const label of typeof right === "string" ? [right] : right) {
		// `─ ` left ` ` fill ` ` right ` ─`
		const fill = width - leftWidth - visibleWidth(label) - 6;
		if (label && fill >= 1) return `${rule(1)} ${left} ${rule(fill)} ${label} ${rule(1)}`;
	}
	const shown = leftWidth <= width - 4 ? left : truncateToWidth(left, width - 4, "…");
	return `${rule(1)} ${shown} ${rule(width - 3 - visibleWidth(shown))}`;
}

/** Pad or cut plain text to a column. */
export function col(text: string, width: number, align: "left" | "right" = "left"): string {
	const cut = truncateToWidth(text, Math.max(0, width), "…");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(cut)));
	return align === "left" ? cut + pad : pad + cut;
}

/**
 * Put a row on the selection surface. Truncation leaves a full reset inside the row, and that reset would drop
 * the background for everything after it, so the background is re-applied after each one.
 */
export function onSurface(theme: Theme, content: string, width: number, armed = false): string {
	const surface = armed ? "toolErrorBg" : "selectedBg";
	const band = theme.getBgAnsi(surface);
	return theme.bg(surface, fit(content, width).replace(/\x1b\[0m/g, `\x1b[0m${band}`));
}

export function cursorBar(theme: Theme, selected: boolean, armed = false): string {
	return selected ? theme.fg(armed ? "error" : "accent", "▎ ") : "  ";
}

/** Keep `selected` inside a window of `viewport` rows starting at `top`. */
export function follow(top: number, selected: number, viewport: number, total: number): number {
	let next = Math.min(top, Math.max(0, total - viewport));
	if (selected < next) next = selected;
	if (selected >= next + viewport) next = selected - viewport + 1;
	return Math.max(0, next);
}

/** A single printable character typed (plain or Kitty CSI-u), or undefined for control keys. */
export function printable(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if (data.length === 0 || data.startsWith("\x1b")) return undefined;
	return [...data].every((char) => char >= " " && char !== "\x7f") ? data : undefined;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** The text of a bracketed paste, or undefined when `data` is not one. */
export function pasted(data: string): string | undefined {
	const start = data.indexOf(PASTE_START);
	if (start < 0) return undefined;
	const end = data.indexOf(PASTE_END, start);
	return data.slice(start + PASTE_START.length, end < 0 ? undefined : end);
}

/** Two-press confirmation, bound to a key (an item key or a choice), never to a row index. */
export class Confirm {
	private armed: string | undefined;

	isArmed(key: string | undefined): boolean {
		return key !== undefined && this.armed === key;
	}

	/** True: confirmed now. False: armed, waiting for the second press. */
	press(key: string): boolean {
		if (this.armed === key) {
			this.armed = undefined;
			return true;
		}
		this.armed = key;
		return false;
	}

	cancel(): boolean {
		if (this.armed === undefined) return false;
		this.armed = undefined;
		return true;
	}
}

/** Relative age: now, 5m, 2h, 3d, 4mo, 1y. */
export function ago(date: Date, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo`;
	return `${Math.floor(days / 365)}y`;
}

/** A path with the home directory written as ~, forward slashes: short enough for a panel row. */
export function tildePath(path: string, home: string = homedir()): string {
	const slashed = path.replaceAll("\\", "/");
	const base = home.replaceAll("\\", "/");
	const isWindows = /^[a-z]:\//iu.test(base);
	const same = isWindows ? slashed.toLowerCase().startsWith(base.toLowerCase()) : slashed.startsWith(base);
	if (base !== "" && same && (slashed.length === base.length || slashed[base.length] === "/")) {
		return `~${slashed.slice(base.length)}`;
	}
	return slashed;
}

/** Text safe to draw: no escape sequences or control characters, tabs as spaces. */
export function sanitize(text: string): string {
	return text
		.replaceAll("\r", "")
		.replaceAll("\t", "    ")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
}

/** Wrap paragraphs (blank lines dropped) to `width`; past `maxLines`, cut and end the last line with "…". */
export function wrapBlock(text: string, width: number, maxLines: number): string[] {
	if (maxLines <= 0) return [];
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (!paragraph.trim()) continue;
		lines.push(...wrapTextWithAnsi(paragraph.trimEnd(), width));
		if (lines.length > maxLines) break;
	}
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, maxLines);
	const last = kept[maxLines - 1] ?? "";
	kept[maxLines - 1] = visibleWidth(last) < width ? `${last}…` : truncateToWidth(`${last}…`, width, "…");
	return kept;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
