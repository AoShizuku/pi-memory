import { describe, expect, it } from "vitest";

import { truncateIndex } from "./indexFile.js";
import { buildMemoryRules, buildMemorySection } from "./prompt.js";

const DIR = "/home/user/.pi/agent/memory/repo-0123456789ab";

describe("buildMemoryRules", () => {
	it("names the directory and the index format", () => {
		const rules = buildMemoryRules(DIR);
		expect(rules).toContain(DIR);
		expect(rules).toContain("MEMORY.md");
		expect(rules).toContain("grep -rn");
	});

	it("says the index is a snapshot and must be read before changing it", () => {
		expect(buildMemoryRules(DIR)).toContain("read `MEMORY.md` before changing it");
	});

	it("quotes the search path and uses forward slashes", () => {
		const rules = buildMemoryRules("C:\\Users\\John Doe\\.pi\\agent\\memory\\repo-1");
		expect(rules).toContain('grep -rn "<term>" "C:/Users/John Doe/.pi/agent/memory/repo-1" --include="*.md"');
	});

	it("omits the search hint without a shell tool", () => {
		expect(buildMemoryRules(DIR, false)).not.toContain("grep");
	});

	it("stays inside a tight character budget", () => {
		expect(buildMemoryRules(DIR).length).toBeLessThan(1300);
	});
});

describe("buildMemorySection", () => {
	it("reports an empty memory instead of pretending an index exists", () => {
		const section = buildMemorySection({ memoryDir: DIR, index: undefined });
		expect(section).toContain("No memories when this session started");
	});

	it("appends the index verbatim", () => {
		const index = truncateIndex("- [A](a.md) - hook");
		const section = buildMemorySection({ memoryDir: DIR, index });
		expect(section).toContain("## MEMORY.md");
		expect(section).toContain("- [A](a.md) - hook");
	});
});
