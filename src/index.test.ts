import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import piMemory from "./index.js";
import { deriveId, projectRecordPathFor } from "./paths.js";
import { readProjectRecord } from "./registry.js";
import type { Exec } from "./types.js";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

type Harness = {
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
	messages: string[];
	notices: string[];
	/** What each ctx.ui.custom call resolves to, in order (a panel's choice); undefined once empty. */
	answers: unknown[];
	custom: ReturnType<typeof vi.fn>;
	ctx: ExtensionContext;
	commandCtx: ExtensionCommandContext;
	repoRoot: string;
	agentDir: string;
	/** Local memory directory for the harness repository (no remote, so a path-derived id). */
	localDir: string;
	projectDir: string;
};

async function createHarness(options: { settings?: unknown; mode?: string } = {}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-plugin-"));
	const repoRoot = join(root, "repo");
	const agentDir = join(root, "agent");
	await mkdir(join(repoRoot, ".git"), { recursive: true });
	process.env.PI_MEMORY_AGENT_DIR = agentDir;

	const exec: Exec = async (command, args) => {
		const key = [command, ...args].join(" ");
		if (key === "git rev-parse --show-toplevel") return { stdout: `${repoRoot}\n`, stderr: "", code: 0 };
		return { stdout: "", stderr: "not configured", code: 1 };
	};

	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const messages: string[] = [];
	const notices: string[] = [];
	const answers: unknown[] = [];

	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands.set(name, command);
		},
		exec: async (command: string, args: string[], execOptions?: { cwd?: string }) => exec(command, args, execOptions),
		getSettings: () => options.settings ?? {},
		sendMessage: (message: { content: string }) => messages.push(message.content),
		events: { on: () => () => undefined, emit: () => undefined },
	} as unknown as ExtensionAPI;

	const ui = {
		notify: (message: string) => notices.push(message),
		editor: vi.fn(async () => undefined),
		select: vi.fn(async () => undefined),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => undefined),
		custom: vi.fn(async () => answers.shift()),
	};

	const ctx = {
		cwd: repoRoot,
		mode: options.mode ?? "tui",
		hasUI: true,
		ui,
		sessionManager: {},
		isProjectTrusted: () => true,
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;

	piMemory(pi);
	return {
		handlers,
		commands,
		messages,
		notices,
		answers,
		custom: ui.custom,
		ctx,
		commandCtx: ctx as unknown as ExtensionCommandContext,
		repoRoot,
		agentDir,
		localDir: join(agentDir, "memory", deriveId(repoRoot, undefined)),
		projectDir: join(repoRoot, ".pi", "memory"),
	};
}

async function start(harness: Harness): Promise<void> {
	await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
}

async function injected(harness: Harness, tools: string[] = ["read", "write", "bash"]): Promise<string | undefined> {
	const systemPromptOptions = { selectedTools: tools, sections: {} as Record<string, string> };
	await harness.handlers.get("before_agent_start")?.({ systemPromptOptions }, harness.ctx);
	return systemPromptOptions.sections.memory;
}

async function toolCall(harness: Harness, event: unknown): Promise<unknown> {
	return harness.handlers.get("tool_call")?.(event, harness.ctx);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	delete process.env.PI_MEMORY_AGENT_DIR;
});

describe("pi-memory plugin", () => {
	it("registers the command and its handlers", async () => {
		const harness = await createHarness();
		expect([...harness.commands.keys()]).toEqual(["memory"]);
		expect([...harness.handlers.keys()].sort()).toEqual([
			"before_agent_start",
			"session_compact",
			// exposeSettings drops its /shizuku listener there.
			"session_shutdown",
			"session_start",
			"tool_call",
		]);
	});

	it("keeps its record on the machine and writes nothing into the repository", async () => {
		const harness = await createHarness();
		await start(harness);
		const section = await injected(harness);

		expect(section).toContain(harness.localDir);
		expect(section).toContain("No memories when this session started");
		expect(await exists(join(harness.repoRoot, ".pi"))).toBe(false);
		const record = await readProjectRecord(projectRecordPathFor(harness.agentDir, harness.repoRoot));
		expect(record).toMatchObject({ location: "local", id: deriveId(harness.repoRoot, undefined) });
	});

	it("imports the legacy .pi/settings.json key once", async () => {
		const harness = await createHarness({ settings: { "pi-memory": { location: "project", id: "repo-0123456789ab" } } });
		await start(harness);

		expect(harness.notices.some((notice) => notice.includes("imported them from .pi/settings.json"))).toBe(true);
		expect(await injected(harness)).toContain(harness.projectDir);
		const record = await readProjectRecord(projectRecordPathFor(harness.agentDir, harness.repoRoot));
		expect(record).toMatchObject({ location: "project", id: "repo-0123456789ab" });
	});

	it("points at project memory shipped by the repository without switching to it", async () => {
		const harness = await createHarness();
		await mkdir(harness.projectDir, { recursive: true });
		await writeFile(join(harness.projectDir, "MEMORY.md"), "- [A](a.md) - SHIPPED_BY_REPO", "utf8");
		await start(harness);

		expect(harness.notices.some((notice) => notice.includes("/memory switch project"))).toBe(true);
		const section = await injected(harness);
		expect(section).toContain(harness.localDir);
		expect(section).not.toContain("SHIPPED_BY_REPO");
	});

	it("reuses the injected section until compaction so the prompt cache survives memory writes", async () => {
		const harness = await createHarness();
		await start(harness);
		const first = await injected(harness);

		await mkdir(harness.localDir, { recursive: true });
		await writeFile(join(harness.localDir, "MEMORY.md"), "- [Alpha](a.md) - the alpha topic", "utf8");
		expect(await injected(harness)).toBe(first);

		await harness.handlers.get("session_compact")?.({}, harness.ctx);
		expect(await injected(harness)).toContain("- [Alpha](a.md) - the alpha topic");
	});

	it("skips injection without read/write and drops the grep hint without bash", async () => {
		const harness = await createHarness();
		await start(harness);
		expect(await injected(harness, ["bash"])).toBeUndefined();
		expect(await injected(harness, ["read", "write"])).not.toContain("grep");
	});

	it("blocks credentials written into the memory directory and names the file", async () => {
		const harness = await createHarness();
		await start(harness);

		const blocked = await toolCall(harness, {
			toolName: "write",
			input: { path: join(harness.localDir, "notes", "a.md"), content: "key: AKIAIOSFODNN7EXAMPLE" },
		});
		expect(blocked).toMatchObject({ block: true });
		expect((blocked as { reason: string }).reason).toContain("notes/a.md:1");

		const allowed = await toolCall(harness, {
			toolName: "write",
			input: { path: join(harness.repoRoot, "src.ts"), content: "key: AKIAIOSFODNN7EXAMPLE" },
		});
		expect(allowed).toBeUndefined();
	});

	it("resolves tool paths like pi does before deciding", async () => {
		const harness = await createHarness();
		await start(harness);
		const write = (path: string) =>
			toolCall(harness, { toolName: "write", input: { path, content: "key: AKIAIOSFODNN7EXAMPLE" } });

		expect(await write(`@${join(harness.localDir, "a.md")}`)).toMatchObject({ block: true });
		if (process.platform === "win32") {
			const drive = harness.localDir.slice(0, 1).toLowerCase();
			const shellPath = `/${drive}${harness.localDir.slice(2).replaceAll("\\", "/")}/a.md`;
			expect(await write(shellPath)).toMatchObject({ block: true });
			expect(await write(join(harness.localDir.toUpperCase(), "a.md"))).toMatchObject({ block: true });
		}
	});

	it("blocks credentials introduced by an edit and names the edit", async () => {
		const harness = await createHarness();
		await start(harness);

		const blocked = await toolCall(harness, {
			toolName: "edit",
			input: {
				path: join(harness.localDir, "a.md"),
				edits: [
					{ oldText: "x", newText: "fine" },
					{ oldText: "y", newText: "token = sk-ant-abcdefghijklmnopqrstuvwxyz" },
				],
			},
		});
		expect(blocked).toMatchObject({ block: true });
		expect((blocked as { reason: string }).reason).toContain("a.md (edit 2):1");
	});

	it("blocks a MEMORY.md rewrite that would drop existing entries", async () => {
		const harness = await createHarness();
		await start(harness);
		const index = join(harness.localDir, "MEMORY.md");
		const writeIndex = (content: string) => toolCall(harness, { toolName: "write", input: { path: index, content } });

		// Creating the index is always fine.
		expect(await writeIndex("- [C](c.md) - new")).toBeUndefined();

		await mkdir(harness.localDir, { recursive: true });
		await writeFile(index, "- [A](a.md) - first\n- [B](notes/b.md) - second", "utf8");
		const blocked = await writeIndex("- [C](c.md) - new");
		expect(blocked).toMatchObject({ block: true });
		expect((blocked as { reason: string }).reason).toContain("a.md, notes/b.md");

		expect(await writeIndex("- [A](a.md) - first\n- [B](notes/b.md) - second\n- [C](c.md) - new")).toBeUndefined();
	});

	it("opens the panel for /memory in the TUI and never writes into the transcript", async () => {
		const harness = await createHarness();
		await harness.commands.get("memory")?.handler("", harness.commandCtx);
		expect(harness.custom).toHaveBeenCalledTimes(1);
		await harness.commands.get("memory")?.handler("doctor", harness.commandCtx);
		expect(harness.custom).toHaveBeenCalledTimes(2);
		expect(harness.messages).toEqual([]);
	});

	it("answers /memory status, and /memory without a TUI, with a notice", async () => {
		const harness = await createHarness({ mode: "rpc" });
		await harness.commands.get("memory")?.handler("", harness.commandCtx);
		expect(harness.notices.at(-1)).toContain("memory location: local");
		await harness.commands.get("memory")?.handler("doctor", harness.commandCtx);
		expect(harness.notices.at(-1)).toContain("index entries");
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.messages).toEqual([]);

		const tui = await createHarness();
		await tui.commands.get("memory")?.handler("status", tui.commandCtx);
		expect(tui.notices.at(-1)).toContain("record:");
		expect(tui.custom).not.toHaveBeenCalled();
	});

	it("rejects an unknown subcommand", async () => {
		const harness = await createHarness();
		await harness.commands.get("memory")?.handler("nope", harness.commandCtx);
		expect(harness.notices.at(-1)).toContain("Unknown subcommand");
	});

	it("switches to project memory, records it, and refreshes the injected section", async () => {
		const harness = await createHarness();
		await start(harness);
		await mkdir(harness.localDir, { recursive: true });
		await writeFile(join(harness.localDir, "MEMORY.md"), "- [A](a.md) - alpha", "utf8");
		await writeFile(join(harness.localDir, "a.md"), "body", "utf8");
		expect(await injected(harness)).toContain(harness.localDir);

		// The location panel confirms "project"; the git step panel is closed.
		harness.answers.push("project", undefined);
		await harness.commands.get("memory")?.handler("switch project", harness.commandCtx);
		expect(harness.custom).toHaveBeenCalledTimes(2);

		expect(harness.notices.some((notice) => notice.startsWith("Moved 2 files"))).toBe(true);
		expect((await readdir(harness.projectDir)).sort()).toEqual(["MEMORY.md", "a.md"]);
		const record = await readProjectRecord(projectRecordPathFor(harness.agentDir, harness.repoRoot));
		expect(record?.location).toBe("project");
		const section = await injected(harness);
		expect(section).toContain(harness.projectDir);
		expect(section).toContain("- [A](a.md) - alpha");
	});

	it("switches without moving when there is no memory yet", async () => {
		const harness = await createHarness();
		await start(harness);
		harness.answers.push("project", undefined);
		await harness.commands.get("memory")?.handler("switch project", harness.commandCtx);
		expect(harness.notices.some((notice) => notice.includes("Nothing needed to move"))).toBe(true);
		const record = await readProjectRecord(projectRecordPathFor(harness.agentDir, harness.repoRoot));
		expect(record?.location).toBe("project");
	});

	it("leaves memory where it is when the location panel is closed", async () => {
		const harness = await createHarness();
		await start(harness);
		await harness.commands.get("memory")?.handler("switch", harness.commandCtx);
		expect(harness.custom).toHaveBeenCalledTimes(1);
		const record = await readProjectRecord(projectRecordPathFor(harness.agentDir, harness.repoRoot));
		expect(record?.location).toBe("local");
	});

	it("switches without a panel when the target is typed outside the TUI", async () => {
		const harness = await createHarness({ mode: "rpc" });
		await start(harness);
		await harness.commands.get("memory")?.handler("switch project", harness.commandCtx);
		expect(harness.custom).not.toHaveBeenCalled();
		const record = await readProjectRecord(projectRecordPathFor(harness.agentDir, harness.repoRoot));
		expect(record?.location).toBe("project");
	});
});
