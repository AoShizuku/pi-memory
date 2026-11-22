/**
 * Reads, parses, and truncates the `MEMORY.md` index.
 *
 * The index is injected on every turn, so it has a hard line and byte budget.
 * Truncation keeps whole lines and appends a warning that names the cap that
 * fired, which is the signal that the index needs splitting.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

export const INDEX_NAME = "MEMORY.md";
export const MAX_INDEX_LINES = 150;
export const MAX_INDEX_BYTES = 12 * 1024;
export const MAX_HOOK_LENGTH = 160;

export type IndexEntry = {
	title: string;
	target: string;
	hook: string;
	raw: string;
};

export type IndexParse = {
	entries: IndexEntry[];
	malformed: string[];
};

export type IndexTruncation = {
	content: string;
	lineCount: number;
	byteCount: number;
	wasLineTruncated: boolean;
	wasByteTruncated: boolean;
	warning?: string;
};

const ENTRY_PATTERN = /^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[-—–]{1,2}\s*)?(.*)$/;

export function parseIndex(content: string): IndexParse {
	const entries: IndexEntry[] = [];
	const malformed: string[] = [];
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(">")) continue;
		// `.` stops at "\r", so a CRLF index would read as all malformed; `raw` keeps it for exact line matching.
		const match = ENTRY_PATTERN.exec(raw.replace(/\r$/u, ""));
		if (!match) {
			malformed.push(line);
			continue;
		}
		const [, title, target, hook] = match;
		if (title === undefined || target === undefined) continue;
		entries.push({ title, target, hook: (hook ?? "").trim(), raw });
	}
	return { entries, malformed };
}

export type EntryTarget =
	| { kind: "file"; path: string }
	| { kind: "external" }
	| { kind: "escapes" };

/**
 * Normalizes an index link to a memory-relative path with forward slashes,
 * independent of the host platform. Anchors and URL encoding are removed;
 * URLs are external; absolute paths and `..` escapes are rejected.
 */
export function normalizeEntryTarget(raw: string): EntryTarget {
	let target = raw.trim().replace(/#.*$/u, "");
	if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(target) || target.startsWith("mailto:")) return { kind: "external" };
	try {
		target = decodeURIComponent(target);
	} catch {
		// Keep the raw text when it is not valid URL encoding.
	}
	target = target.replaceAll("\\", "/");
	if (target.startsWith("/") || /^[a-z]:/iu.test(target)) return { kind: "escapes" };
	const normalized = posix.normalize(target).replace(/^\.\//u, "");
	if (normalized === ".." || normalized.startsWith("../")) return { kind: "escapes" };
	return { kind: "file", path: normalized };
}

export function formatIndexEntry(title: string, target: string, hook: string): string {
	return `- [${title}](${target}) - ${hook}`;
}

export function maxHookExceeded(hook: string, limit: number = MAX_HOOK_LENGTH): boolean {
	return hook.trim().length > limit;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Cuts UTF-8 text to at most `maxBytes` bytes, at the last newline when there
 * is one, otherwise at the last whole character. Works on bytes, not UTF-16
 * indices, so CJK text (3 bytes per character) respects the cap.
 */
function cutToBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	const newline = buffer.lastIndexOf(0x0a, maxBytes);
	if (newline > 0) return buffer.subarray(0, newline).toString("utf8");
	let cut = maxBytes;
	// Step back over UTF-8 continuation bytes (10xxxxxx) so no character is split.
	while (cut > 0 && ((buffer[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
	return buffer.subarray(0, cut).toString("utf8");
}

/** Applies the line cap first, then the byte cap at a line boundary. */
export function truncateIndex(raw: string): IndexTruncation {
	const trimmed = raw.trim();
	const lines = trimmed.split("\n");
	const lineCount = lines.length;
	const byteCount = Buffer.byteLength(trimmed, "utf8");

	const wasLineTruncated = lineCount > MAX_INDEX_LINES;
	const wasByteTruncated = byteCount > MAX_INDEX_BYTES;

	if (!wasLineTruncated && !wasByteTruncated) {
		return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
	}

	const kept = cutToBytes(wasLineTruncated ? lines.slice(0, MAX_INDEX_LINES).join("\n") : trimmed, MAX_INDEX_BYTES);

	const reasons: string[] = [];
	if (wasLineTruncated) reasons.push(`${lineCount} lines (limit ${MAX_INDEX_LINES})`);
	if (wasByteTruncated) reasons.push(`${formatSize(byteCount)} (limit ${formatSize(MAX_INDEX_BYTES)})`);
	const reason = reasons.join(" and ");
	const warning = `${INDEX_NAME} is ${reason}. Only part of it was loaded. Keep one line per entry and move detail into topic files.`;

	return {
		content: `${kept}\n\n> WARNING: ${warning}`,
		lineCount,
		byteCount,
		wasLineTruncated,
		wasByteTruncated,
		warning,
	};
}

export async function readIndex(memoryDir: string): Promise<{ exists: boolean; raw: string }> {
	try {
		const raw = await readFile(join(memoryDir, INDEX_NAME), "utf8");
		return { exists: true, raw };
	} catch {
		return { exists: false, raw: "" };
	}
}

/** Every `.md` file in the tree except the index and dotfiles, sorted for stable output. */
export async function listMemoryFiles(memoryDir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(memoryDir, { recursive: true });
	} catch {
		return [];
	}
	return entries
		.map((entry) => entry.split("\\").join("/"))
		.filter((entry) => entry.endsWith(".md"))
		.filter((entry) => entry !== INDEX_NAME && !entry.split("/").some((part) => part.startsWith(".")))
		.sort();
}
