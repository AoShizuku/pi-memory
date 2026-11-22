// The pi-memory page of the /shizuku settings panel. Memory is data, not settings: the page points at /memory
// and shows where this project's memory lives. Values come from the session resolved at session start.

import type { SettingItem, SettingsProvider } from "./shizuku-settings.js";

export interface MemoryFacts {
	location: string;
	memoryDir: string;
}

export function createSettingsProvider(
	facts: () => MemoryFacts | undefined,
	env: Record<string, string | undefined> = process.env,
): SettingsProvider {
	return {
		id: "pi-memory",
		title: "pi-memory",
		description: "Cross-session project memory",
		items(): SettingItem[] {
			const current = facts();
			const override = env.PI_MEMORY_AGENT_DIR?.trim();
			return [
				{
					id: "panel",
					kind: "command",
					label: "Memory panel",
					description: "Browse, check and delete memories; /memory switch moves them between local and project.",
					command: "/memory",
				},
				{
					id: "location",
					kind: "info",
					label: "Location",
					description: "local keeps memory under the agent dir; project keeps it in the repository. Change it with /memory switch.",
					value: current?.location ?? "not resolved yet",
				},
				{
					id: "memoryDir",
					kind: "info",
					label: "Directory",
					value: current?.memoryDir ?? "not resolved yet",
				},
				{
					id: "agentDirOverride",
					kind: "info",
					label: "PI_MEMORY_AGENT_DIR",
					description: "Relocates the local memory root when set.",
					value: override ? `in effect: ${override}` : "not set",
				},
			];
		},
		set: (id) => ({ ok: false, error: `${id} is read-only` }),
	};
}
