import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { MemoryLocation } from "./config.js";
import { listExpiredTrash } from "./doctor.js";
import {
	MigrationError,
	buildManifest,
	manifestsEqual,
	migrateMemory,
	readMigrationState,
	recoverMigration,
	type MigrationPhase,
} from "./migrate.js";

type Layout = {
	src: string;
	dst: string;
	statePath: string;
	trashRoot: string;
	/** Stand-in for the per-machine record. */
	location: { current: MemoryLocation };
};

const ID = "repo-0123456789ab";

async function layout(): Promise<Layout> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-migrate-"));
	const agentDir = join(root, "agent");
	return {
		src: join(agentDir, "memory", ID),
		dst: join(root, "repo", ".pi", "memory"),
		statePath: join(agentDir, "memory", ".migrations", `${ID}.json`),
		trashRoot: join(agentDir, "memory", ".trash"),
		location: { current: "local" },
	};
}

async function seed(dir: string): Promise<void> {
	await mkdir(join(dir, "nested"), { recursive: true });
	await writeFile(join(dir, "MEMORY.md"), "- [A](a.md) - hook", "utf8");
	await writeFile(join(dir, "a.md"), "# A\nbody", "utf8");
	await writeFile(join(dir, "nested", "b.md"), "# B", "utf8");
}

function options(fixture: Layout) {
	return {
		id: ID,
		from: "local" as const,
		to: "project" as const,
		src: fixture.src,
		dst: fixture.dst,
		statePath: fixture.statePath,
		trashRoot: fixture.trashRoot,
		setLocation: async (location: MemoryLocation) => {
			fixture.location.current = location;
		},
	};
}

function recoverOptions(fixture: Layout) {
	return { readLocation: async () => fixture.location.current, trashRoot: fixture.trashRoot };
}

async function writeStateFile(fixture: Layout, phase: MigrationPhase, tmp = `${fixture.dst}.tmp-1`): Promise<void> {
	await mkdir(join(fixture.statePath, ".."), { recursive: true });
	await writeFile(
		fixture.statePath,
		JSON.stringify({
			version: 1,
			phase,
			from: "local",
			to: "project",
			src: fixture.src,
			dst: fixture.dst,
			tmp,
			startedAt: new Date().toISOString(),
		}),
		"utf8",
	);
}

describe("manifests", () => {
	it("compare equal after a copy", async () => {
		const fixture = await layout();
		await seed(fixture.src);
		const before = await buildManifest(fixture.src);
		expect(before.map((entry) => entry.path)).toEqual(["MEMORY.md", "a.md", "nested/b.md"]);
		expect(manifestsEqual(before, await buildManifest(fixture.src))).toBe(true);
	});

	it("reads a missing directory as empty", async () => {
		const fixture = await layout();
		expect(await buildManifest(fixture.src)).toEqual([]);
	});
});

describe("migrateMemory", () => {
	it("copies, verifies, flips the location, and retires the source into trash", async () => {
		const fixture = await layout();
		await seed(fixture.src);

		const result = await migrateMemory(options(fixture));

		expect(result.mode).toBe("moved");
		expect(result.files).toBe(3);
		expect(result.trash).toBeDefined();
		expect(await readFile(join(fixture.dst, "a.md"), "utf8")).toBe("# A\nbody");
		expect(await readFile(join(fixture.dst, "nested", "b.md"), "utf8")).toBe("# B");
		expect(fixture.location.current).toBe("project");

		// The source is gone from its old place but preserved in trash.
		await expect(readdir(fixture.src)).rejects.toThrow();
		const trashed = await readdir(result.trash as string);
		expect(trashed.sort()).toEqual(["MEMORY.md", "a.md", "nested"]);
		expect(await readMigrationState(fixture.statePath)).toBeUndefined();
	});

	it("dates the trash copy from the move, not from the source directory", async () => {
		const fixture = await layout();
		await seed(fixture.src);
		const old = new Date(Date.now() - 30 * 86_400_000);
		await utimes(fixture.src, old, old);

		await migrateMemory(options(fixture));
		expect(await listExpiredTrash(fixture.trashRoot)).toEqual([]);
	});

	it("refuses a non-empty target and leaves both sides alone", async () => {
		const fixture = await layout();
		await seed(fixture.src);
		await mkdir(fixture.dst, { recursive: true });
		await writeFile(join(fixture.dst, "keep.md"), "keep", "utf8");

		await expect(migrateMemory(options(fixture))).rejects.toBeInstanceOf(MigrationError);
		await expect(migrateMemory(options(fixture))).rejects.toMatchObject({ code: "dst-not-empty" });
		expect(await readFile(join(fixture.src, "a.md"), "utf8")).toBe("# A\nbody");
		expect(await readFile(join(fixture.dst, "keep.md"), "utf8")).toBe("keep");
		expect(fixture.location.current).toBe("local");
	});

	it("adopts existing memory at the target when the source is empty", async () => {
		const fixture = await layout();
		await seed(fixture.dst);

		const result = await migrateMemory(options(fixture));
		expect(result).toMatchObject({ mode: "adopted", files: 3, trash: undefined });
		expect(fixture.location.current).toBe("project");
		expect(await readFile(join(fixture.dst, "a.md"), "utf8")).toBe("# A\nbody");
	});

	it("only switches the location when neither side holds memory", async () => {
		const fixture = await layout();
		const result = await migrateMemory(options(fixture));
		expect(result).toMatchObject({ mode: "switched", files: 0 });
		expect(fixture.location.current).toBe("project");
	});

	it("refuses to move a directory into itself", async () => {
		const fixture = await layout();
		await seed(fixture.src);
		await expect(migrateMemory({ ...options(fixture), dst: join(fixture.src, "inner") })).rejects.toMatchObject({
			code: "nested",
		});
	});

	it("rolls back the copy when the location cannot be recorded", async () => {
		const fixture = await layout();
		await seed(fixture.src);
		const failing = {
			...options(fixture),
			setLocation: async () => {
				throw new Error("disk full");
			},
		};

		await expect(migrateMemory(failing)).rejects.toMatchObject({ code: "flip-failed" });
		await expect(readdir(fixture.dst)).rejects.toThrow();
		expect(await readFile(join(fixture.src, "a.md"), "utf8")).toBe("# A\nbody");
		expect(await readMigrationState(fixture.statePath)).toBeUndefined();
	});
});

describe("recoverMigration", () => {
	it("drops only the temp copy when the source is still live", async () => {
		const fixture = await layout();
		await seed(fixture.src);
		const tmp = `${fixture.dst}.tmp-1`;
		await mkdir(tmp, { recursive: true });
		await writeFile(join(tmp, "partial.md"), "partial", "utf8");
		await writeStateFile(fixture, "copying", tmp);

		const message = await recoverMigration(fixture.statePath, recoverOptions(fixture));
		expect(message).toContain("source is intact");
		expect(await readFile(join(fixture.src, "a.md"), "utf8")).toBe("# A\nbody");
		await expect(readdir(tmp)).rejects.toThrow();
		expect(await readMigrationState(fixture.statePath)).toBeUndefined();
	});

	it("removes a promoted copy that matches the source when the flip never happened", async () => {
		const fixture = await layout();
		await seed(fixture.src);
		await seed(fixture.dst);
		await writeStateFile(fixture, "flipping");

		const message = await recoverMigration(fixture.statePath, recoverOptions(fixture));
		expect(message).toContain("unfinished copy");
		await expect(readdir(fixture.dst)).rejects.toThrow();
		expect(await readFile(join(fixture.src, "a.md"), "utf8")).toBe("# A\nbody");
	});

	it("leaves a target that differs from the source in place", async () => {
		const fixture = await layout();
		await seed(fixture.src);
		await mkdir(fixture.dst, { recursive: true });
		await writeFile(join(fixture.dst, "other.md"), "other", "utf8");
		await writeStateFile(fixture, "promoting");

		const message = await recoverMigration(fixture.statePath, recoverOptions(fixture));
		expect(message).toContain("left in place");
		expect(await readFile(join(fixture.dst, "other.md"), "utf8")).toBe("other");
	});

	it("retires the stale source when the location already points at the target", async () => {
		const fixture = await layout();
		await seed(fixture.src);
		await seed(fixture.dst);
		fixture.location.current = "project";
		await writeStateFile(fixture, "retiring");

		const message = await recoverMigration(fixture.statePath, recoverOptions(fixture));
		expect(message).toContain(`memory is at ${fixture.dst}`);
		await expect(readdir(fixture.src)).rejects.toThrow();
		expect(await readdir(fixture.trashRoot)).toHaveLength(1);
		expect(await readFile(join(fixture.dst, "a.md"), "utf8")).toBe("# A\nbody");
	});

	it("returns undefined when there is nothing to recover", async () => {
		const fixture = await layout();
		expect(await recoverMigration(fixture.statePath, recoverOptions(fixture))).toBeUndefined();
	});
});
