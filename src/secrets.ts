/**
 * Detects likely credentials in memory content.
 *
 * Memory files get committed, pushed, and synced, so a secret written there
 * leaks further than one written into code. The gate runs before a write and
 * before a commit; it reports the rule and a masked preview, never the value.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type SecretRule = { name: string; pattern: RegExp };

export const SECRET_RULES: readonly SecretRule[] = [
	{ name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
	{ name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
	{ name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/ },
	{ name: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/ },
	{ name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
	{ name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
	{ name: "generic-assignment", pattern: /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,}/i },
];

export type SecretHit = {
	rule: string;
	line: number;
	preview: string;
};

function mask(match: string): string {
	const head = match.slice(0, 4);
	return `${head}***(${match.length} chars)`;
}

/** Scans one text blob. Lines are 1-based. */
export function scanContent(content: string): SecretHit[] {
	const lines = content.split("\n");
	const hits: SecretHit[] = [];
	for (const [index, line] of lines.entries()) {
		for (const rule of SECRET_RULES) {
			const match = rule.pattern.exec(line);
			if (!match) continue;
			hits.push({ rule: rule.name, line: index + 1, preview: mask(match[0]) });
		}
	}
	return hits;
}

export function formatHits(file: string, hits: readonly SecretHit[]): string {
	return hits.map((hit) => `  ${file}:${hit.line}  ${hit.rule}  ${hit.preview}`).join("\n");
}

export type FileSecretHit = SecretHit & { file: string };

/** Scans every `.md` file in a directory tree. Unreadable entries are skipped. */
export async function scanDirectory(dir: string): Promise<FileSecretHit[]> {
	let entries: string[];
	try {
		entries = await readdir(dir, { recursive: true });
	} catch {
		return [];
	}

	const targets = entries.filter((entry) => entry.endsWith(".md"));
	const results: FileSecretHit[] = [];
	for (const target of targets) {
		let content: string;
		try {
			content = await readFile(join(dir, target), "utf8");
		} catch {
			continue;
		}
		// Report with forward slashes on every platform, matching listMemoryFiles.
		const file = target.split("\\").join("/");
		for (const hit of scanContent(content)) {
			results.push({ ...hit, file });
		}
	}
	return results;
}
