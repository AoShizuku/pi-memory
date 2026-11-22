/**
 * Resolves where the memory directory and its bookkeeping live.
 *
 * `project` keeps memory inside the repository at `.pi/memory/`; `local` keeps
 * it under pi's agent directory, keyed by a stable id. Which one a repository
 * uses is recorded per machine under `<agentDir>/memory/projects/`, never in
 * the repository itself.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryLocation } from "./config.js";
import type { Exec } from "./types.js";

export const MEMORY_DIR_NAME = "memory";
export const PROJECT_MEMORY_RELATIVE = ".pi/memory";

export function hashId(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** `repo-<hash of remote>` when a remote exists, `path-<hash of root>` otherwise. */
export function deriveId(repoRoot: string, remoteUrl: string | undefined): string {
	const remote = remoteUrl?.trim();
	if (remote) return `repo-${hashId(remote)}`;
	return `path-${hashId(resolve(repoRoot))}`;
}

export async function resolveRepoRoot(cwd: string, exec: Exec): Promise<string> {
	const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code === 0) {
		const root = result.stdout.trim();
		if (root) return resolve(root);
	}
	return resolve(cwd);
}

export async function readRemoteUrl(repoRoot: string, exec: Exec): Promise<string | undefined> {
	const result = await exec("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
	if (result.code !== 0) return undefined;
	const url = result.stdout.trim();
	return url === "" ? undefined : url;
}

export function memoryDirFor(options: {
	location: MemoryLocation;
	id: string;
	repoRoot: string;
	agentDir: string;
}): string {
	if (options.location === "project") {
		return join(options.repoRoot, PROJECT_MEMORY_RELATIVE);
	}
	return join(options.agentDir, MEMORY_DIR_NAME, options.id);
}

export function trashRootFor(agentDir: string): string {
	return join(agentDir, MEMORY_DIR_NAME, ".trash");
}

export function migrationsRootFor(agentDir: string): string {
	return join(agentDir, MEMORY_DIR_NAME, ".migrations");
}

export function migrationStatePathFor(agentDir: string, id: string): string {
	return join(migrationsRootFor(agentDir), `${id}.json`);
}

/** Resolved path used for comparisons: case-folded on Windows, where paths are case-insensitive. */
export function pathKey(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** The per-machine record for one repository, keyed by a hash of its root path. */
export function projectRecordPathFor(agentDir: string, repoRoot: string): string {
	const key = createHash("sha256").update(pathKey(repoRoot)).digest("hex").slice(0, 16);
	return join(agentDir, MEMORY_DIR_NAME, ".projects", `${key}.json`);
}

/** True when `child` is `parent` or lives beneath it. Case-insensitive on Windows. */
export function isInside(parent: string, child: string): boolean {
	const p = pathKey(parent);
	const c = pathKey(child);
	if (c === p) return true;
	return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Git Bash, MSYS, Cygwin, and WSL drive paths (`/c/Users`, `/mnt/c/Users`) to `C:\Users`. */
function windowsShellPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
	const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
	if (!match) return path;
	const suffix = match[2]?.replaceAll("/", "\\") ?? "";
	return `${(match[1] ?? "").toUpperCase()}:\\${suffix}`;
}

/**
 * Resolves a `write`/`edit` tool path the way pi's file tools do: unicode
 * spaces, a leading `@`, Windows shell drive paths, `~`, and `file://` URLs.
 * The memory gate must see the same target the tool will write.
 */
export function resolveToolPath(input: string, cwd: string, home: string = homedir()): string {
	let path = input.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (process.platform === "win32") path = windowsShellPath(path);
	if (path === "~") {
		path = home;
	} else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
		path = join(home, path.slice(2));
	}
	if (path.startsWith("file://")) path = fileURLToPath(path);
	return resolve(cwd, path);
}
