// Full-file overlay for one memory (design_style.md §7): read only, scrolls itself because pi's ScrollView does
// not scroll inside an overlay. A file does not grow while it is open, so the box is sized by its content, up to
// 80% of the terminal.

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { MemoryItem } from "../store.js";
import { fit, type PanelHost, sanitize } from "./kit.js";
import { wrapAll } from "./panel.js";

export class MemoryViewer implements Component {
	private top = 0;
	private viewport = 1;
	private total = 0;
	private wrapped: { width: number; lines: string[] } | undefined;

	constructor(
		private readonly host: PanelHost,
		private readonly theme: Theme,
		private readonly keys: KeybindingsManager,
		private readonly item: MemoryItem,
		private readonly done: () => void,
	) {}

	private content(width: number): string[] {
		if (this.wrapped?.width !== width) this.wrapped = { width, lines: wrapAll(this.item.text, width) };
		return this.wrapped.lines;
	}

	render(width: number): string[] {
		if (width < 10) return [];
		const { theme } = this;
		const border = (text: string) => theme.fg("dim", text);
		const inner = width - 4;
		const content = this.content(inner);
		const cap = Math.max(4, Math.floor(this.host.terminal.rows * 0.8));
		this.total = content.length;
		this.viewport = Math.max(1, Math.min(content.length, cap - 3));
		this.top = Math.max(0, Math.min(this.top, this.total - this.viewport));
		const body = content.slice(this.top, this.top + this.viewport);

		const meta = [this.item.type, this.item.file].filter((part) => part !== undefined).join(" · ");
		const right = meta ? theme.fg("dim", ` ${meta} `) : "";
		const title = truncateToWidth(theme.bold(` ${sanitize(this.item.title)} `), Math.max(4, width - 5 - visibleWidth(right)), "…");
		const fill = Math.max(1, width - 4 - visibleWidth(title) - visibleWidth(right));
		const top = truncateToWidth(`${border("╭─")}${title}${border("─".repeat(fill))}${right}${border("─╮")}`, width, "");
		const row = (text: string) => `${border("│")} ${fit(text, inner)} ${border("│")}`;
		return [top, ...body.map(row), row(this.hint(inner)), border(`╰${"─".repeat(Math.max(0, width - 2))}╯`)];
	}

	/** Keys on the left; the visible range on the right while the file does not fit. */
	private hint(inner: number): string {
		const dim = (text: string) => this.theme.fg("dim", text);
		if (this.total <= this.viewport) return dim("esc close");
		const keys = "↑↓ scroll · pgup/pgdn page · esc close";
		const range = `${this.top + 1}–${Math.min(this.total, this.top + this.viewport)}/${this.total}`;
		const gap = inner - visibleWidth(keys) - visibleWidth(range);
		return gap >= 2 ? dim(keys + " ".repeat(gap) + range) : dim(keys);
	}

	handleInput(data: string): void {
		const kb = this.keys;
		if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "enter") || data === "q") {
			this.done();
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.scrollBy(-1);
		else if (kb.matches(data, "tui.select.down")) this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-Math.max(1, this.viewport - 1));
		else if (matchesKey(data, "pageDown")) this.scrollBy(Math.max(1, this.viewport - 1));
		else if (matchesKey(data, "home")) this.top = 0;
		else if (matchesKey(data, "end")) this.top = Math.max(0, this.total - this.viewport);
		else return;
		this.host.requestRender();
	}

	private scrollBy(lines: number): void {
		this.top = Math.max(0, Math.min(this.total - this.viewport, this.top + lines));
	}

	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.scrollBy(event.wheelDelta);
		this.host.requestRender();
		return { handled: true };
	}

	invalidate(): void {
		this.wrapped = undefined;
	}
}
