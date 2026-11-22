import { describe, expect, it } from "vitest";

import { createSettingsProvider } from "./settings.js";

describe("settings provider", () => {
	it("points at /memory and shows the resolved location", () => {
		let facts: { location: string; memoryDir: string } | undefined;
		const provider = createSettingsProvider(() => facts, {});
		const view = () => provider.items().map((item) => [item.id, item.kind, "value" in item ? item.value : "command" in item ? item.command : undefined]);
		expect(view()).toEqual([
			["panel", "command", "/memory"],
			["location", "info", "not resolved yet"],
			["memoryDir", "info", "not resolved yet"],
			["agentDirOverride", "info", "not set"],
		]);

		facts = { location: "project", memoryDir: "/repo/.pi/memory" };
		expect(view()[1]).toEqual(["location", "info", "project"]);
		expect(view()[2]).toEqual(["memoryDir", "info", "/repo/.pi/memory"]);
	});

	it("reports PI_MEMORY_AGENT_DIR when it is in effect", () => {
		const provider = createSettingsProvider(() => undefined, { PI_MEMORY_AGENT_DIR: " /tmp/agent " });
		expect(provider.items().find((item) => item.id === "agentDirOverride")).toMatchObject({ value: "in effect: /tmp/agent" });
	});
});
