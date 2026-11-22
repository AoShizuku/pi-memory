// Small bottom panels for /memory switch, in place of pi's select / confirm / input dialogs (DESIGN.md §2.5):
// a list of choices with a detail column and notes for the selected one, and a one-line text prompt. A choice
// that changes things on disk asks for a second enter (design_style.md §6).

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, matchesKey, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { Confirm, col, cursorBar, fit, onSurface, type PanelHost, titledRule } from "./kit.js";

export type Choice<T> = {
	value: T;
	label: string;
	/** Dim text after the label, in its own column. */
	detail?: string;
	/** An accent marker after the label, such as "● current". */
	tag?: string;
	/** Lines shown under the list while this choice is selected. */
	notes?: readonly string[];
	/** The verb for the key line: "enter <action>". */
	action?: string;
	/** When set, enter arms first; the key line becomes this prompt until the second enter. */
	confirm?: string;
	/** When set, enter only shows this notice. */
	disabled?: string;
};

export type ChoiceSpec<T> = {
	title: string;
	/** Dim text on the right of the top edge. */
	stats?: string;
	/** Lines between the title and the list. */
	intro?: readonly string[];
	choices: readonly Choice<T>[];
	initial?: number;
};

const NOTICE_MS = 5000;

export class ChoicePanel<T> implements Component {
	private sel: number;
	private readonly confirm = new Confirm();
	private notice: { text: string; at: number } | undefined;

	constructor(
		private readonly host: PanelHost,
		private readonly theme: Theme,
		private readonly keys: KeybindingsManager,
		private readonly spec: ChoiceSpec<T>,
		private readonly done: (value: T | undefined) => void,
	) {
		this.sel = Math.max(0, Math.min(spec.initial ?? 0, spec.choices.length - 1));
	}

	render(width: number): string[] {
		const { theme, spec } = this;
		const lines: string[] = [];
		// The title sits on the top edge, which carries on the editor's top border; a notice takes the stats' place.
		const notice = this.notice && Date.now() - this.notice.at < NOTICE_MS ? theme.fg("warning", this.notice.text) : undefined;
		const right = notice ?? (spec.stats ? theme.fg("dim", spec.stats) : []);
		lines.push(titledRule(width, (rule) => theme.fg("borderMuted", rule), theme.bold(theme.fg("accent", spec.title)), right));
		for (const line of spec.intro ?? []) lines.push(`  ${theme.fg("muted", line)}`);
		lines.push("");

		const labelWidth = Math.max(...spec.choices.map((choice) => visibleWidth(choice.label) + (choice.tag ? visibleWidth(choice.tag) + 1 : 0)));
		spec.choices.forEach((choice, index) => {
			const selected = index === this.sel;
			const armed = selected && this.confirm.isArmed(String(index));
			const tag = choice.tag ? ` ${theme.fg("accent", choice.tag)}` : "";
			const label = `${choice.label}${tag}`;
			const padded = label + " ".repeat(Math.max(0, labelWidth - visibleWidth(label)));
			const detail = choice.detail ? `   ${theme.fg(selected ? "muted" : "dim", choice.detail)}` : "";
			const line = `${cursorBar(theme, selected, armed)}${padded}${detail}`;
			lines.push(selected ? onSurface(theme, line, width, armed) : fit(line, width));
		});

		const notes = spec.choices[this.sel]?.notes ?? [];
		if (notes.length > 0) {
			lines.push("");
			for (const note of notes) lines.push(`  ${theme.fg("dim", note)}`);
		}
		lines.push("", this.hint());
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private hint(): string {
		const choice = this.spec.choices[this.sel];
		if (choice?.confirm && this.confirm.isArmed(String(this.sel))) return this.theme.fg("error", choice.confirm);
		const keys = [];
		if (this.spec.choices.length > 1) keys.push("↑↓ select");
		if (choice && !choice.disabled) keys.push(`enter ${choice.action ?? "choose"}`);
		keys.push("esc cancel");
		return this.theme.fg("dim", keys.join(" · "));
	}

	handleInput(data: string): void {
		const kb = this.keys;
		const isUp = kb.matches(data, "tui.select.up");
		const isDown = kb.matches(data, "tui.select.down");
		const isEnter = kb.matches(data, "tui.select.confirm");
		const wasArmed = this.confirm.cancel();
		// Armed: only enter goes on; moves also move; every other key, esc included, only cancels.
		if (wasArmed && !isEnter && !isUp && !isDown) {
			this.host.requestRender();
			return;
		}
		const count = this.spec.choices.length;
		if (isUp) this.sel = Math.max(0, this.sel - 1);
		else if (isDown) this.sel = Math.min(count - 1, this.sel + 1);
		else if (kb.matches(data, "tui.select.cancel")) return this.done(undefined);
		else if (isEnter) {
			const choice = this.spec.choices[this.sel];
			if (!choice) return;
			if (choice.disabled) this.notice = { text: choice.disabled, at: Date.now() };
			else if (!choice.confirm || wasArmed || this.confirm.press(String(this.sel))) return this.done(choice.value);
		}
		this.host.requestRender();
	}

	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.confirm.cancel();
		this.sel = Math.max(0, Math.min(this.spec.choices.length - 1, this.sel + event.wheelDelta));
		this.host.requestRender();
		return { handled: true };
	}

	invalidate(): void {}
}

/** One line of text: a title, the field at column 2, a key line. */
export class TextPrompt implements Component, Focusable {
	private readonly input = new Input({ prompt: "" });
	private _focused = false;

	constructor(
		private readonly theme: Theme,
		private readonly keys: KeybindingsManager,
		private readonly spec: { title: string; value: string; action: string },
		private readonly done: (value: string | undefined) => void,
	) {
		this.input.setValue(spec.value);
		// Input has no public cursor setter; start editing at the end of the suggested text.
		(this.input as unknown as { cursor: number }).cursor = spec.value.length;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	render(width: number): string[] {
		const { theme } = this;
		const field = this.input.render(Math.max(4, width - 2))[0] ?? "";
		const lines = [
			titledRule(width, (rule) => theme.fg("borderMuted", rule), theme.bold(theme.fg("accent", this.spec.title))),
			"",
			`  ${field}`,
			"",
			theme.fg("dim", `enter ${this.spec.action} · esc cancel`),
		];
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) return this.done(undefined);
		if (matchesKey(data, "enter")) return this.done(this.input.getValue());
		this.input.handleInput(data);
	}

	invalidate(): void {}
}

/** Label/detail rows aligned like a two-column table, for notes. */
export function noteRows(rows: ReadonlyArray<readonly [string, string]>): string[] {
	const width = Math.max(...rows.map(([label]) => visibleWidth(label)));
	return rows.map(([label, value]) => `${col(label, width)}  ${value}`);
}
