// The /memory panel (DESIGN.md §2): a bottom panel with two pages. Memories lists the index entries, then the files
// the index does not mention, with the selected memory in a box on the right, like /sessions. Issues lists what
// doctor finds. Typing searches; deleting needs a second ctrl+d (design_style.md §6).

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TuiMouseEvent, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { MemoryLocation } from "../config.js";
import type { DoctorIssue, IssueCode } from "../doctor.js";
import { MAX_INDEX_BYTES } from "../indexFile.js";
import { deleteEffect, type MemoryItem, type MemoryView } from "../store.js";
import {
	ago,
	Confirm,
	col,
	cursorBar,
	errorText,
	fit,
	follow,
	onSurface,
	type PanelHost,
	pasted,
	printable,
	sanitize,
	tildePath,
	titledRule,
	wrapBlock,
} from "./kit.js";

export type Page = "memories" | "issues";

/** Where the memory comes from and what the panel may do to it; the extension entry binds it to the session. */
export interface MemorySource {
	readonly location: MemoryLocation;
	load(): Promise<MemoryView>;
	/** Returns the notice to show. May throw; the panel shows the error and reloads. */
	remove(item: MemoryItem): Promise<string>;
	purge(issue: DoctorIssue): Promise<string>;
	/** Opens the full file in an overlay on top of the panel. */
	view(item: MemoryItem): void;
}

const NOTICE_MS = 5000;
const TYPE_WIDTH = 9;
const CTRL_D = "ctrl+d";

const ISSUE_LABELS: Record<IssueCode, string> = {
	"no-index": "no index",
	"over-budget": "over budget",
	malformed: "malformed line",
	escapes: "escapes dir",
	"missing-file": "missing file",
	"long-hook": "long hook",
	orphan: "not indexed",
	"duplicate-description": "duplicate",
	secret: "possible secret",
	"expired-trash": "old trash",
};
const LABEL_WIDTH = 16;

export function issueSubject(issue: DoctorIssue): string {
	if (issue.path !== undefined) return tildePath(issue.path);
	if (issue.files.length > 0) return issue.files.join(", ");
	if (issue.target !== undefined) return issue.target;
	if (issue.code === "malformed") return issue.message.replace(/^Malformed index line:\s*/u, "");
	return issue.message;
}

function worst(issues: readonly DoctorIssue[]): "error" | "warning" | undefined {
	if (issues.some((issue) => issue.level === "error")) return "error";
	return issues.length > 0 ? "warning" : undefined;
}

function matches(haystack: string, query: string): boolean {
	const text = haystack.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/u)
		.filter((term) => term !== "")
		.every((term) => text.includes(term));
}

function formatKb(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)}`;
}

export class MemoryPanel implements Component {
	private page: Page;
	private view: MemoryView | undefined;
	private loadError: string | undefined;
	private loading = false;
	private query = "";
	private readonly sel: Record<Page, number> = { memories: 0, issues: 0 };
	private readonly selKey: Record<Page, string | undefined> = { memories: undefined, issues: undefined };
	private top = 0;
	private readonly confirm = new Confirm();
	private notice: { text: string; level: "info" | "error"; at: number } | undefined;
	private readonly ticker: ReturnType<typeof setInterval>;
	private closed = false;

	constructor(
		private readonly host: PanelHost,
		private readonly theme: Theme,
		private readonly keys: KeybindingsManager,
		private readonly source: MemorySource,
		private readonly done: () => void,
		initialPage: Page = "memories",
	) {
		this.page = initialPage;
		this.reload();
		// Notices expire while nothing else redraws.
		this.ticker = setInterval(() => host.requestRender(), 1000);
	}

	// ── data ────────────────────────────────────────────────────────────────

	private reload(): void {
		this.loading = true;
		this.source
			.load()
			.then((view) => {
				this.view = view;
				this.loadError = undefined;
			})
			.catch((error: unknown) => {
				this.loadError = errorText(error);
			})
			.finally(() => {
				this.loading = false;
				if (!this.closed) this.host.requestRender();
			});
	}

	private memories(): MemoryItem[] {
		const items = this.view?.items ?? [];
		if (!this.query) return items;
		return items.filter((item) =>
			matches([item.title, item.hook, item.file ?? item.target ?? "", item.type ?? "", item.body].join("\n"), this.query),
		);
	}

	private issues(): DoctorIssue[] {
		const issues = this.view?.issues ?? [];
		if (!this.query) return issues;
		return issues.filter((issue) => matches(`${ISSUE_LABELS[issue.code]}\n${issue.message}`, this.query));
	}

	private issueKey(issue: DoctorIssue): string {
		return `${issue.code}:${issue.message}`;
	}

	/** Rows of the current page, with the selection kept on the same key while the list changes. */
	private rows(): { keys: string[]; count: number } {
		const keys = this.page === "memories" ? this.memories().map((item) => item.key) : this.issues().map((issue) => this.issueKey(issue));
		const wanted = this.selKey[this.page];
		const at = wanted !== undefined ? keys.indexOf(wanted) : -1;
		if (at >= 0) this.sel[this.page] = at;
		this.sel[this.page] = Math.max(0, Math.min(this.sel[this.page], keys.length - 1));
		return { keys, count: keys.length };
	}

	private select(index: number): void {
		const { keys } = this.rows();
		this.sel[this.page] = Math.max(0, Math.min(index, keys.length - 1));
		this.selKey[this.page] = keys[this.sel[this.page]];
	}

	private selectedItem(): MemoryItem | undefined {
		this.rows();
		return this.page === "memories" ? this.memories()[this.sel.memories] : undefined;
	}

	private selectedIssue(): DoctorIssue | undefined {
		this.rows();
		return this.page === "issues" ? this.issues()[this.sel.issues] : undefined;
	}

	/** The memory an issue is about, when it is about exactly one. */
	private itemFor(issue: DoctorIssue): MemoryItem | undefined {
		return this.view?.items.find((item) => item.issues.includes(issue));
	}

	private setNotice(text: string, level: "info" | "error" = "info"): void {
		this.notice = { text, level, at: Date.now() };
	}

	// ── render ──────────────────────────────────────────────────────────────

	private bodyHeight(): number {
		return Math.min(22, Math.max(6, Math.floor(this.host.terminal.rows * 0.6) - 4));
	}

	render(width: number): string[] {
		const body = this.page === "memories" ? this.memoriesBody(width) : this.issuesBody(width);
		const lines = [this.header(width), this.searchLine(), ...body, "", this.hint()];
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private header(width: number): string {
		const { theme } = this;
		const issues = this.view?.issues ?? [];
		const level = worst(issues);
		const tab = (page: Page, label: string) => (this.page === page ? theme.bold(theme.fg("accent", label)) : theme.fg("dim", label));
		const count = issues.length > 0 ? ` ${theme.fg(level === "error" ? "error" : "warning", String(issues.length))}` : "";
		// The tabs sit on the top edge, which carries on the editor's top border; the state goes on its right.
		const left = `${tab("memories", "Memories")}  ${tab("issues", "Issues")}${count}`;
		let right: string[];
		if (this.notice && Date.now() - this.notice.at < NOTICE_MS) {
			right = [theme.fg(this.notice.level === "error" ? "error" : "success", this.notice.text)];
		} else if (!this.view) {
			right = this.loading ? [theme.fg("dim", "loading…")] : [];
		} else {
			const { stats, overBudget } = this.view;
			const items = this.view.items.length;
			const size = `${formatKb(stats.indexBytes)}/${MAX_INDEX_BYTES / 1024} KB`;
			const count = `${items} ${items === 1 ? "memory" : "memories"}`;
			right = [
				[
					theme.fg("dim", `${count} · index ${stats.indexLines} lines `),
					overBudget ? theme.fg("warning", size) : theme.fg("dim", size),
					theme.fg("dim", ` · ${this.source.location}`),
				].join(""),
				// Narrow terminals keep the count and the place; the index size is one Tab away on the Issues page.
				theme.fg("dim", `${count} · ${this.source.location}`),
			];
		}
		return titledRule(width, (rule) => theme.fg("borderMuted", rule), left, right);
	}

	private searchLine(): string {
		const { theme } = this;
		const cursor = theme.inverse(" ");
		if (this.query) return `${theme.fg("dim", "search")} ${this.query}${cursor}`;
		const what = this.page === "memories" ? "title, hook, file or content" : "issue";
		return `${theme.fg("dim", "search")} ${cursor}${theme.fg("dim", ` type to filter by ${what}`)}`;
	}

	private pad(lines: string[]): string[] {
		return [...lines, ...Array<string>(Math.max(0, this.bodyHeight() - lines.length)).fill("")];
	}

	private empty(): string[] | undefined {
		const { theme } = this;
		if (this.loadError) return this.pad([theme.fg("error", `  cannot read memory: ${this.loadError}`)]);
		if (!this.view) return this.pad([theme.fg("dim", "  loading…")]);
		return undefined;
	}

	/** Window the rows around the selection and mark what is hidden above and below. */
	private window(rows: string[], selectedLine: number, extra: number, width: number): string[] {
		const { theme } = this;
		const viewport = Math.min(this.bodyHeight(), rows.length);
		// Lines under the selected row belong to it: keep them on screen too.
		if (extra > 0) this.top = follow(this.top, selectedLine + extra, viewport, rows.length);
		this.top = follow(this.top, selectedLine, viewport, rows.length);
		const visible = rows.slice(this.top, this.top + viewport);
		const below = rows.length - this.top - viewport;
		if (below > 0) visible[visible.length - 1] = theme.fg("dim", fit(`  ↓ ${below} more`, width));
		if (this.top > 0 && visible.length > 1) visible[0] = theme.fg("dim", fit(`  ↑ ${this.top} more`, width));
		return visible;
	}

	private memoriesBody(width: number): string[] {
		const early = this.empty();
		if (early) return early;
		const { theme } = this;
		const items = this.memories();
		if (items.length === 0) {
			const message = this.query ? "Nothing matches." : "No memories yet. The model saves them as you work.";
			return this.pad([theme.fg("dim", `  ${message}`)]);
		}
		this.rows();
		const withBox = width >= 80;
		const leftWidth = withBox ? Math.min(44, Math.max(30, Math.floor(width * 0.38))) : width;
		const all = this.view?.items ?? [];
		const layout = { marker: all.some((item) => item.issues.length > 0), type: all.some((item) => item.type !== undefined) };
		const selected = items[this.sel.memories];
		const armed = selected !== undefined && this.confirm.isArmed(selected.key);

		const rows: string[] = [];
		let selectedLine = 0;
		items.forEach((item, index) => {
			const isSelected = index === this.sel.memories;
			if (isSelected) selectedLine = rows.length;
			rows.push(this.memoryRow(item, isSelected, isSelected && armed, leftWidth, layout));
			if (isSelected && !withBox) rows.push(theme.fg("dim", truncateToWidth(`    ${item.hook || "(no hook)"}`, leftWidth, "…")));
		});
		const visible = this.window(rows, selectedLine, withBox ? 0 : 1, leftWidth);
		if (!withBox || !selected) return this.pad(visible);

		const height = this.bodyHeight();
		const box = this.previewBox(selected, width - leftWidth - 2, height);
		const out: string[] = [];
		for (let i = 0; i < height; i++) out.push(`${visible[i] ?? " ".repeat(leftWidth)}  ${box[i] ?? ""}`);
		return out;
	}

	private marker(issues: readonly DoctorIssue[]): string {
		const level = worst(issues);
		if (level === "error") return this.theme.fg("error", "×");
		if (level === "warning") return this.theme.fg("warning", "!");
		return " ";
	}

	private memoryRow(
		item: MemoryItem,
		selected: boolean,
		armed: boolean,
		width: number,
		layout: { marker: boolean; type: boolean },
	): string {
		const { theme } = this;
		const quiet = selected ? "muted" : "dim";
		const marker = layout.marker ? `${this.marker(item.issues)} ` : "";
		const type = layout.type ? ` ${theme.fg(quiet, col(item.type ?? "—", TYPE_WIDTH, "right"))}` : "";
		const titleWidth = Math.max(4, width - 2 - visibleWidth(marker) - visibleWidth(type));
		const title = item.kind === "orphan" ? theme.fg(selected ? "text" : "muted", col(item.title, titleWidth)) : col(item.title, titleWidth);
		const line = `${cursorBar(theme, selected, armed)}${marker}${title}${type}`;
		return selected ? onSurface(theme, line, width, armed) : fit(line, width);
	}

	private previewBox(item: MemoryItem, width: number, height: number): string[] {
		const { theme } = this;
		const border = (text: string) => theme.fg("dim", text);
		const inner = Math.max(10, width - 4);
		const metaParts = [item.type, item.modified ? ago(item.modified) : undefined].filter((part) => part !== undefined);
		const meta = metaParts.length > 0 ? theme.fg("dim", ` ${metaParts.join(" · ")} `) : "";
		const title = truncateToWidth(theme.bold(` ${sanitize(item.title)} `), Math.max(4, width - 5 - visibleWidth(meta)), "…");
		const fillTop = Math.max(1, width - 4 - visibleWidth(title) - visibleWidth(meta));
		const top = truncateToWidth(`${border("╭─")}${title}${border("─".repeat(fillTop))}${meta}${border("─╮")}`, width, "");
		const where = truncateToWidth(theme.fg("muted", ` ${item.file ?? item.target ?? ""} `), Math.max(4, width - 4), "…");
		const fillBottom = Math.max(1, width - 3 - visibleWidth(where));
		const bottom = truncateToWidth(`${border("╰─")}${where}${border("─".repeat(fillBottom))}${border("╯")}`, width, "");
		const rows = Math.max(1, height - 2);
		const content = this.previewLines(item, inner, rows);
		const body = Array.from({ length: rows }, (_, i) => `${border("│")} ${fit(content[i] ?? "", inner)} ${border("│")}`);
		return [top, ...body, bottom];
	}

	private previewLines(item: MemoryItem, inner: number, rows: number): string[] {
		const { theme } = this;
		const lines: string[] = [];
		for (const issue of item.issues) {
			const color = issue.level === "error" ? "error" : "warning";
			const symbol = issue.level === "error" ? "×" : "!";
			lines.push(...wrapBlock(`${symbol} ${sanitize(issue.message)}`, inner, 2).map((line) => theme.fg(color, line)));
		}
		if (item.hook) lines.push(...wrapBlock(sanitize(item.hook), inner, 3).map((line) => theme.fg("muted", line)));
		if (lines.length > 0) lines.push("");
		const room = rows - lines.length;
		if (room <= 0) return lines.slice(0, rows);
		if (item.external) lines.push(theme.fg("dim", `external link: ${item.target}`));
		else if (!item.exists) lines.push(theme.fg("dim", "(file not found)"));
		else if (!item.body.trim()) lines.push(theme.fg("dim", "(empty)"));
		else lines.push(...wrapBlock(sanitize(item.body), inner, room));
		return lines;
	}

	private issuesBody(width: number): string[] {
		const early = this.empty();
		if (early) return early;
		const { theme } = this;
		const issues = this.issues();
		if (issues.length === 0) return this.pad([theme.fg("dim", this.query ? "  Nothing matches." : "  No issues found.")]);
		this.rows();
		const selected = issues[this.sel.issues];
		const armed = selected !== undefined && this.confirm.isArmed(this.issueKey(selected));
		const rows: string[] = [];
		let selectedLine = 0;
		let extra = 0;
		issues.forEach((issue, index) => {
			const isSelected = index === this.sel.issues;
			const marker = this.marker([issue]);
			const label = theme.fg(isSelected ? "muted" : "dim", col(ISSUE_LABELS[issue.code], LABEL_WIDTH));
			const line = `${cursorBar(theme, isSelected, isSelected && armed)}${marker} ${label} ${sanitize(issueSubject(issue))}`;
			if (!isSelected) {
				rows.push(fit(line, width));
				return;
			}
			selectedLine = rows.length;
			rows.push(onSurface(theme, line, width, armed));
			// The full message under the selected row: the row itself only has room for the subject.
			const detail = wrapBlock(sanitize(issue.message), Math.max(10, width - 4), 3).map((text) => theme.fg("dim", `    ${text}`));
			extra = detail.length;
			rows.push(...detail);
		});
		return this.pad(this.window(rows, selectedLine, extra, width));
	}

	private hint(): string {
		const { theme } = this;
		const esc = `esc ${this.query ? "clear" : "close"}`;
		if (this.page === "memories") {
			const item = this.selectedItem();
			if (item && this.confirm.isArmed(item.key)) {
				return theme.fg("error", `press ${CTRL_D} again to ${deleteEffect(item)} · any other key cancels`);
			}
			const keys = ["type to search"];
			if (item) keys.push("↑↓ select", "enter view", `${CTRL_D} delete`);
			keys.push("tab issues", esc);
			return theme.fg("dim", keys.join(" · "));
		}
		const issue = this.selectedIssue();
		if (issue && this.confirm.isArmed(this.issueKey(issue))) {
			return theme.fg("error", `press ${CTRL_D} again to delete ${tildePath(issue.path ?? "")} for good · any other key cancels`);
		}
		const keys = ["type to search"];
		if (issue) keys.push("↑↓ select");
		if (issue && this.itemFor(issue)) keys.push("enter show memory");
		if (issue?.code === "expired-trash") keys.push(`${CTRL_D} purge`);
		keys.push("tab memories", esc);
		return theme.fg("dim", keys.join(" · "));
	}

	// ── input ───────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		const kb = this.keys;
		const isUp = kb.matches(data, "tui.select.up");
		const isDown = kb.matches(data, "tui.select.down");
		const isDelete = matchesKey(data, "ctrl+d");
		const wasArmed = this.confirm.cancel();
		// Armed: only the delete key goes on; every other key only cancels, except moves, which also move.
		if (wasArmed && !isDelete && !isUp && !isDown) {
			this.host.requestRender();
			return;
		}

		const page = Math.max(1, this.bodyHeight() - 1);
		const at = this.sel[this.page];
		if (kb.matches(data, "tui.select.cancel")) {
			if (!this.query) return this.close();
			this.setQuery("");
		} else if (matchesKey(data, "tab")) {
			this.page = this.page === "memories" ? "issues" : "memories";
			this.top = 0;
		} else if (isUp) this.select(at - 1);
		else if (isDown) this.select(at + 1);
		else if (kb.matches(data, "tui.select.pageUp")) this.select(at - page);
		else if (kb.matches(data, "tui.select.pageDown")) this.select(at + page);
		else if (kb.matches(data, "tui.select.confirm")) this.confirmKey();
		else if (isDelete) this.deleteKey(wasArmed);
		else if (matchesKey(data, "backspace")) {
			if (this.query) this.setQuery([...this.query].slice(0, -1).join(""));
		} else {
			const paste = pasted(data);
			const text = paste !== undefined ? paste.replace(/\s+/g, " ") : printable(data);
			if (text) this.setQuery(this.query + text);
		}
		this.host.requestRender();
	}

	private confirmKey(): void {
		if (this.page === "memories") {
			const item = this.selectedItem();
			if (!item) return;
			if (item.external) this.setNotice(`external link: ${item.target}`);
			else if (!item.exists) this.setNotice(`${item.file} does not exist`, "error");
			else this.source.view(item);
			return;
		}
		const issue = this.selectedIssue();
		const item = issue ? this.itemFor(issue) : undefined;
		if (!item) return;
		this.page = "memories";
		this.query = "";
		this.top = 0;
		this.selKey.memories = item.key;
	}

	private deleteKey(wasArmed: boolean): void {
		if (this.page === "memories") {
			const item = this.selectedItem();
			if (item && (wasArmed || this.confirm.press(item.key))) this.run(this.source.remove(item));
			return;
		}
		const issue = this.selectedIssue();
		if (!issue || issue.code !== "expired-trash") return;
		if (wasArmed || this.confirm.press(this.issueKey(issue))) this.run(this.source.purge(issue));
	}

	private run(action: Promise<string>): void {
		action
			.then((notice) => this.setNotice(notice))
			.catch((error: unknown) => this.setNotice(errorText(error), "error"))
			.finally(() => {
				if (this.closed) return;
				// Reload either way: a failure usually means the files changed under the panel.
				this.reload();
				this.host.requestRender();
			});
	}

	private setQuery(query: string): void {
		this.query = query;
		this.sel[this.page] = 0;
		this.selKey[this.page] = undefined;
		this.top = 0;
	}

	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.confirm.cancel();
		this.select(this.sel[this.page] + event.wheelDelta);
		this.host.requestRender();
		return { handled: true };
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		clearInterval(this.ticker);
	}

	private close(): void {
		if (this.closed) return;
		this.dispose();
		this.done();
	}
}

/** Wrap one block of plain text to `width`, keeping blank lines (the overlay shows files as they are). */
export function wrapAll(text: string, width: number): string[] {
	const out: string[] = [];
	for (const line of sanitize(text).split("\n")) {
		if (line.trim() === "") out.push("");
		else out.push(...wrapTextWithAnsi(line.trimEnd(), width));
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out;
}
