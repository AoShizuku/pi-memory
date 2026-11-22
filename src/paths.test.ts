import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import type { Exec } from "./types.js";
import {
	deriveId,
	hashId,
	isInside,
	memoryDirFor,
	migrationStatePathFor,
	projectRecordPathFor,
	resolveRepoRoot,
	resolveToolPath,
	trashRootFor,
} from "./paths.js";

function fakeExec(responses: Record<string, { stdout: string; code: number }>): Exec {
	return async (command, args) => {
		const key = [command, ...args].join(" ");
		const response = responses[key];
		if (response === undefined) return { stdout: "", stderr: "not found", code: 1 };
		return { stdout: response.stdout, stderr: "", code: response.code };
	};
}

const REPO = resolve("/repo");
const AGENT = resolve("/agent");
const isWindows = process.platform === "win32";

describe("deriveId", () => {
	it("hashes the remote when one exists", () => {
		expect(deriveId(REPO, "git@github.com:me/repo.git")).toBe(`repo-${hashId("git@github.com:me/repo.git")}`);
	});

	it("falls back to the resolved root without a remote", () => {
		expect(deriveId(REPO, undefined)).toBe(`path-${hashId(REPO)}`);
	});

	it("is stable across calls", () => {
		expect(deriveId(REPO, "https://example.com/a.git")).toBe(deriveId(REPO, "https://example.com/a.git"));
	});
});

describe("memoryDirFor", () => {
	it("puts project memory inside the repo", () => {
		expect(memoryDirFor({ location: "project", id: "repo-1", repoRoot: REPO, agentDir: AGENT })).toBe(
			join(REPO, ".pi", "memory"),
		);
	});

	it("puts local memory under the agent directory keyed by id", () => {
		expect(memoryDirFor({ location: "local", id: "repo-1", repoRoot: REPO, agentDir: AGENT })).toBe(
			join(AGENT, "memory", "repo-1"),
		);
	});
});

describe("isInside", () => {
	it("accepts the directory itself and children", () => {
		expect(isInside("/a/b", "/a/b")).toBe(true);
		expect(isInside("/a/b", "/a/b/c.md")).toBe(true);
	});

	it("rejects siblings and prefix lookalikes", () => {
		expect(isInside("/a/b", "/a/bc/c.md")).toBe(false);
		expect(isInside("/a/b", "/a/c")).toBe(false);
	});

	it.runIf(isWindows)("ignores case on Windows", () => {
		expect(isInside("C:\\Users\\Me\\memory", "c:\\users\\me\\MEMORY\\a.md")).toBe(true);
	});
});

describe("resolveToolPath", () => {
	const cwd = resolve("/work");
	const home = resolve("/home/me");

	it("resolves relative paths against cwd", () => {
		expect(resolveToolPath("notes/a.md", cwd, home)).toBe(join(cwd, "notes", "a.md"));
	});

	it("expands ~ and strips a leading @ like pi's file tools", () => {
		expect(resolveToolPath("~/.pi/agent/memory/a.md", cwd, home)).toBe(join(home, ".pi", "agent", "memory", "a.md"));
		expect(resolveToolPath("~", cwd, home)).toBe(home);
		expect(resolveToolPath("@notes/a.md", cwd, home)).toBe(join(cwd, "notes", "a.md"));
	});

	it("accepts file:// URLs and unicode spaces", () => {
		const file = join(home, "a.md");
		expect(resolveToolPath(pathToFileURL(file).href, cwd, home)).toBe(file);
		expect(resolveToolPath("my\u00A0notes.md", cwd, home)).toBe(join(cwd, "my notes.md"));
	});

	it.runIf(isWindows)("converts Git Bash drive paths on Windows", () => {
		expect(resolveToolPath("/c/Users/me/a.md", cwd, home)).toBe("C:\\Users\\me\\a.md");
		expect(resolveToolPath("/mnt/d/x.md", cwd, home)).toBe("D:\\x.md");
	});
});

describe("resolveRepoRoot", () => {
	it("uses the git toplevel when available", async () => {
		const exec = fakeExec({ "git rev-parse --show-toplevel": { stdout: "/repo\n", code: 0 } });
		expect(await resolveRepoRoot(join(REPO, "sub"), exec)).toBe(REPO);
	});

	it("falls back to the working directory outside a repo", async () => {
		const exec = fakeExec({});
		expect(await resolveRepoRoot("/work", exec)).toBe(resolve("/work"));
	});
});

describe("bookkeeping paths", () => {
	it("keeps bookkeeping outside any memory directory", () => {
		expect(trashRootFor(AGENT)).toBe(join(AGENT, "memory", ".trash"));
		expect(migrationStatePathFor(AGENT, "repo-1")).toBe(join(AGENT, "memory", ".migrations", "repo-1.json"));
	});

	it("keys project records by repository root", () => {
		const record = projectRecordPathFor(AGENT, REPO);
		expect(record.startsWith(join(AGENT, "memory", ".projects"))).toBe(true);
		expect(projectRecordPathFor(AGENT, join(REPO, "sub", ".."))).toBe(record);
		expect(projectRecordPathFor(AGENT, resolve("/other"))).not.toBe(record);
	});

	it.runIf(isWindows)("maps differently cased roots to one record on Windows", () => {
		expect(projectRecordPathFor(AGENT, "C:\\Repo")).toBe(projectRecordPathFor(AGENT, "c:\\repo"));
	});
});
