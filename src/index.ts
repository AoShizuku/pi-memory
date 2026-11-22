/**
 * pi-memory: persistent project memory as a MEMORY.md index plus topic files.
 *
 * Three touch points with pi: a system prompt section carrying the index, a
 * tool_call gate that blocks credentials (and accidental index overwrites)
 * from being written into memory, and the `/memory` command. Everything else
 * is plain files the model edits with the built-in read/write tools.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { DEFAULT_LOCATION, readLegacyConfig, type MemoryConfig, type MemoryLocation } from "./config.js";
import { formatReport, listExpiredTrash, runDoctor } from "./doctor.js";
import { deleteMemory, loadMemory, purgeTrash } from "./store.js";
import { type Choice, ChoicePanel, type ChoiceSpec, noteRows, TextPrompt } from "./ui/choice.js";
import { OVERLAY_OPTIONS, tildePath } from "./ui/kit.js";
import { type MemorySource, MemoryPanel, type Page } from "./ui/panel.js";
import { MemoryViewer } from "./ui/viewer.js";
import { commitMemory, defaultCommitMessage, ensureExcluded, isTracked, removeFromExclude } from "./git.js";
import {
	INDEX_NAME,
	listMemoryFiles,
	normalizeEntryTarget,
	parseIndex,
	readIndex,
	truncateIndex,
	type IndexTruncation,
} from "./indexFile.js";
import { MigrationError, migrateMemory, readMigrationState, recoverMigration, type MigrationResult } from "./migrate.js";
import {
	PROJECT_MEMORY_RELATIVE,
	deriveId,
	isInside,
	memoryDirFor,
	migrationStatePathFor,
	pathKey,
	projectRecordPathFor,
	readRemoteUrl,
	resolveRepoRoot,
	resolveToolPath,
	trashRootFor,
} from "./paths.js";
import { buildMemorySection } from "./prompt.js";
import { readProjectRecord, setRecordLocation, writeProjectRecord, type ProjectRecord } from "./registry.js";
import { formatHits, scanContent, scanDirectory } from "./secrets.js";
import type { Exec } from "./types.js";
import { createSettingsProvider } from "./settings.js";
import { exposeSettings } from "./shizuku-settings.js";

export const COMMAND_NAME = "memory";

export type Session = {
	cwd: string;
	repoRoot: string;
	agentDir: string;
	/** Per-machine record holding this repository's id and location. */
	recordPath: string;
	id: string;
	location: MemoryLocation;
	memoryDir: string;
	recordError: string | undefined;
	/** The record did not exist and was created during this resolve. */
	created: boolean;
	/** The new record took its id/location from the legacy `.pi/settings.json` key. */
	importedLegacy: boolean;
};

/** The memory section as injected on the first turn; reused verbatim so the prompt cache survives. */
type Snapshot = {
	memoryDir: string;
	canSearch: boolean;
	section: string;
};

type Runtime = {
	pi: ExtensionAPI;
	exec: Exec;
	session: Session | undefined;
	snapshot: Snapshot | undefined;
};

/** Lets tests and unusual installs relocate the local memory root. */
function agentDirFromEnv(): string {
	const override = process.env.PI_MEMORY_AGENT_DIR;
	return override !== undefined && override.trim() !== "" ? override.trim() : getAgentDir();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createExec(pi: ExtensionAPI): Exec {
	return async (command, args, options) => {
		const result = await pi.exec(command, args, { cwd: options?.cwd, signal: options?.signal });
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves everything the session needs from the per-machine record. On the
 * first visit the record is created, importing the legacy settings key when
 * one is present. Nothing is written into the repository.
 */
export async function resolveSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentDir: string = getAgentDir(),
	now: Date = new Date(),
): Promise<Session> {
	const exec = createExec(pi);
	const repoRoot = await resolveRepoRoot(ctx.cwd, exec);
	const recordPath = projectRecordPathFor(agentDir, repoRoot);

	let recordError: string | undefined;
	let record: ProjectRecord | undefined;
	try {
		record = await readProjectRecord(recordPath);
	} catch (error) {
		recordError = errorMessage(error);
	}

	let created = false;
	let importedLegacy = false;
	if (record === undefined) {
		let legacy: MemoryConfig | undefined;
		try {
			legacy = readLegacyConfig(pi.getSettings());
		} catch {
			legacy = undefined;
		}
		const id = legacy?.id ?? deriveId(repoRoot, await readRemoteUrl(repoRoot, exec));
		record = { id, location: legacy?.location ?? DEFAULT_LOCATION, repoRoot, updatedAt: now.toISOString() };
		// A malformed record is reported, never overwritten.
		if (recordError === undefined) {
			try {
				await writeProjectRecord(recordPath, record);
				created = true;
				importedLegacy = legacy !== undefined;
			} catch (error) {
				recordError = errorMessage(error);
			}
		}
	}

	const memoryDir = memoryDirFor({ location: record.location, id: record.id, repoRoot, agentDir });
	return {
		cwd: ctx.cwd,
		repoRoot,
		agentDir,
		recordPath,
		id: record.id,
		location: record.location,
		memoryDir,
		recordError,
		created,
		importedLegacy,
	};
}

async function ensureSession(runtime: Runtime, ctx: ExtensionContext, force = false): Promise<Session> {
	const existing = runtime.session;
	if (existing !== undefined && !force && existing.cwd === ctx.cwd) return existing;
	const next = await resolveSession(runtime.pi, ctx, agentDirFromEnv());
	runtime.session = next;
	return next;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// A stale context after a session switch cannot show notifications.
	}
}

async function readMemoryIndex(memoryDir: string): Promise<IndexTruncation | undefined> {
	const index = await readIndex(memoryDir);
	if (!index.exists || index.raw.trim() === "") return undefined;
	return truncateIndex(index.raw);
}

/** Panels need pi's interactive TUI; RPC and print modes get plain notices instead. */
function isTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" && ctx.hasUI;
}

function choose<T>(ctx: ExtensionContext, spec: ChoiceSpec<T>): Promise<T | undefined> {
	return ctx.ui.custom<T | undefined>((tui, theme, keys, done) => new ChoicePanel<T>(tui, theme, keys, spec, done));
}

function promptText(ctx: ExtensionContext, spec: { title: string; value: string; action: string }): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((_tui, theme, keys, done) => new TextPrompt(theme, keys, spec, done));
}

/** The /memory panel: memories and issues, delete, purge expired trash, full-file overlay. */
async function openPanel(runtime: Runtime, ctx: ExtensionContext, page: Page): Promise<void> {
	const session = await ensureSession(runtime, ctx);
	const trashRoot = trashRootFor(session.agentDir);
	let viewing = false;
	const source: MemorySource = {
		location: session.location,
		load: () => loadMemory(session.memoryDir, trashRoot),
		remove: async (item) => {
			const notice = await deleteMemory(session.memoryDir, trashRoot, session.id, item);
			// The injected index still lists the deleted entry; refresh it, at the cost of one prompt cache miss.
			runtime.snapshot = undefined;
			return notice;
		},
		purge: async (issue) => {
			if (issue.path === undefined) throw new Error("nothing to purge");
			return purgeTrash(trashRoot, issue.path);
		},
		view: (item) => {
			// One overlay at a time (design_style.md §7.5).
			if (viewing) return;
			viewing = true;
			ctx.ui
				.custom<void>((tui, theme, keys, done) => new MemoryViewer(tui, theme, keys, item, () => done()), {
					overlay: true,
					overlayOptions: { ...OVERLAY_OPTIONS },
				})
				.catch(() => {
					// The UI went away (session switch); nothing to restore.
				})
				.finally(() => {
					viewing = false;
				});
		},
	};
	await ctx.ui.custom<void>((tui, theme, keys, done) => new MemoryPanel(tui, theme, keys, source, () => done(), page));
}

function statusText(session: Session, files: number, index: IndexTruncation | undefined): string {
	const lines = [
		`memory location: ${session.location}`,
		`  directory: ${session.memoryDir}`,
		`  id: ${session.id}`,
		`  repo: ${session.repoRoot}`,
		`  record: ${session.recordPath}`,
		`files: ${files}, index: ${index === undefined ? "empty" : `${index.lineCount} lines / ${index.byteCount} bytes`}`,
	];
	if (session.recordError) lines.push(`record error: ${session.recordError}`);
	return lines.join("\n");
}

/** Index targets a full rewrite of MEMORY.md would remove. Empty when the file does not exist yet. */
async function droppedIndexEntries(indexPath: string, next: string): Promise<string[]> {
	let current: string;
	try {
		current = await readFile(indexPath, "utf8");
	} catch {
		return [];
	}
	const targets = (text: string): string[] =>
		parseIndex(text).entries.flatMap((entry) => {
			const target = normalizeEntryTarget(entry.target);
			return target.kind === "file" ? [target.path] : [];
		});
	const kept = new Set(targets(next));
	return [...new Set(targets(current))].filter((target) => !kept.has(target));
}

async function openInEditor(runtime: Runtime, ctx: ExtensionContext, session: Session): Promise<void> {
	const path = join(session.memoryDir, INDEX_NAME);
	let current = "";
	try {
		current = await readFile(path, "utf8");
	} catch {
		current = "";
	}
	const edited = await ctx.ui.editor(INDEX_NAME, current);
	if (edited === undefined) {
		notify(ctx, "No changes made.");
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, edited, "utf8");
	// An explicit edit should show up on the next turn, at the cost of one prompt cache miss.
	runtime.snapshot = undefined;
	notify(ctx, `Saved ${path}`);
}

/** Doctor without a TUI: the report as a notice. In the TUI, /memory doctor opens the panel on its Issues page. */
async function reportDoctor(runtime: Runtime, ctx: ExtensionContext): Promise<void> {
	const session = await ensureSession(runtime, ctx);
	const trashRoot = trashRootFor(session.agentDir);
	const report = await runDoctor(session.memoryDir, { trashRoot });
	const expired = await listExpiredTrash(trashRoot);
	const purgeHint = expired.length > 0 ? "\n\nOpen /memory doctor in the interactive TUI to purge old trash entries." : "";
	notify(ctx, formatReport(report) + purgeHint, report.ok ? "info" : "warning");
}

function parseLocation(value: string | undefined): MemoryLocation | undefined {
	if (value === "project" || value === "local") return value;
	return undefined;
}

function where(location: MemoryLocation): string {
	return location === "project" ? "in the project" : "on this machine";
}

/** The location panel: both places with their paths, the current one marked; moving needs a second enter. */
async function pickLocation(
	ctx: ExtensionContext,
	session: Session,
	preselect: MemoryLocation | undefined,
): Promise<MemoryLocation | undefined> {
	const choice = (location: MemoryLocation, detail: string): Choice<MemoryLocation> => {
		const current = location === session.location;
		const dst = memoryDirFor({ location, id: session.id, repoRoot: session.repoRoot, agentDir: session.agentDir });
		return {
			value: location,
			label: location,
			tag: current ? "● current" : undefined,
			detail: `${tildePath(dst)} · ${detail}`,
			action: "move",
			disabled: current ? `memory is already ${where(location)}` : undefined,
			notes: current
				? []
				: [
						...noteRows([
							["from", tildePath(session.memoryDir)],
							["to", tildePath(dst)],
						]),
						"",
						"The current directory is copied, verified, then moved into the trash; nothing is deleted in place.",
						"If it is empty and the target already holds memory, the target is used as is.",
					],
			confirm: `press enter again to move memory ${where(location)} · any other key cancels`,
		};
	};
	const choices = [choice("project", "can be committed"), choice("local", "this machine only")];
	const wanted = preselect ?? (session.location === "project" ? "local" : "project");
	return choose(ctx, {
		title: "Memory location",
		stats: `stored ${where(session.location)}`,
		choices,
		initial: choices.findIndex((item) => item.value === wanted),
	});
}

type GitStep = "exclude" | "commit" | "push";

async function offerGitSteps(
	runtime: Runtime,
	ctx: ExtensionContext,
	session: Session,
	files: number,
): Promise<void> {
	if (!isTui(ctx)) {
		notify(
			ctx,
			`Project memory is at ${session.memoryDir}. Add .pi/memory/ to .git/info/exclude or commit it when you are ready.`,
		);
		return;
	}
	const choice = await choose<GitStep>(ctx, {
		title: "Project memory in git",
		stats: `${files} ${files === 1 ? "file" : "files"} in .pi/memory`,
		choices: [
			{ value: "exclude", label: "keep untracked", detail: "add .pi/memory/ to .git/info/exclude", action: "choose" },
			{ value: "commit", label: "commit", detail: "stage and commit only .pi/memory", action: "continue" },
			{ value: "push", label: "commit and push", detail: "commit, then git push", action: "continue" },
		],
	});
	if (choice === undefined) return;

	if (choice === "exclude") {
		const ok = await ensureExcluded(session.repoRoot, runtime.exec);
		notify(
			ctx,
			ok
				? "Added .pi/memory/ to .git/info/exclude. Your memory stays untracked on this machine."
				: "Could not write .git/info/exclude; add .pi/memory/ yourself.",
			ok ? "info" : "warning",
		);
		return;
	}

	// Scan before touching the exclude file: a refused commit must leave the
	// directory excluded, or a later `git add -A` would sweep the secret in.
	const hits = await scanDirectory(session.memoryDir);
	if (hits.length > 0) {
		const lines = hits.map((hit) => formatHits(hit.file, [hit])).join("\n");
		notify(ctx, `Refusing to commit: possible secrets in memory.\n${lines}`, "error");
		return;
	}

	const fallback = defaultCommitMessage(files);
	const message = await promptText(ctx, { title: "Commit message", value: fallback, action: "commit" });
	if (message === undefined) {
		notify(ctx, "Commit cancelled.");
		return;
	}

	// A previous "keep untracked" choice may have excluded the directory; `git add`
	// would stage nothing while it is excluded.
	const unexcluded = await removeFromExclude(session.repoRoot, runtime.exec);
	const result = await commitMemory({
		repoRoot: session.repoRoot,
		exec: runtime.exec,
		message: message.trim() === "" ? fallback : message.trim(),
		push: choice === "push",
		confirmPush: async (ahead) =>
			(await choose<boolean>(ctx, {
				title: "Push now?",
				stats: `${ahead} commits ahead of upstream`,
				intro: ["git push sends every unpushed commit on this branch, not only the memory commit."],
				choices: [
					{
						value: true,
						label: `push ${ahead} commits`,
						action: "push",
						confirm: `press enter again to push ${ahead} commits · any other key cancels`,
					},
					{ value: false, label: "don't push", detail: "keep the memory commit local", action: "choose" },
				],
			})) === true,
	});
	if (!result.committed && unexcluded) await ensureExcluded(session.repoRoot, runtime.exec);
	notify(ctx, result.detail, result.committed ? "info" : "warning");
}

function describeResult(result: MigrationResult, to: MemoryLocation): string {
	const files = `${result.files} ${result.files === 1 ? "file" : "files"}`;
	if (result.mode === "adopted") return `Now using the existing memory at ${result.dst} (${files}).`;
	if (result.mode === "switched") return `Memory location set to ${to}: ${result.dst}. Nothing needed to move.`;
	return `Moved ${files} to ${result.dst}.` + (result.trash ? `\nOld copy: ${result.trash}` : "");
}

async function switchLocation(runtime: Runtime, ctx: ExtensionContext, target: string | undefined): Promise<void> {
	const session = await ensureSession(runtime, ctx);
	if (session.recordError) {
		notify(ctx, `Cannot switch: ${session.recordError}`, "error");
		return;
	}
	const usage = "Usage: /memory switch project|local";
	const parsed = parseLocation(target);
	if (target !== undefined && parsed === undefined) {
		notify(ctx, usage, "warning");
		return;
	}
	if (parsed === session.location) {
		notify(ctx, `Memory is already stored ${where(parsed)}.`);
		return;
	}
	// In the TUI the location panel is the confirmation, even when the target was typed.
	// Elsewhere the typed target is the confirmation.
	const to = isTui(ctx) ? await pickLocation(ctx, session, parsed) : parsed;
	if (to === undefined) {
		if (!isTui(ctx)) notify(ctx, usage);
		return;
	}

	const dst = memoryDirFor({
		location: to,
		id: session.id,
		repoRoot: session.repoRoot,
		agentDir: session.agentDir,
	});

	let result: MigrationResult;
	try {
		result = await migrateMemory({
			id: session.id,
			from: session.location,
			to,
			src: session.memoryDir,
			dst,
			statePath: migrationStatePathFor(session.agentDir, session.id),
			trashRoot: trashRootFor(session.agentDir),
			setLocation: (location) => setRecordLocation(session.recordPath, location),
		});
	} catch (error) {
		const code = error instanceof MigrationError ? ` (${error.code})` : "";
		notify(ctx, `Migration failed${code}: ${errorMessage(error)}`, "error");
		return;
	}

	session.location = to;
	session.memoryDir = dst;
	runtime.snapshot = undefined;
	notify(ctx, describeResult(result, to), "info");
	for (const warning of result.warnings) notify(ctx, warning, "warning");

	if (to === "project") {
		// Adopted memory came from the repository and is already in git.
		if (result.mode !== "adopted") await offerGitSteps(runtime, ctx, session, result.files);
		return;
	}

	if (await isTracked(session.repoRoot, runtime.exec)) {
		notify(
			ctx,
			"Memory now lives outside the repo, but .pi/memory is still tracked by git. Remove it with:\n  git rm -r --cached .pi/memory",
			"warning",
		);
	}
}

async function handleCommand(runtime: Runtime, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = args.trim();
	const [sub, ...rest] = trimmed === "" ? [] : trimmed.split(/\s+/);

	if (sub === "switch") {
		await switchLocation(runtime, ctx, rest[0]);
		return;
	}
	if (sub === "doctor") {
		// --purge is accepted for old habits: purging now happens on the Issues page.
		if (isTui(ctx)) await openPanel(runtime, ctx, "issues");
		else await reportDoctor(runtime, ctx);
		return;
	}
	if (sub === "open") {
		const session = await ensureSession(runtime, ctx);
		await openInEditor(runtime, ctx, session);
		return;
	}
	if (sub !== undefined && sub !== "status" && sub !== "help") {
		notify(ctx, `Unknown subcommand: ${sub}\nUsage: /memory [status|open|doctor|switch project|local]`, "warning");
		return;
	}
	if (sub === "help") {
		notify(
			ctx,
			[
				"/memory                       browse, view, and delete memories; Tab for issues",
				"/memory status                show location, paths, files, and index size",
				"/memory open                  edit MEMORY.md",
				"/memory doctor                check index and files (the Issues page)",
				"/memory switch project|local  move memory between repo and machine",
			].join("\n"),
		);
		return;
	}
	if (sub === undefined && isTui(ctx)) {
		await openPanel(runtime, ctx, "memories");
		return;
	}

	// Status goes to a notice, not the transcript: a custom message would reach the model as a user message.
	const session = await ensureSession(runtime, ctx);
	const files = await listMemoryFiles(session.memoryDir);
	const index = await readMemoryIndex(session.memoryDir);
	notify(ctx, statusText(session, files.length, index));
}

/** One-time notices for a session: record problems, legacy import, repo-provided memory, interrupted migrations. */
async function startupNotice(runtime: Runtime, ctx: ExtensionContext): Promise<void> {
	const session = await ensureSession(runtime, ctx, true);
	if (session.recordError) {
		notify(ctx, `pi-memory could not use its record: ${session.recordError}\nUsing ${session.memoryDir} for now.`, "warning");
	}
	if (session.importedLegacy) {
		notify(
			ctx,
			`pi-memory now keeps its settings in ${session.recordPath} and imported them from .pi/settings.json. ` +
				`The "pi-memory" key there is no longer read; remove it (or the file, if nothing else is in it) so pi stops asking to trust this project.`,
		);
	} else if (
		session.created &&
		session.location === "local" &&
		(await exists(join(session.repoRoot, PROJECT_MEMORY_RELATIVE, INDEX_NAME)))
	) {
		notify(
			ctx,
			`This repository ships project memory at ${join(session.repoRoot, PROJECT_MEMORY_RELATIVE)}. Run /memory switch project to use it.`,
		);
	}

	const statePath = migrationStatePathFor(session.agentDir, session.id);
	if ((await readMigrationState(statePath)) === undefined) return;
	const message = await recoverMigration(statePath, {
		readLocation: async () => (await readProjectRecord(session.recordPath))?.location,
		trashRoot: trashRootFor(session.agentDir),
	});
	if (message !== undefined) notify(ctx, message, "warning");
}

export default function piMemory(pi: ExtensionAPI): void {
	const runtime: Runtime = { pi, exec: createExec(pi), session: undefined, snapshot: undefined };
	exposeSettings(pi, createSettingsProvider(() => runtime.session));

	pi.on("session_start", async (_event, ctx) => {
		try {
			runtime.session = undefined;
			runtime.snapshot = undefined;
			await startupNotice(runtime, ctx);
		} catch (error) {
			notify(ctx, `pi-memory failed to start: ${errorMessage(error)}`, "error");
		}
	});

	// Compaction already invalidates the prompt cache, so refreshing the index here is free.
	pi.on("session_compact", () => {
		runtime.snapshot = undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const session = await ensureSession(runtime, ctx);
			const tools = event.systemPromptOptions.selectedTools;
			if (!tools.includes("read") || !tools.includes("write")) return;
			const canSearch = tools.includes("bash");
			let snapshot = runtime.snapshot;
			if (snapshot === undefined || snapshot.memoryDir !== session.memoryDir || snapshot.canSearch !== canSearch) {
				const index = await readMemoryIndex(session.memoryDir);
				snapshot = {
					memoryDir: session.memoryDir,
					canSearch,
					section: buildMemorySection({ memoryDir: session.memoryDir, index, canSearch }),
				};
				runtime.snapshot = snapshot;
			}
			event.systemPromptOptions.sections.memory = snapshot.section;
		} catch (error) {
			notify(ctx, `pi-memory could not load memory: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const session = runtime.session;
		if (session === undefined) return;

		let rawPath: string;
		let texts: Array<{ text: string; edit?: number }>;
		let written: string | undefined;
		if (isToolCallEventType("write", event)) {
			rawPath = event.input.path;
			written = event.input.content;
			texts = [{ text: event.input.content }];
		} else if (isToolCallEventType("edit", event)) {
			rawPath = event.input.path;
			texts = event.input.edits.map((edit, index) => ({ text: edit.newText, edit: index + 1 }));
		} else {
			return;
		}
		// Resolve like pi's file tools (~, @, drive paths) so no spelling slips past the gate.
		const target = resolveToolPath(rawPath, ctx.cwd);
		if (!isInside(session.memoryDir, target)) return;
		const file = relative(session.memoryDir, target).split(sep).join("/");

		const reports = texts.flatMap(({ text, edit }) => {
			const hits = scanContent(text);
			return hits.length === 0 ? [] : [formatHits(edit === undefined ? file : `${file} (edit ${edit})`, hits)];
		});
		if (reports.length > 0) {
			return {
				block: true,
				reason:
					"pi-memory blocked this write: the content looks like credentials. Memory files get committed, pushed, and synced.\n" +
					reports.join("\n") +
					"\nReplace the secret with a pointer (for example: 'token in 1Password, item X') and retry.",
			};
		}

		// The injected index is a session-start snapshot, so a full rewrite of
		// MEMORY.md may be based on stale content and silently drop entries.
		if (written !== undefined && pathKey(target) === pathKey(join(session.memoryDir, INDEX_NAME))) {
			const dropped = await droppedIndexEntries(target, written);
			if (dropped.length > 0) {
				const shown = dropped.slice(0, 5).join(", ") + (dropped.length > 5 ? ", ..." : "");
				return {
					block: true,
					reason:
						`pi-memory blocked this write: it would drop ${dropped.length} existing ${INDEX_NAME} ` +
						`${dropped.length === 1 ? "entry" : "entries"} (${shown}). The index may have changed since this session started. ` +
						`Read ${INDEX_NAME}, then add your line with edit. To remove an entry on purpose, use edit.`,
				};
			}
		}
		return undefined;
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Browse, check, or move project memory",
		handler: async (args, ctx) => {
			try {
				await handleCommand(runtime, args, ctx);
			} catch (error) {
				notify(ctx, `pi-memory: ${errorMessage(error)}`, "error");
			}
		},
	});
}
