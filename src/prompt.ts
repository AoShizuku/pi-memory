/**
 * The text injected as the `memory` system prompt section.
 *
 * Deliberately short: the taxonomy is one line, the mechanics are one
 * sentence, and the detailed guidance lives in the files themselves. Anything
 * longer costs tokens on every turn.
 *
 * The section is built once per session and reused verbatim, so the system
 * prompt stays byte-identical across turns and the provider's prompt cache
 * survives memory writes. The rules say so, because the injected index can
 * be older than the file on disk.
 */

import { INDEX_NAME, type IndexTruncation } from "./indexFile.js";

export type MemorySectionInput = {
	memoryDir: string;
	index: IndexTruncation | undefined;
	/** Whether a shell tool is available; the grep hint is useless without one. */
	canSearch?: boolean;
};

export function buildMemoryRules(memoryDir: string, canSearch = true): string {
	// Forward slashes work in Git Bash on Windows and need no escaping inside quotes.
	const searchHint = canSearch
		? ` When the index is not enough, search the directory:\n\`grep -rn "<term>" "${memoryDir.replaceAll("\\", "/")}" --include="*.md"\``
		: "";
	return `# Memory

You have a persistent memory directory at \`${memoryDir}\`. It records what stays useful across conversations and cannot be read from the repo: who the user is, how they want you to work, project context code cannot show, and pointers to external systems. Kinds: \`user\`, \`feedback\`, \`project\`, \`reference\`.

\`${INDEX_NAME}\` is the index. Each entry is \`- [Title](file.md) - one-line hook\`. The copy below was taken when this session started; read \`${INDEX_NAME}\` before changing it. Read a file when its hook looks relevant.${searchHint}

Save when the user corrects you, confirms a non-obvious choice, or tells you something about themselves or the project. To save, write the memory to its own file and add one index line. Do not save what the repo already says: code patterns, architecture, git history, debug recipes, or AGENTS.md content. These exclusions hold even when the user asks you to save.

When a memory names a file, function, or flag, verify it still exists before relying on it. Put the reason on a \`Why:\` line and the trigger on a \`How to apply:\` line.`;
}

export function buildMemorySection(input: MemorySectionInput): string {
	const parts = [buildMemoryRules(input.memoryDir, input.canSearch ?? true), "", `## ${INDEX_NAME}`, ""];
	if (input.index === undefined) {
		parts.push(`No memories when this session started. Create ${INDEX_NAME} with the first memory.`);
	} else {
		parts.push(input.index.content);
	}
	return parts.join("\n");
}
