import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatReport, listExpiredTrash, runDoctor } from "./doctor.js";

async function fixture(): Promise<{ dir: string; trash: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-doctor-"));
	const dir = join(root, "memory");
	const trash = join(root, "trash");
	await mkdir(dir, { recursive: true });
	return { dir, trash };
}

describe("runDoctor", () => {
	it("passes a clean directory", async () => {
		const { dir, trash } = await fixture();
		await writeFile(join(dir, "a.md"), "---\ndescription: Alpha topic\n---\nbody", "utf8");
		const index = "- [Alpha](a.md) - the alpha topic";
		await writeFile(join(dir, "MEMORY.md"), index, "utf8");

		const report = await runDoctor(dir, { trashRoot: trash });
		expect(report.ok).toBe(true);
		expect(report.stats).toEqual({
			files: 1,
			entries: 1,
			indexLines: 1,
			indexBytes: Buffer.byteLength(index, "utf8"),
		});
	});

	it("reports dangling entries, orphans, duplicates, long hooks, and malformed lines", async () => {
		const { dir, trash } = await fixture();
		await writeFile(join(dir, "a.md"), "---\ndescription: Same words\n---\nbody", "utf8");
		await writeFile(join(dir, "orphan.md"), "---\ndescription: same   words\n---\nbody", "utf8");
		await writeFile(
			join(dir, "MEMORY.md"),
			[
				"- [Alpha](a.md) - the alpha topic",
				`- [Long](a.md) - ${"x".repeat(200)}`,
				"- [Gone](missing.md) - points nowhere",
				"loose prose",
			].join("\n"),
			"utf8",
		);

		const report = await runDoctor(dir, { trashRoot: trash });
		expect(report.ok).toBe(false);
		expect(report.errors.some((error) => error.includes("missing file"))).toBe(true);
		expect(report.errors.some((error) => error.includes("Malformed index line"))).toBe(true);
		expect(report.warnings.some((warning) => warning.includes("no index entry"))).toBe(true);
		expect(report.warnings.some((warning) => warning.includes("Duplicate description"))).toBe(true);
		expect(report.warnings.some((warning) => warning.includes("over 160 characters"))).toBe(true);
	});

	it("matches index entries to files in subdirectories on every platform", async () => {
		const { dir, trash } = await fixture();
		await mkdir(join(dir, "notes"), { recursive: true });
		await writeFile(join(dir, "notes", "a.md"), "body", "utf8");
		await writeFile(join(dir, "MEMORY.md"), "- [A](notes/a.md) - hook\n- [Doc](https://example.com) - external", "utf8");

		const report = await runDoctor(dir, { trashRoot: trash });
		expect(report.errors).toEqual([]);
		expect(report.warnings).toEqual([]);
	});

	it("reports entries that escape the memory directory", async () => {
		const { dir, trash } = await fixture();
		await writeFile(join(dir, "MEMORY.md"), "- [Out](../outside.md) - hook", "utf8");

		const report = await runDoctor(dir, { trashRoot: trash });
		expect(report.errors.some((error) => error.includes("escapes"))).toBe(true);
	});

	it("flags credentials in memory files", async () => {
		const { dir, trash } = await fixture();
		await writeFile(join(dir, "a.md"), "key: AKIAIOSFODNN7EXAMPLE", "utf8");
		await writeFile(join(dir, "MEMORY.md"), "- [Alpha](a.md) - alpha", "utf8");

		const report = await runDoctor(dir, { trashRoot: trash });
		expect(report.ok).toBe(false);
		expect(report.errors.some((error) => error.includes("Possible secret"))).toBe(true);
	});

	it("warns about trash older than the retention window", async () => {
		const { dir, trash } = await fixture();
		await mkdir(join(trash, "old"), { recursive: true });
		await writeFile(join(trash, "old", "a.md"), "body", "utf8");
		const now = new Date(Date.now() + 8 * 86_400_000);

		const report = await runDoctor(dir, { trashRoot: trash, now });
		expect(report.warnings.some((warning) => warning.includes("older than 7 days"))).toBe(true);
		expect(await listExpiredTrash(trash, now)).toEqual([join(trash, "old")]);
	});

	it("formats a readable report", async () => {
		const { dir, trash } = await fixture();
		const report = await runDoctor(dir, { trashRoot: trash });
		const text = formatReport(report);
		expect(text).toContain("memory:");
		expect(text).toContain("index:");
	});
});
