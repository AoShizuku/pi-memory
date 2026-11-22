/**
 * Moves the memory directory between the project and the machine.
 *
 * Order is fixed: copy to a temp sibling, verify every file by size and hash,
 * rename into place, flip the recorded location, then retire the source into
 * a trash directory. Nothing is deleted in place. Until the flip, a failure
 * rolls back to the source; after the flip the target is live and failures
 * only produce warnings. Recovery after a crash reads the recorded location to
 * tell which side is live.
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, stat, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MemoryLocation } from "./config.js";
import { isInside } from "./paths.js";
import { writeJsonAtomic } from "./registry.js";

export type MigrationPhase = "copying" | "verifying" | "promoting" | "flipping" | "retiring";

export type MigrationState = {
	version: 1;
	phase: MigrationPhase;
	from: MemoryLocation;
	to: MemoryLocation;
	src: string;
	dst: string;
	tmp: string;
	startedAt: string;
};

/**
 * `moved`: files were copied and the source retired. `adopted`: the source was
 * empty and the target already held memory, so only the location changed.
 * `switched`: neither side held memory; only the location changed.
 */
export type MigrationMode = "moved" | "adopted" | "switched";

export type MigrationResult = {
	mode: MigrationMode;
	files: number;
	src: string;
	dst: string;
	trash: string | undefined;
	warnings: string[];
};

export type MigrationErrorCode = "dst-not-empty" | "nested" | "copy-failed" | "verify-failed" | "flip-failed";

export class MigrationError extends Error {
	readonly code: MigrationErrorCode;

	constructor(code: MigrationErrorCode, message: string) {
		super(message);
		this.name = "MigrationError";
		this.code = code;
	}
}

export type ManifestEntry = {
	path: string;
	size: number;
	sha256: string;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function timestamp(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

async function isDirectoryEmpty(dir: string): Promise<boolean> {
	const entries = await readdir(dir);
	return entries.length === 0;
}

/** Sorted `path + size + sha256` for every file under `dir`, excluding dot-directories. Missing dir reads as empty. */
export async function buildManifest(dir: string): Promise<ManifestEntry[]> {
	if (!(await pathExists(dir))) return [];
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	const files: ManifestEntry[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const full = join(entry.parentPath, entry.name);
		const relative = full.slice(dir.length).replace(/^[/\\]/, "").split("\\").join("/");
		if (relative.split("/").some((part) => part.startsWith("."))) continue;
		const buffer = await readFile(full);
		files.push({
			path: relative,
			size: buffer.byteLength,
			sha256: createHash("sha256").update(buffer).digest("hex"),
		});
	}
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function manifestsEqual(left: readonly ManifestEntry[], right: readonly ManifestEntry[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((entry, index) => {
		const other = right[index];
		return other !== undefined && entry.path === other.path && entry.size === other.size && entry.sha256 === other.sha256;
	});
}

async function copyTree(src: string, dst: string): Promise<void> {
	await mkdir(dirname(dst), { recursive: true });
	await cp(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: false, force: true });
}

/** Same-filesystem rename, falling back to copy + verify + remove across devices. */
async function moveTree(src: string, dst: string): Promise<void> {
	await mkdir(dirname(dst), { recursive: true });
	try {
		await rename(src, dst);
		return;
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EXDEV") {
			throw error;
		}
	}
	const before = await buildManifest(src);
	await copyTree(src, dst);
	const after = await buildManifest(dst);
	if (!manifestsEqual(before, after)) {
		throw new MigrationError("copy-failed", `Cross-device copy of ${src} did not verify; source left untouched.`);
	}
	await rm(src, { recursive: true, force: true });
}

/**
 * Moves a directory into the trash and stamps it with the current time.
 * A rename keeps the directory's old mtime, and trash retention is measured
 * from mtime, so without the stamp a fresh copy could be purged at once.
 */
export async function retireDirectory(src: string, trashRoot: string, label: string, now: Date): Promise<string> {
	const trash = join(trashRoot, `${label}-${timestamp(now)}`);
	await moveTree(src, trash);
	await utimes(trash, now, now);
	return trash;
}

async function writeState(path: string, state: MigrationState): Promise<void> {
	await writeJsonAtomic(path, state);
}

export async function readMigrationState(path: string): Promise<MigrationState | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as MigrationState;
	} catch {
		return undefined;
	}
}

export async function clearMigrationState(path: string): Promise<void> {
	await rm(path, { force: true });
}

export type RecoverOptions = {
	/** The location currently recorded for the repository; tells which side of the move is live. */
	readLocation: () => Promise<MemoryLocation | undefined>;
	trashRoot: string;
	now?: Date;
};

/**
 * Resolves an interrupted migration. Never deletes the live side: when the
 * recorded location already points at the target, the stale source is moved
 * into the trash; otherwise the source is live and only copies that match it
 * exactly are removed.
 */
export async function recoverMigration(statePath: string, options: RecoverOptions): Promise<string | undefined> {
	const state = await readMigrationState(statePath);
	if (!state) return undefined;
	const now = options.now ?? new Date();
	const id = basename(statePath, ".json");

	await rm(state.tmp, { recursive: true, force: true });
	let location: MemoryLocation | undefined;
	try {
		location = await options.readLocation();
	} catch {
		location = undefined;
	}

	if (location === state.to) {
		let note = "";
		if (await pathExists(state.src)) {
			try {
				const trash = await retireDirectory(state.src, options.trashRoot, `${id}-${state.from}`, now);
				note = ` The old copy was moved to ${trash}.`;
			} catch (error) {
				note = ` The old copy at ${state.src} could not be moved to the trash (${errorMessage(error)}); remove it manually.`;
			}
		}
		await clearMigrationState(statePath);
		return `A previous memory migration stopped during "${state.phase}" after switching; memory is at ${state.dst}.${note}`;
	}

	if (await pathExists(state.src)) {
		let note = "";
		const targetMayHoldCopy = state.phase !== "copying" && state.phase !== "verifying";
		if (targetMayHoldCopy) {
			const target = await buildManifest(state.dst);
			if (target.length > 0) {
				if (manifestsEqual(await buildManifest(state.src), target)) {
					await rm(state.dst, { recursive: true, force: true });
					note = " The unfinished copy at the target was removed.";
				} else {
					note = ` The target ${state.dst} differs from the source and was left in place; check it before switching again.`;
				}
			}
		}
		await clearMigrationState(statePath);
		return `A previous memory migration stopped during "${state.phase}". The source is intact at ${state.src}; the temporary copy was removed.${note} Run /memory switch ${state.to} again.`;
	}

	await clearMigrationState(statePath);
	if (await pathExists(state.dst)) {
		return `A previous memory migration left memory only at ${state.dst}, but the recorded location is still ${state.from}. Run /memory switch ${state.to} to use it.`;
	}
	return `A previous memory migration left no source (${state.src}) and no target (${state.dst}). Check the trash directory before continuing.`;
}

export type MigrateOptions = {
	id: string;
	from: MemoryLocation;
	to: MemoryLocation;
	src: string;
	dst: string;
	statePath: string;
	trashRoot: string;
	/** Persists the new location. Called once, after the target is verified. */
	setLocation: (location: MemoryLocation) => Promise<void>;
	now?: Date;
};

async function flip(options: MigrateOptions): Promise<void> {
	try {
		await options.setLocation(options.to);
	} catch (error) {
		throw new MigrationError("flip-failed", `Could not record the new location: ${errorMessage(error)}`);
	}
}

export async function migrateMemory(options: MigrateOptions): Promise<MigrationResult> {
	const now = options.now ?? new Date();
	const { src, dst } = options;

	if (isInside(src, dst) || isInside(dst, src)) {
		throw new MigrationError("nested", `Refusing to migrate ${src} into ${dst}: the paths overlap.`);
	}

	const sourceFiles = await buildManifest(src);
	const targetFiles = await buildManifest(dst);
	if (sourceFiles.length === 0) {
		// Nothing to move: switch the location and use whatever already lives at the target.
		await flip(options);
		return {
			mode: targetFiles.length > 0 ? "adopted" : "switched",
			files: targetFiles.length,
			src,
			dst,
			trash: undefined,
			warnings: [],
		};
	}
	if ((await pathExists(dst)) && !(await isDirectoryEmpty(dst))) {
		throw new MigrationError(
			"dst-not-empty",
			`Target already exists and is not empty: ${dst}. Move it aside first; pi-memory will not merge.`,
		);
	}

	const tmp = `${dst}.tmp-${timestamp(now)}`;
	const state: MigrationState = {
		version: 1,
		phase: "copying",
		from: options.from,
		to: options.to,
		src,
		dst,
		tmp,
		startedAt: now.toISOString(),
	};
	let promoted = false;
	let sourceManifest: ManifestEntry[];

	try {
		await writeState(options.statePath, state);
		await copyTree(src, tmp);

		state.phase = "verifying";
		await writeState(options.statePath, state);
		sourceManifest = await buildManifest(src);
		if (!manifestsEqual(sourceManifest, await buildManifest(tmp))) {
			throw new MigrationError("verify-failed", `Copy verification failed for ${src}. The source is unchanged.`);
		}

		state.phase = "promoting";
		await writeState(options.statePath, state);
		if (await pathExists(dst)) {
			if (!(await isDirectoryEmpty(dst))) {
				throw new MigrationError("dst-not-empty", `Target appeared while migrating: ${dst}`);
			}
			await rmdir(dst);
		}
		await rename(tmp, dst);
		promoted = true;
		if (!manifestsEqual(sourceManifest, await buildManifest(dst))) {
			throw new MigrationError("verify-failed", `Verification after promoting ${dst} failed. The source is unchanged.`);
		}

		state.phase = "flipping";
		await writeState(options.statePath, state);
		await flip(options);
	} catch (error) {
		await rm(tmp, { recursive: true, force: true });
		if (promoted) await rm(dst, { recursive: true, force: true });
		await clearMigrationState(options.statePath);
		if (error instanceof MigrationError) throw error;
		throw new MigrationError("copy-failed", `Memory migration failed: ${errorMessage(error)}. The source is unchanged.`);
	}

	// The target is live from here on: failures become warnings, never a rollback.
	const warnings: string[] = [];
	let trash: string | undefined;
	try {
		state.phase = "retiring";
		await writeState(options.statePath, state);
		trash = await retireDirectory(src, options.trashRoot, `${options.id}-${options.from}`, now);
	} catch (error) {
		warnings.push(
			`Memory moved to ${dst}, but the old directory at ${src} could not be retired: ${errorMessage(error)}. Remove it manually.`,
		);
	}
	try {
		await clearMigrationState(options.statePath);
	} catch (error) {
		warnings.push(`Could not remove the migration state file ${options.statePath}: ${errorMessage(error)}.`);
	}
	return { mode: "moved", files: sourceManifest.length, src, dst, trash, warnings };
}
