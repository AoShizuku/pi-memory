import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_INDEX_LINES } from "./indexFile.js";
import { CUT_MESSAGE, deleteEffect, deleteMemory, loadMemory, purgeTrash, splitFrontmatter, StaleIndexError } from "./store.js";

async function fixture(): Promise<{ dir: string; trash: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-store-"));
	const dir = join(root, "memory");
	const trash = join(root, "trash");
	await mkdir(dir, { recursive: true });
	return { dir, trash };
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

describe("splitFrontmatter", () => {
	it("reads flat and nested scalar fields and strips quotes", () => {
		const { fields, body } = splitFrontmatter('---\nname: lang\ndescription: "Reply in Chinese"\nmetadata:\n  type: feedback\n---\n\nBody line');
		expect(fields).toEqual({ name: "lang", description: "Reply in Chinese", type: "feedback" });
		expect(body).toBe("Body line");
	});

	it("treats text without a closing fence as body", () => {
		expect(splitFrontmatter("---\nname: x\nno end")).toEqual({ fields: {}, body: "---\nname: x\nno end" });
	});
});

describe("loadMemory", () => {
	it("lists entries in index order, then files the index does not mention, with their issues", async () => {
		const { dir, trash } = await fixture();
		await writeFile(join(dir, "a.md"), "---\ntype: user\n---\nalpha body", "utf8");
		await writeFile(join(dir, "orphan.md"), "---\nname: Loose\ndescription: not indexed\n---\nloose body", "utf8");
		await writeFile(
			join(dir, "MEMORY.md"),
			"# Memory\n- [Alpha](a.md) - alpha hook\n- [Gone](gone.md) - points nowhere\n- [Docs](https://example.com) - external",
			"utf8",
		);

		const view = await loadMemory(dir, trash);
		expect(view.items.map((item) => [item.key, item.kind, item.title])).toEqual([
			["entry:a.md", "entry", "Alpha"],
			["entry:gone.md", "entry", "Gone"],
			["entry:https://example.com", "entry", "Docs"],
			["file:orphan.md", "orphan", "Loose"],
		]);
		const [alpha, gone, docs, orphan] = view.items;
		expect(alpha).toMatchObject({ type: "user", body: "alpha body", exists: true, issues: [] });
		expect(gone?.exists).toBe(false);
		expect(gone?.issues.map((issue) => issue.code)).toEqual(["missing-file"]);
		expect(docs?.external).toBe(true);
		expect(orphan).toMatchObject({ hook: "not indexed", issues: [expect.objectContaining({ code: "orphan" })] });
		expect(view.issues.map((issue) => issue.code).sort()).toEqual(["missing-file", "orphan"]);
	});

	it("marks entries that fall past the index budget", async () => {
		const { dir, trash } = await fixture();
		const lines = Array.from({ length: MAX_INDEX_LINES + 2 }, (_, i) => `- [T${i}](https://e.com/${i}) - h`);
		await writeFile(join(dir, "MEMORY.md"), lines.join("\n"), "utf8");

		const view = await loadMemory(dir, trash);
		expect(view.overBudget).toBe(true);
		expect(view.items.filter((item) => item.cut).map((item) => item.title)).toEqual([`T${MAX_INDEX_LINES}`, `T${MAX_INDEX_LINES + 1}`]);
		expect(view.items.at(-1)?.issues.map((issue) => issue.message)).toEqual([CUT_MESSAGE]);
	});
});

describe("deleteMemory", () => {
	it("moves the file to the trash and drops only its index line", async () => {
		const { dir, trash } = await fixture();
		await mkdir(join(dir, "notes"), { recursive: true });
		await writeFile(join(dir, "notes", "a.md"), "alpha", "utf8");
		await writeFile(join(dir, "MEMORY.md"), "- [Alpha](notes/a.md) - one\r\n- [Beta](b.md) - two\r\n", "utf8");
		const view = await loadMemory(dir, trash);
		const alpha = view.items[0];
		if (!alpha) throw new Error("no item");
		expect(deleteEffect(alpha)).toBe("move notes/a.md to trash and drop its index line");

		// A line the model added after the panel loaded survives the delete.
		await writeFile(join(dir, "MEMORY.md"), "- [Alpha](notes/a.md) - one\r\n- [Beta](b.md) - two\r\n- [New](c.md) - three", "utf8");
		const now = new Date("2026-11-13T10:00:00Z");
		const notice = await deleteMemory(dir, trash, "repo-1", alpha, now);

		expect(notice).toContain("notes/a.md in trash");
		expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("- [Beta](b.md) - two\r\n- [New](c.md) - three");
		expect(await exists(join(dir, "notes", "a.md"))).toBe(false);
		const [bucket] = await readdir(trash);
		expect(bucket).toMatch(/^repo-1-file-2026-11-13T10-00-00-000Z$/u);
		expect(await readFile(join(trash, bucket ?? "", "notes", "a.md"), "utf8")).toBe("alpha");
		expect((await stat(join(trash, bucket ?? ""))).mtime.getTime()).toBe(now.getTime());
	});

	it("keeps a file another index line still points at", async () => {
		const { dir, trash } = await fixture();
		await writeFile(join(dir, "a.md"), "alpha", "utf8");
		await writeFile(join(dir, "MEMORY.md"), "- [One](a.md) - x\n- [Two](a.md) - y", "utf8");
		const view = await loadMemory(dir, trash);
		expect(view.items.map((item) => item.key)).toEqual(["entry:a.md", "entry:a.md#2"]);

		await deleteMemory(dir, trash, "repo-1", view.items[0] as never);
		expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("- [Two](a.md) - y");
		expect(await exists(join(dir, "a.md"))).toBe(true);
	});

	it("only drops the line of a dangling entry, and only moves an orphan file", async () => {
		const { dir, trash } = await fixture();
		await writeFile(join(dir, "loose.md"), "loose", "utf8");
		await writeFile(join(dir, "MEMORY.md"), "- [Gone](gone.md) - x", "utf8");
		const [gone, loose] = (await loadMemory(dir, trash)).items;
		if (!gone || !loose) throw new Error("missing items");

		expect(await deleteMemory(dir, trash, "r", gone)).toBe("dropped the index line for Gone");
		expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("");
		expect(await deleteMemory(dir, trash, "r", loose)).toBe("moved loose.md to trash");
		expect(await exists(join(dir, "loose.md"))).toBe(false);
	});

	it("refuses when the index line changed under the panel and touches nothing", async () => {
		const { dir, trash } = await fixture();
		await writeFile(join(dir, "a.md"), "alpha", "utf8");
		await writeFile(join(dir, "MEMORY.md"), "- [Alpha](a.md) - one", "utf8");
		const [alpha] = (await loadMemory(dir, trash)).items;
		await writeFile(join(dir, "MEMORY.md"), "- [Alpha](a.md) - reworded", "utf8");

		await expect(deleteMemory(dir, trash, "r", alpha as never)).rejects.toBeInstanceOf(StaleIndexError);
		expect(await exists(join(dir, "a.md"))).toBe(true);
	});
});

describe("purgeTrash", () => {
	it("removes a trash entry and refuses paths outside the trash root", async () => {
		const { dir, trash } = await fixture();
		await mkdir(join(trash, "old"), { recursive: true });
		const old = new Date(Date.now() - 10 * 86_400_000);
		await utimes(join(trash, "old"), old, old);

		expect(await purgeTrash(trash, join(trash, "old"))).toBe("purged old");
		expect(await exists(join(trash, "old"))).toBe(false);
		await expect(purgeTrash(trash, dir)).rejects.toThrow("not a trash entry");
	});
});
