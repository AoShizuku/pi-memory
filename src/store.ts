/**
 * The memory directory as the /memory panel sees it: one item per index
 * entry, then one per topic file the index does not mention, each with the
 * doctor findings that concern it. Also the two things a person can do from
 * the panel: delete a memory and purge an expired trash entry.
 *
 * Deleting never removes a file in place: it moves into the same trash the
 * migrations use, stamped with the current time so the 7-day retention starts
 * now. The index line goes with it, re-read from disk right before the write
 * so a line the model added meanwhile is kept.
 */

import { copyFile, mkdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import { runDoctor, type DoctorIssue, type DoctorReport } from "./doctor.js";
import { INDEX_NAME, listMemoryFiles, normalizeEntryTarget, parseIndex, readIndex, truncateIndex } from "./indexFile.js";

export type MemoryItem = {
	/** Stable across reloads while the index line or file stays: selection and confirmation are bound to it. */
	key: string;
	kind: "entry" | "orphan";
	title: string;
	/** The index hook, or the file's description for a file with no entry. */
	hook: string;
	/** The raw index link (entries only). */
	target?: string;
	/** Memory-relative path, when the item is a file inside the memory directory. */
	file?: string;
	external: boolean;
	exists: boolean;
	/** Past the index budget: the model never sees this entry. */
	cut: boolean;
	type?: string;
	/** Raw file text, frontmatter included. */
	text: string;
	/** File text after the frontmatter. */
	body: string;
	modified?: Date;
	/** The index line exactly as on disk (entries only). */
	raw?: string;
	issues: DoctorIssue[];
};

export type MemoryView = {
	items: MemoryItem[];
	issues: DoctorIssue[];
	stats: DoctorReport["stats"];
	indexExists: boolean;
	overBudget: boolean;
};

export const CUT_MESSAGE = "Past the index budget: not loaded into the prompt.";

export type Frontmatter ={ fields: Record<string, string>; body: string };

/**
 * Splits `---` frontmatter from the body. Nested keys (`metadata:\n  type: x`)
 * are read flat: the panel only needs a handful of scalar fields.
 */
export function splitFrontmatter(text: string): Frontmatter {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return { fields: {}, body: text };
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) return { fields: {}, body: text };
	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const match = /^\s*([A-Za-z_][\w-]*):\s*(.*?)\s*$/u.exec(line);
		if (!match) continue;
		const [, key, value] = match;
		if (key === undefined || value === undefined || value === "" || key in fields) continue;
		fields[key] = value.replace(/^(["'])(.*)\1$/u, "$2");
	}
	return { fields, body: lines.slice(end + 1).join("\n").replace(/^\s*\n/u, "") };
}

type FileInfo = { exists: boolean; text: string; modified?: Date };

async function readMemoryFile(path: string): Promise<FileInfo> {
	try {
		const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		return { exists: true, text: text.replaceAll("\r\n", "\n"), modified: info.mtime };
	} catch {
		return { exists: false, text: "" };
	}
}

function issuesFor(issues: readonly DoctorIssue[], file: string | undefined, target: string | undefined): DoctorIssue[] {
	return issues.filter(
		(issue) => (file !== undefined && issue.files.includes(file)) || (target !== undefined && issue.target === target),
	);
}

export async function loadMemory(memoryDir: string, trashRoot: string): Promise<MemoryView> {
	const report = await runDoctor(memoryDir, { trashRoot });
	const index = await readIndex(memoryDir);
	const parsed = parseIndex(index.raw);
	const loaded = index.exists ? parseIndex(truncateIndex(index.raw).content).entries.length : 0;

	const items: MemoryItem[] = [];
	const seen = new Map<string, number>();
	const referenced = new Set<string>();
	for (const [position, entry] of parsed.entries.entries()) {
		const target = normalizeEntryTarget(entry.target);
		const file = target.kind === "file" ? target.path : undefined;
		if (file !== undefined) referenced.add(file);
		const base = `entry:${file ?? entry.target}`;
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		const info: FileInfo = file === undefined ? { exists: false, text: "" } : await readMemoryFile(join(memoryDir, file));
		const { fields, body } = splitFrontmatter(info.text);
		const cut = position >= loaded;
		const issues = issuesFor(report.issues, file, entry.target);
		// Doctor reports the budget once for the whole index; the panel also marks each entry that fell off it.
		if (cut) issues.push({ level: "warning", code: "over-budget", message: CUT_MESSAGE, files: [] });
		items.push({
			key: count === 1 ? base : `${base}#${count}`,
			kind: "entry",
			title: entry.title,
			hook: entry.hook,
			target: entry.target,
			file,
			external: target.kind === "external",
			exists: info.exists,
			cut,
			type: fields.type,
			text: info.text,
			body,
			modified: info.modified,
			raw: entry.raw,
			issues,
		});
	}

	for (const file of await listMemoryFiles(memoryDir)) {
		if (referenced.has(file)) continue;
		const info = await readMemoryFile(join(memoryDir, file));
		const { fields, body } = splitFrontmatter(info.text);
		items.push({
			key: `file:${file}`,
			kind: "orphan",
			title: fields.name ?? posix.basename(file, ".md"),
			hook: fields.description ?? "",
			file,
			external: false,
			exists: info.exists,
			cut: false,
			type: fields.type,
			text: info.text,
			body,
			modified: info.modified,
			issues: issuesFor(report.issues, file, undefined),
		});
	}

	return {
		items,
		issues: report.issues,
		stats: report.stats,
		indexExists: index.exists,
		overBudget: report.issues.some((issue) => issue.code === "over-budget"),
	};
}

function timestamp(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

async function moveFile(src: string, dst: string): Promise<void> {
	await mkdir(dirname(dst), { recursive: true });
	try {
		await rename(src, dst);
	} catch (error) {
		// The trash lives under the agent directory; project memory may sit on another drive.
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await copyFile(src, dst);
		await unlink(src);
	}
}

/** What deleting the item does, in words for the confirmation prompt and the notice. */
export function deleteEffect(item: MemoryItem): string {
	if (item.kind === "orphan") return `move ${item.file} to trash`;
	if (item.file !== undefined && item.exists) return `move ${item.file} to trash and drop its index line`;
	return `drop the index line for ${item.file ?? item.target}`;
}

export class StaleIndexError extends Error {}

/**
 * Deletes one memory. Entries lose their index line; their file moves to the
 * trash unless another index line still points at it. Files with no entry
 * just move to the trash. Returns the notice to show.
 */
export async function deleteMemory(
	memoryDir: string,
	trashRoot: string,
	label: string,
	item: MemoryItem,
	now: Date = new Date(),
): Promise<string> {
	const indexPath = join(memoryDir, INDEX_NAME);
	let nextIndex: string | undefined;
	let moveTarget = item.kind === "orphan" ? item.file : undefined;

	if (item.kind === "entry") {
		const current = await readFile(indexPath, "utf8").catch(() => {
			throw new StaleIndexError(`${INDEX_NAME} is gone`);
		});
		const lines = current.split("\n");
		const at = lines.indexOf(item.raw ?? "");
		if (at < 0) throw new StaleIndexError(`${INDEX_NAME} changed since the panel loaded it`);
		lines.splice(at, 1);
		nextIndex = lines.join("\n");
		if (item.file !== undefined && item.exists) {
			const stillUsed = parseIndex(nextIndex).entries.some((entry) => {
				const target = normalizeEntryTarget(entry.target);
				return target.kind === "file" && target.path === item.file;
			});
			if (!stillUsed) moveTarget = item.file;
		}
	}

	let trashed: string | undefined;
	if (moveTarget !== undefined) {
		const bucket = join(trashRoot, `${label}-file-${timestamp(now)}`);
		trashed = join(bucket, ...moveTarget.split("/"));
		await moveFile(join(memoryDir, ...moveTarget.split("/")), trashed);
		// A rename keeps the old mtime; the trash retention is measured from now.
		await utimes(bucket, now, now).catch(() => undefined);
	}
	if (nextIndex !== undefined) {
		try {
			await writeFile(indexPath, nextIndex, "utf8");
		} catch (error) {
			const where = trashed ? ` The file is already in ${trashed}.` : "";
			throw new Error(`could not rewrite ${INDEX_NAME}: ${(error as Error).message}.${where}`);
		}
	}

	if (item.kind === "orphan") return `moved ${item.file} to trash`;
	if (moveTarget !== undefined) return `deleted ${item.title} (${moveTarget} in trash)`;
	return `dropped the index line for ${item.title}`;
}

/** Permanently removes one expired trash entry; refuses anything outside the trash root. */
export async function purgeTrash(trashRoot: string, path: string): Promise<string> {
	if (dirname(path) !== trashRoot) throw new Error(`not a trash entry: ${path}`);
	await rm(path, { recursive: true, force: true });
	return `purged ${path.slice(trashRoot.length + 1)}`;
}
