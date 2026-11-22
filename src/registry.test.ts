import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readProjectRecord, setRecordLocation, writeProjectRecord, type ProjectRecord } from "./registry.js";

async function recordPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-registry-"));
	return join(dir, ".projects", "abc.json");
}

const RECORD: ProjectRecord = {
	id: "repo-0123456789ab",
	location: "local",
	repoRoot: "/repo",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("project records", () => {
	it("reads a missing record as undefined", async () => {
		expect(await readProjectRecord(await recordPath())).toBeUndefined();
	});

	it("round-trips a record and changes only the location", async () => {
		const path = await recordPath();
		await writeProjectRecord(path, RECORD);
		expect(await readProjectRecord(path)).toEqual(RECORD);

		await setRecordLocation(path, "project", new Date("2026-02-01T00:00:00.000Z"));
		expect(await readProjectRecord(path)).toEqual({
			...RECORD,
			location: "project",
			updatedAt: "2026-02-01T00:00:00.000Z",
		});
		expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
	});

	it("refuses malformed records instead of treating them as absent", async () => {
		const path = await recordPath();
		await writeProjectRecord(path, RECORD);
		await writeFile(path, "{ not json", "utf8");
		await expect(readProjectRecord(path)).rejects.toThrow(/Cannot parse/);

		await writeFile(path, JSON.stringify({ id: "../escape", location: "local" }), "utf8");
		await expect(readProjectRecord(path)).rejects.toThrow(/invalid/);
	});

	it("cannot change the location of a record that does not exist", async () => {
		await expect(setRecordLocation(await recordPath(), "project")).rejects.toThrow(/No memory record/);
	});
});
