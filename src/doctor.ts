/**
 * Health checks for the memory directory.
 *
 * The index is maintained by the model, so it drifts: entries point at deleted
 * files, files lose their entry, hooks grow into paragraphs. These checks are
 * deterministic and local, which is the point — they replace asking another
 * model to guess what the memory should look like.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	INDEX_NAME,
	MAX_HOOK_LENGTH,
	listMemoryFiles,
	maxHookExceeded,
	normalizeEntryTarget,
	parseIndex,
	readIndex,
	truncateIndex,
} from "./indexFile.js";
import { scanDirectory } from "./secrets.js";

export type IssueCode =
	| "no-index"
	| "over-budget"
	| "malformed"
	| "escapes"
	| "missing-file"
	| "long-hook"
	| "orphan"
	| "duplicate-description"
	| "secret"
	| "expired-trash";

/** One finding, structured so the /memory panel can attach it to the memory it is about. */
export type DoctorIssue = {
	level: "error" | "warning";
	code: IssueCode;
	message: string;
	/** Memory-relative files the issue is about (forward slashes). */
	files: string[];
	/** The raw index target, for issues about one index entry. */
	target?: string;
	/** An absolute path outside the memory directory (a trash entry). */
	path?: string;
};

export type DoctorReport = {
	ok: boolean;
	issues: DoctorIssue[];
	errors: string[];
	warnings: string[];
	stats: {
		files: number;
		entries: number;
		indexLines: number;
		indexBytes: number;
	};
};

export const TRASH_RETENTION_DAYS = 7;

type Frontmatter = { description?: string };

async function readFrontmatter(file: string): Promise<Frontmatter> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return {};
	}
	const lines = text.split("\n").slice(0, 40);
	if (lines[0]?.trim() !== "---") return {};
	const frontmatter = lines.slice(1).find((line) => line.startsWith("description:"));
	if (!frontmatter) return {};
	return { description: frontmatter.slice("description:".length).trim() };
}

function normalizeDescription(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function runDoctor(
	memoryDir: string,
	options: { now?: Date; trashRoot?: string; maxHookLength?: number } = {},
): Promise<DoctorReport> {
	const issues: DoctorIssue[] = [];
	const error = (code: IssueCode, message: string, extra: Partial<DoctorIssue> = {}) =>
		issues.push({ level: "error", code, message, files: [], ...extra });
	const warning = (code: IssueCode, message: string, extra: Partial<DoctorIssue> = {}) =>
		issues.push({ level: "warning", code, message, files: [], ...extra });
	const maxHook = options.maxHookLength ?? MAX_HOOK_LENGTH;

	const index = await readIndex(memoryDir);
	const files = await listMemoryFiles(memoryDir);
	let entries = 0;
	let indexLines = 0;
	let indexBytes = 0;

	if (!index.exists) {
		warning("no-index", `${INDEX_NAME} does not exist yet.`);
	} else {
		const truncation = truncateIndex(index.raw);
		indexLines = truncation.lineCount;
		indexBytes = truncation.byteCount;
		if (truncation.warning) error("over-budget", truncation.warning);

		const parsed = parseIndex(truncation.content);
		entries = parsed.entries.length;
		for (const line of parsed.malformed) {
			error("malformed", `Malformed index line: ${line.slice(0, 120)}`);
		}

		const referenced = new Set<string>();
		for (const entry of parsed.entries) {
			const target = normalizeEntryTarget(entry.target);
			if (target.kind === "external") continue;
			if (target.kind === "escapes") {
				error("escapes", `Index entry escapes the memory directory: ${entry.target}`, { target: entry.target });
				continue;
			}
			referenced.add(target.path);
			const full = join(memoryDir, target.path);
			try {
				await stat(full);
			} catch {
				error("missing-file", `Index entry points at a missing file: ${entry.target}`, {
					files: [target.path],
					target: entry.target,
				});
			}
			if (maxHookExceeded(entry.hook, maxHook)) {
				warning("long-hook", `Index hook is over ${maxHook} characters: ${entry.target}`, {
					files: [target.path],
					target: entry.target,
				});
			}
		}

		for (const file of files) {
			if (!referenced.has(file)) warning("orphan", `File has no index entry: ${file}`, { files: [file] });
		}
	}

	const descriptions = new Map<string, string[]>();
	for (const file of files) {
		const meta = await readFrontmatter(join(memoryDir, file));
		if (!meta.description) continue;
		const key = normalizeDescription(meta.description);
		if (key === "") continue;
		const bucket = descriptions.get(key);
		if (bucket) bucket.push(file);
		else descriptions.set(key, [file]);
	}
	for (const [, group] of descriptions) {
		if (group.length > 1) warning("duplicate-description", `Duplicate description: ${group.join(", ")}`, { files: group });
	}

	const secrets = await scanDirectory(memoryDir);
	for (const hit of secrets) {
		error("secret", `Possible secret in ${hit.file}:${hit.line} (${hit.rule})`, { files: [hit.file] });
	}

	const trashRoot = options.trashRoot;
	if (trashRoot !== undefined) {
		const now = options.now ?? new Date();
		let trashEntries: string[] = [];
		try {
			trashEntries = await readdir(trashRoot);
		} catch {
			trashEntries = [];
		}
		for (const entry of trashEntries) {
			try {
				const info = await stat(join(trashRoot, entry));
				const ageDays = (now.getTime() - info.mtimeMs) / 86_400_000;
				if (ageDays > TRASH_RETENTION_DAYS) {
					const path = join(trashRoot, entry);
					warning("expired-trash", `Trash entry older than ${TRASH_RETENTION_DAYS} days: ${path}`, { path });
				}
			} catch {
				// Ignore entries that disappear mid-scan.
			}
		}
	}

	const errors = issues.filter((issue) => issue.level === "error").map((issue) => issue.message);
	const warnings = issues.filter((issue) => issue.level === "warning").map((issue) => issue.message);
	return {
		ok: errors.length === 0,
		issues,
		errors,
		warnings,
		stats: { files: files.length, entries, indexLines, indexBytes },
	};
}

/** Directories that doctor may offer to purge; used by `/memory doctor --purge`. */
export async function listExpiredTrash(trashRoot: string, now = new Date()): Promise<string[]> {
	let entries: string[] = [];
	try {
		entries = await readdir(trashRoot);
	} catch {
		return [];
	}
	const expired: string[] = [];
	for (const entry of entries) {
		const full = join(trashRoot, entry);
		try {
			const info = await stat(full);
			if ((now.getTime() - info.mtimeMs) / 86_400_000 > TRASH_RETENTION_DAYS) expired.push(full);
		} catch {
			// Ignore.
		}
	}
	return expired;
}

export function formatReport(report: DoctorReport): string {
	const lines = [
		`memory: ${report.stats.files} files, ${report.stats.entries} index entries`,
		`index: ${report.stats.indexLines} lines, ${report.stats.indexBytes} bytes`,
	];
	if (report.errors.length > 0) {
		lines.push("", "errors:");
		for (const error of report.errors) lines.push(`  - ${error}`);
	}
	if (report.warnings.length > 0) {
		lines.push("", "warnings:");
		for (const warning of report.warnings) lines.push(`  - ${warning}`);
	}
	if (report.errors.length === 0 && report.warnings.length === 0) lines.push("", "No issues found.");
	return lines.join("\n");
}
