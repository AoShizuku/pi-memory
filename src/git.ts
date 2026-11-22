/**
 * Git integration for project-located memory.
 *
 * Only the memory directory is ever staged or committed, by explicit pathspec,
 * so unrelated work in the repository cannot be swept into the commit.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Exec } from "./types.js";

export const MEMORY_RELATIVE_PATH = ".pi/memory";

export function defaultCommitMessage(files: number): string {
	return `chore(memory): add project memory (${files} ${files === 1 ? "file" : "files"})`;
}

async function resolveExcludePath(repoRoot: string, exec: Exec): Promise<string | undefined> {
	const result = await exec("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoRoot });
	if (result.code !== 0) return undefined;
	const output = result.stdout.trim();
	if (output === "") return undefined;
	return isAbsolute(output) ? output : join(repoRoot, output);
}

/** Appends the memory directory to `.git/info/exclude` when it is not already listed. */
export async function ensureExcluded(repoRoot: string, exec: Exec): Promise<boolean> {
	const path = await resolveExcludePath(repoRoot, exec);
	if (path === undefined) return false;

	let current = "";
	try {
		current = await readFile(path, "utf8");
	} catch {
		// A missing exclude file is normal on a fresh clone.
	}
	const listed = current
		.split("\n")
		.map((line) => line.trim())
		.some((line) => line === MEMORY_RELATIVE_PATH || line === `${MEMORY_RELATIVE_PATH}/`);
	if (listed) return true;

	await mkdir(dirname(path), { recursive: true });
	const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
	await appendFile(path, `${prefix}${MEMORY_RELATIVE_PATH}/\n`, "utf8");
	return true;
}

/** Drops the memory directory from `.git/info/exclude`. Returns true when a line was removed. */
export async function removeFromExclude(repoRoot: string, exec: Exec): Promise<boolean> {
	const path = await resolveExcludePath(repoRoot, exec);
	if (path === undefined) return false;
	let current: string;
	try {
		current = await readFile(path, "utf8");
	} catch {
		return false;
	}
	const kept = current
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			return trimmed !== MEMORY_RELATIVE_PATH && trimmed !== `${MEMORY_RELATIVE_PATH}/`;
		})
		.join("\n");
	if (kept === current) return false;
	await writeFile(path, kept, "utf8");
	return true;
}

export async function isTracked(repoRoot: string, exec: Exec): Promise<boolean> {
	const result = await exec("git", ["ls-files", "--error-unmatch", "--", MEMORY_RELATIVE_PATH], { cwd: repoRoot });
	return result.code === 0;
}

export async function hasUpstream(repoRoot: string, exec: Exec): Promise<boolean> {
	const result = await exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: repoRoot });
	return result.code === 0 && result.stdout.trim() !== "";
}

export type CommitResult = {
	committed: boolean;
	pushed: boolean;
	detail: string;
};

/** Commits on the current branch that the upstream does not have yet. */
export async function commitsAhead(repoRoot: string, exec: Exec): Promise<number | undefined> {
	const result = await exec("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd: repoRoot });
	if (result.code !== 0) return undefined;
	const count = Number.parseInt(result.stdout.trim(), 10);
	return Number.isFinite(count) ? count : undefined;
}

export async function commitMemory(options: {
	repoRoot: string;
	exec: Exec;
	message: string;
	push: boolean;
	/**
	 * Asked before pushing when the branch carries more than the memory commit:
	 * `git push` sends every unpushed commit, not just this one.
	 */
	confirmPush?: (ahead: number) => Promise<boolean>;
}): Promise<CommitResult> {
	const { repoRoot, exec, message, push, confirmPush } = options;

	const status = await exec("git", ["status", "--porcelain", "--", MEMORY_RELATIVE_PATH], { cwd: repoRoot });
	if (status.code !== 0) {
		return { committed: false, pushed: false, detail: `git status failed: ${status.stderr.trim()}` };
	}
	if (status.stdout.trim() === "") {
		return { committed: false, pushed: false, detail: "No changes to commit in .pi/memory." };
	}

	const add = await exec("git", ["add", "-A", "--", MEMORY_RELATIVE_PATH], { cwd: repoRoot });
	if (add.code !== 0) {
		return { committed: false, pushed: false, detail: `git add failed: ${add.stderr.trim()}` };
	}

	const commit = await exec("git", ["commit", "-m", message, "--", MEMORY_RELATIVE_PATH], { cwd: repoRoot });
	if (commit.code !== 0) {
		return { committed: false, pushed: false, detail: `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}` };
	}
	if (!push) {
		return { committed: true, pushed: false, detail: commit.stdout.trim() };
	}
	if (!(await hasUpstream(repoRoot, exec))) {
		return {
			committed: true,
			pushed: false,
			detail: "Committed, but no upstream branch is configured; nothing was pushed.",
		};
	}
	const ahead = await commitsAhead(repoRoot, exec);
	if (ahead !== undefined && ahead > 1 && confirmPush !== undefined && !(await confirmPush(ahead))) {
		return {
			committed: true,
			pushed: false,
			detail: `Committed. Push skipped: the branch is ${ahead} commits ahead of its upstream.`,
		};
	}
	const pushed = await exec("git", ["push"], { cwd: repoRoot });
	if (pushed.code !== 0) {
		return { committed: true, pushed: false, detail: `Committed, but push failed: ${pushed.stderr.trim()}` };
	}
	return { committed: true, pushed: true, detail: pushed.stdout.trim() || "Committed and pushed." };
}
