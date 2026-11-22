import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	INDEX_NAME,
	MAX_INDEX_BYTES,
	MAX_INDEX_LINES,
	formatIndexEntry,
	listMemoryFiles,
	normalizeEntryTarget,
	parseIndex,
	readIndex,
	truncateIndex,
} from "./indexFile.js";

describe("parseIndex", () => {
	it("reads CRLF indexes and keeps the raw line for matching", () => {
		const parsed = parseIndex("- [A](a.md) - alpha\r\n- [B](b.md) - beta\r\n");
		expect(parsed.malformed).toEqual([]);
		expect(parsed.entries.map((entry) => [entry.target, entry.hook, entry.raw])).toEqual([
			["a.md", "alpha", "- [A](a.md) - alpha\r"],
			["b.md", "beta", "- [B](b.md) - beta\r"],
		]);
	});

	it("reads entries and keeps the hook", () => {
		const parsed = parseIndex(
			["# Memory", "", "- [Testing](feedback_testing.md) - integration tests hit a real DB", "- [Deploy](project_deploy.md)"].join(
				"\n",
			),
		);
		expect(parsed.entries).toHaveLength(2);
		expect(parsed.entries[0]?.target).toBe("feedback_testing.md");
		expect(parsed.entries[0]?.hook).toBe("integration tests hit a real DB");
		expect(parsed.entries[1]?.hook).toBe("");
		expect(parsed.malformed).toEqual([]);
	});

	it("accepts an em dash separator", () => {
		const parsed = parseIndex("- [A](a.md) — hook text");
		expect(parsed.entries[0]?.hook).toBe("hook text");
	});

	it("reports lines that are not entries", () => {
		const parsed = parseIndex("- [A](a.md) - ok\nthis is prose, not an entry");
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.malformed).toEqual(["this is prose, not an entry"]);
	});
});

describe("truncateIndex", () => {
	it("passes small indexes through untouched", () => {
		const result = truncateIndex("- [A](a.md) - hook");
		expect(result.wasLineTruncated).toBe(false);
		expect(result.wasByteTruncated).toBe(false);
		expect(result.warning).toBeUndefined();
	});

	it("caps at the line limit and says so", () => {
		const raw = Array.from({ length: MAX_INDEX_LINES + 10 }, (_, index) => `- [E${index}](e${index}.md) - hook`).join("\n");
		const result = truncateIndex(raw);
		expect(result.wasLineTruncated).toBe(true);
		expect(result.content.split("\n").length).toBeLessThanOrEqual(MAX_INDEX_LINES + 3);
		expect(result.content).toContain("WARNING");
		expect(result.content).toContain(String(MAX_INDEX_LINES));
	});

	it("caps long single lines at the byte limit", () => {
		const raw = `- [Long](long.md) - ${"x".repeat(MAX_INDEX_BYTES + 100)}`;
		const result = truncateIndex(raw);
		expect(result.wasByteTruncated).toBe(true);
		expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(MAX_INDEX_BYTES + 400);
		expect(result.content).toContain("WARNING");
	});

	it("counts bytes, not characters, for CJK content", () => {
		// ~18 KB of UTF-8 in 100 lines: under the line cap, over the byte cap.
		const line = `- [记忆](a.md) - ${"这是一条用中文写的钩子描述用于测试字节上限".repeat(3)}`;
		const raw = Array.from({ length: 100 }, () => line).join("\n");
		expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(MAX_INDEX_BYTES);

		const result = truncateIndex(raw);
		const kept = result.content.slice(0, result.content.indexOf("\n\n> WARNING"));
		expect(result.wasByteTruncated).toBe(true);
		expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(MAX_INDEX_BYTES);
		expect(kept.split("\n").every((entry) => entry === line)).toBe(true);
	});

	it("never splits a multi-byte character when there is no newline to cut at", () => {
		const result = truncateIndex("中".repeat(MAX_INDEX_BYTES));
		const kept = result.content.slice(0, result.content.indexOf("\n\n> WARNING"));
		expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(MAX_INDEX_BYTES);
		expect(kept).not.toContain("\uFFFD");
		expect(kept).toBe("中".repeat(kept.length));
	});
});

describe("normalizeEntryTarget", () => {
	it("returns a forward-slash path relative to the memory directory", () => {
		expect(normalizeEntryTarget("notes/a.md")).toEqual({ kind: "file", path: "notes/a.md" });
		expect(normalizeEntryTarget("notes\\a.md")).toEqual({ kind: "file", path: "notes/a.md" });
		expect(normalizeEntryTarget("./a.md#section")).toEqual({ kind: "file", path: "a.md" });
		expect(normalizeEntryTarget("my%20notes.md")).toEqual({ kind: "file", path: "my notes.md" });
		expect(normalizeEntryTarget("a/../b.md")).toEqual({ kind: "file", path: "b.md" });
	});

	it("rejects absolute paths and escapes", () => {
		expect(normalizeEntryTarget("/etc/passwd")).toEqual({ kind: "escapes" });
		expect(normalizeEntryTarget("C:\\x.md")).toEqual({ kind: "escapes" });
		expect(normalizeEntryTarget("../x.md")).toEqual({ kind: "escapes" });
	});

	it("treats URLs as external", () => {
		expect(normalizeEntryTarget("https://example.com/doc")).toEqual({ kind: "external" });
	});
});

describe("readIndex and listMemoryFiles", () => {
	it("reports a missing index and lists only topic files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-memory-index-"));
		await writeFile(join(dir, "a.md"), "# a", "utf8");
		await writeFile(join(dir, INDEX_NAME), formatIndexEntry("A", "a.md", "hook"), "utf8");
		await writeFile(join(dir, "notes.txt"), "ignored", "utf8");

		const index = await readIndex(dir);
		expect(index.exists).toBe(true);
		expect(await listMemoryFiles(dir)).toEqual(["a.md"]);

		const missing = await readIndex(join(dir, "nope"));
		expect(missing).toEqual({ exists: false, raw: "" });
	});
});
