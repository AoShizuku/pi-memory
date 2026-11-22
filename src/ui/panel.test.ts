import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import { deleteMemory, loadMemory, type MemoryItem, purgeTrash } from "../store.js";
import { ChoicePanel, TextPrompt } from "./choice.js";
import { type MemorySource, MemoryPanel, type Page } from "./panel.js";
import { MemoryViewer } from "./viewer.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
	// A real zero-width escape, so width checks hold and the surface can be asserted.
	bg: (color: string, text: string) => `${color === "toolErrorBg" ? "\x1b[41m" : "\x1b[44m"}${text}\x1b[49m`,
	getBgAnsi: (color: string) => (color === "toolErrorBg" ? "\x1b[41m" : "\x1b[44m"),
} as unknown as Theme;

const KEYS: Record<string, string> = {
	"tui.select.cancel": "\x1b",
	"tui.select.up": "\x1b[A",
	"tui.select.down": "\x1b[B",
	"tui.select.confirm": "\r",
};
const keys = { matches: (data: string, id: string) => KEYS[id] === data, getKeys: () => [] } as unknown as KeybindingsManager;

const ESC = "\x1b";
const DOWN = "\x1b[B";
const ENTER = "\r";
const CTRL_D = "\x04";
const TAB = "\t";

const host = { requestRender: () => {}, terminal: { rows: 40 } };
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/gu, "");

const panels: MemoryPanel[] = [];
afterEach(() => {
	for (const panel of panels.splice(0)) panel.dispose();
});

async function fixture(): Promise<{ dir: string; trash: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-panel-"));
	const dir = join(root, "memory");
	const trash = join(root, "trash");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "lang.md"), "---\ntype: feedback\n---\nReply in Chinese.\n\nWhy: asked twice.", "utf8");
	await writeFile(join(dir, "pin.md"), "---\ntype: project\n---\npi is pinned at v1.5.2", "utf8");
	await writeFile(join(dir, "loose.md"), "---\ndescription: forgotten note\n---\nloose", "utf8");
	await writeFile(join(dir, "MEMORY.md"), "- [Reply in Chinese](lang.md) - language\n- [pi pinned](pin.md) - version\n- [Gone](gone.md) - dangling", "utf8");
	return { dir, trash };
}

async function open(dir: string, trash: string, page: Page = "memories") {
	let closed = false;
	const viewed: MemoryItem[] = [];
	const source: MemorySource = {
		location: "local",
		load: () => loadMemory(dir, trash),
		remove: (item) => deleteMemory(dir, trash, "repo-1", item),
		purge: async (issue) => purgeTrash(trash, issue.path ?? ""),
		view: (item) => viewed.push(item),
	};
	const panel = new MemoryPanel(host, theme, keys, source, () => (closed = true), page);
	panels.push(panel);
	await flush();
	const press = async (...inputs: string[]) => {
		for (const input of inputs) panel.handleInput(input);
		await flush();
	};
	return { panel, press, viewed, closed: () => closed, screen: (width = 120) => panel.render(width).map(plain) };
}

describe("MemoryPanel", () => {
	it("lists entries then unindexed files, marks issues, and previews the selection", async () => {
		const { dir, trash } = await fixture();
		const { panel, screen } = await open(dir, trash);
		const lines = screen();

		expect(lines[0]).toMatch(/^─ Memories {2}Issues 2 ─+ 4 memories · index 3 lines .*\/12 KB · local ─$/u);
		expect(screen(50)[0]).toMatch(/^─ Memories {2}Issues 2 ─+ 4 memories · local ─$/u);
		expect(lines[2]).toMatch(/^▎ {3}Reply in Chinese +feedback {2}╭─ Reply in Chinese ─+ feedback · now ─╮$/u);
		expect(lines.some((line) => /^ {2}× Gone +— /u.test(line))).toBe(true);
		expect(lines.some((line) => /^ {2}! loose +— /u.test(line))).toBe(true);
		expect(lines.join("\n")).toContain("Why: asked twice.");
		expect(lines.at(-1)).toBe("type to search · ↑↓ select · enter view · ctrl+d delete · tab issues · esc close");
		for (const line of panel.render(120)) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		for (const line of panel.render(50)) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
	});

	it("searches by content and opens the full file on enter", async () => {
		const { dir, trash } = await fixture();
		const { press, screen, viewed } = await open(dir, trash);
		await press(..."v1.5");
		const lines = screen();
		expect(lines[1]).toBe("search v1.5 ");
		expect(lines[2]).toContain("pi pinned");
		await press(ENTER);
		expect(viewed.map((item) => item.file)).toEqual(["pin.md"]);
	});

	it("deletes on the second ctrl+d only, and any other key cancels", async () => {
		const { dir, trash } = await fixture();
		const { press, screen } = await open(dir, trash);

		await press(CTRL_D);
		expect(screen().at(-1)).toBe("press ctrl+d again to move lang.md to trash and drop its index line · any other key cancels");
		await press("a");
		expect(screen().at(-1)).toContain("type to search");
		expect(screen()[1]).toBe("search   type to filter by title, hook, file or content");

		await press(CTRL_D, CTRL_D);
		expect(screen()[0]).toContain("deleted Reply in Chinese (lang.md in trash)");
		expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("- [pi pinned](pin.md) - version\n- [Gone](gone.md) - dangling");
		// The selection falls to the next memory.
		expect(screen()[2]).toContain("pi pinned");
	});

	it("puts the selected row on the error surface while armed", async () => {
		const { dir, trash } = await fixture();
		const { panel, press } = await open(dir, trash);
		await press(CTRL_D);
		expect(panel.render(120)[2]).toContain("\x1b[41m");
		await press(DOWN);
		expect(panel.render(120)[3]).toContain("\x1b[44m");
	});

	it("lists issues on the Issues page and jumps to the memory an issue is about", async () => {
		const { dir, trash } = await fixture();
		const { press, screen } = await open(dir, trash);
		await press(TAB);
		let lines = screen();
		expect(lines[2]).toMatch(/^▎ × missing file {5}gone\.md/u);
		expect(lines[3]).toContain("Index entry points at a missing file: gone.md");
		expect(lines.at(-1)).toBe("type to search · ↑↓ select · enter show memory · tab memories · esc close");

		await press(ENTER);
		lines = screen();
		expect(lines[0]).toMatch(/^─ Memories/u);
		expect(lines.find((line) => line.startsWith("▎"))).toContain("Gone");
	});

	it("purges an expired trash entry from the Issues page", async () => {
		const { dir, trash } = await fixture();
		await mkdir(join(trash, "old-copy"), { recursive: true });
		const old = new Date(Date.now() - 10 * 86_400_000);
		await utimes(join(trash, "old-copy"), old, old);
		const { press, screen } = await open(dir, trash, "issues");

		const at = screen().findIndex((line) => line.includes("old trash"));
		for (let row = 2; row < at; row++) await press(DOWN);
		expect(screen().at(-1)).toContain("ctrl+d purge");
		await press(CTRL_D);
		expect(screen().at(-1)).toMatch(/^press ctrl\+d again to delete .*old-copy for good/u);
		await press(CTRL_D);
		expect(screen()[0]).toContain("purged old-copy");
		expect(screen().some((line) => line.includes("old trash"))).toBe(false);
	});

	it("clears the search before closing", async () => {
		const { dir, trash } = await fixture();
		const { press, closed } = await open(dir, trash);
		await press("x", ESC);
		expect(closed()).toBe(false);
		await press(ESC);
		expect(closed()).toBe(true);
	});
});

describe("MemoryViewer", () => {
	it("sizes to the file, scrolls when it does not fit, and closes on esc", async () => {
		const { dir, trash } = await fixture();
		const item = (await loadMemory(dir, trash)).items[0] as MemoryItem;
		let closed = false;
		const viewer = new MemoryViewer(host, theme, keys, item, () => (closed = true));
		const lines = viewer.render(60).map(plain);
		expect(lines[0]).toMatch(/^╭─ Reply in Chinese ─+ feedback · lang\.md ─╮$/u);
		expect(lines).toContain("│ type: feedback                                           │");
		expect(lines.at(-2)).toContain("esc close");

		const long = { ...item, text: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") };
		const scroller = new MemoryViewer(host, theme, keys, long, () => {});
		expect(scroller.render(60)).toHaveLength(32);
		scroller.handleInput("\x1b[B");
		expect(plain(scroller.render(60)[1] ?? "")).toContain("line 1");
		expect(plain(scroller.render(60).at(-2) ?? "")).toMatch(/^│ ↑↓ scroll · pgup\/pgdn page · esc close +2–30\/100 │$/u);

		viewer.handleInput(ESC);
		expect(closed).toBe(true);
	});
});

describe("ChoicePanel", () => {
	it("needs a second enter on a confirming choice and only notes a disabled one", () => {
		let result: string | undefined = "open";
		const panel = new ChoicePanel(
			host,
			theme,
			keys,
			{
				title: "Memory location",
				stats: "stored on this machine",
				choices: [
					{ value: "project", label: "project", detail: "~/repo/.pi/memory", action: "move", confirm: "press enter again to move" },
					{ value: "local", label: "local", tag: "● current", disabled: "already here", action: "move" },
				],
			},
			(value) => (result = value),
		);
		const screen = () => panel.render(80).map(plain);
		expect(screen()[0]).toMatch(/^─ Memory location ─+ stored on this machine ─$/u);
		expect(screen()[2]).toMatch(/^▎ project {11}~\/repo\/\.pi\/memory/u);
		expect(screen()[3]).toMatch(/^ {2}local ● current *$/u);
		expect(screen().at(-1)).toBe("↑↓ select · enter move · esc cancel");

		panel.handleInput(ENTER);
		expect(result).toBe("open");
		expect(screen().at(-1)).toBe("press enter again to move");
		panel.handleInput("x");
		expect(screen().at(-1)).toBe("↑↓ select · enter move · esc cancel");

		panel.handleInput(DOWN);
		panel.handleInput(ENTER);
		expect(result).toBe("open");
		expect(screen()[0]).toContain("already here");

		panel.handleInput("\x1b[A");
		panel.handleInput(ENTER);
		panel.handleInput(ENTER);
		expect(result).toBe("project");
	});
});

describe("TextPrompt", () => {
	it("starts with the suggested text and returns the edit", () => {
		let result: string | undefined = "open";
		const prompt = new TextPrompt(theme, keys, { title: "Commit message", value: "memory: 2", action: "commit" }, (value) => (result = value));
		expect(prompt.render(60).map(plain)).toEqual([expect.stringMatching(/^─ Commit message ─+$/u), "", expect.stringMatching(/^ {2}memory: 2/u), "", "enter commit · esc cancel"]);
		prompt.handleInput("!");
		prompt.handleInput(ENTER);
		expect(result).toBe("memory: 2!");
	});
});
