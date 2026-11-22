/**
 * Per-machine record of which memory id and location a repository uses.
 *
 * One small JSON file per repository under `<agentDir>/memory/.projects/`,
 * keyed by a hash of the repository root. Nothing is written into the
 * repository: a project settings file would make pi ask for project trust,
 * and a repository must not be able to opt itself into project memory, since
 * that memory is injected into the system prompt.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ID_PATTERN, isMemoryLocation, type MemoryLocation } from "./config.js";

export type ProjectRecord = {
	id: string;
	location: MemoryLocation;
	repoRoot: string;
	updatedAt: string;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Writes JSON through a temp file and a rename, so an interrupted write cannot truncate it. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}

/** Missing file reads as undefined; an unreadable or malformed file throws so it is never overwritten blindly. */
export async function readProjectRecord(path: string): Promise<ProjectRecord | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw new Error(`Cannot read ${path}: ${errorMessage(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`Cannot parse ${path}: ${errorMessage(error)}. Fix or delete the file and retry.`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`Cannot parse ${path}: expected a JSON object.`);
	}
	const raw = parsed as Record<string, unknown>;
	if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id) || !isMemoryLocation(raw.location)) {
		throw new Error(`Cannot parse ${path}: missing or invalid "id" / "location".`);
	}
	return {
		id: raw.id,
		location: raw.location,
		repoRoot: typeof raw.repoRoot === "string" ? raw.repoRoot : "",
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
	};
}

export async function writeProjectRecord(path: string, record: ProjectRecord): Promise<void> {
	await writeJsonAtomic(path, record);
}

/** Changes only the location of an existing record. */
export async function setRecordLocation(path: string, location: MemoryLocation, now: Date = new Date()): Promise<void> {
	const current = await readProjectRecord(path);
	if (current === undefined) throw new Error(`No memory record at ${path}.`);
	await writeProjectRecord(path, { ...current, location, updatedAt: now.toISOString() });
}
