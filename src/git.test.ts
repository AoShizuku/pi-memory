import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	commitMemory,
	commitsAhead,
	defaultCommitMessage,
	ensureExcluded,
	hasUpstream,
	isTracked,
	removeFromExclude,
} from "./git.js";
import type { Exec } from "./types.js";

function run(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		execFile(command, args, { cwd }, (error, stdout, stderr) => {
			if (error === null) {
				resolve({ stdout, stderr, code: 0 });
				return;
			}
			const code = typeof error.code === "number" ? error.code : 1;
			resolve({ stdout, stderr, code });
		});
	});
}

const exec: Exec = (command, args, options) => run(command, args, options?.cwd);

async function initRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-git-"));
	await run("git", ["init", "-q"], root);
	await run("git", ["config", "user.email", "test@example.com"], root);
	await run("git", ["config", "user.name", "Test"], root);
	await run("git", ["commit", "-q", "--allow-empty", "-m", "init"], root);
	return root;
}

describe("ensureExcluded", () => {
	it("writes the local exclude file once", async () => {
		const root = await initRepo();
		expect(await ensureExcluded(root, exec)).toBe(true);
		expect(await ensureExcluded(root, exec)).toBe(true);

		const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
		expect(exclude.match(/\.pi\/memory\//g)).toHaveLength(1);
	});

	it("reports whether removing the exclude line changed anything", async () => {
		const root = await initRepo();
		expect(await removeFromExclude(root, exec)).toBe(false);
		await ensureExcluded(root, exec);
		expect(await removeFromExclude(root, exec)).toBe(true);
		expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).not.toContain(".pi/memory/");
	});
});

describe("commitMemory push", () => {
	async function repoWithUpstream(): Promise<string> {
		const root = await initRepo();
		const remote = await mkdtemp(join(tmpdir(), "pi-memory-remote-"));
		await run("git", ["init", "-q", "--bare"], remote);
		await run("git", ["remote", "add", "origin", remote], root);
		await run("git", ["push", "-q", "-u", "origin", "HEAD"], root);
		await mkdir(join(root, ".pi", "memory"), { recursive: true });
		await writeFile(join(root, ".pi", "memory", "a.md"), "alpha", "utf8");
		return root;
	}

	it("asks before pushing unrelated unpushed commits and can skip the push", async () => {
		const root = await repoWithUpstream();
		await run("git", ["commit", "-q", "--allow-empty", "-m", "unrelated work"], root);
		const asked: number[] = [];

		const result = await commitMemory({
			repoRoot: root,
			exec,
			message: "memory",
			push: true,
			confirmPush: async (ahead) => {
				asked.push(ahead);
				return false;
			},
		});
		expect(asked).toEqual([2]);
		expect(result).toMatchObject({ committed: true, pushed: false });
		expect(result.detail).toContain("Push skipped");
		expect(await commitsAhead(root, exec)).toBe(2);
	});

	it("pushes without asking when only the memory commit is ahead", async () => {
		const root = await repoWithUpstream();
		let asked = false;
		const result = await commitMemory({
			repoRoot: root,
			exec,
			message: "memory",
			push: true,
			confirmPush: async () => {
				asked = true;
				return false;
			},
		});
		expect(asked).toBe(false);
		expect(result).toMatchObject({ committed: true, pushed: true });
		expect(await commitsAhead(root, exec)).toBe(0);
	});
});

describe("commitMemory", () => {
	it("commits only the memory directory", async () => {
		const root = await initRepo();
		await mkdir(join(root, ".pi", "memory"), { recursive: true });
		await writeFile(join(root, ".pi", "memory", "a.md"), "alpha", "utf8");
		await writeFile(join(root, "unrelated.ts"), "export const x = 1", "utf8");

		expect(await isTracked(root, exec)).toBe(false);

		const result = await commitMemory({
			repoRoot: root,
			exec,
			message: defaultCommitMessage(1),
			push: false,
		});
		expect(result.committed).toBe(true);
		expect(result.pushed).toBe(false);

		const names = await run("git", ["show", "--pretty=format:", "--name-only", "HEAD"], root);
		expect(names.stdout.trim()).toBe(".pi/memory/a.md");

		const log = await run("git", ["log", "-1", "--pretty=%s"], root);
		expect(log.stdout.trim()).toBe("chore(memory): add project memory (1 file)");
	});

	it("reports nothing to commit when the directory is unchanged", async () => {
		const root = await initRepo();
		await mkdir(join(root, ".pi", "memory"), { recursive: true });
		await writeFile(join(root, ".pi", "memory", "a.md"), "alpha", "utf8");
		await commitMemory({ repoRoot: root, exec, message: "first", push: false });

		const second = await commitMemory({ repoRoot: root, exec, message: "second", push: false });
		expect(second.committed).toBe(false);
		expect(second.detail).toContain("No changes");
	});

	it("commits but does not push when no upstream is configured", async () => {
		const root = await initRepo();
		await mkdir(join(root, ".pi", "memory"), { recursive: true });
		await writeFile(join(root, ".pi", "memory", "a.md"), "alpha", "utf8");

		expect(await hasUpstream(root, exec)).toBe(false);
		const result = await commitMemory({ repoRoot: root, exec, message: "memory", push: true });
		expect(result.committed).toBe(true);
		expect(result.pushed).toBe(false);
		expect(result.detail).toContain("no upstream");
	});
});
