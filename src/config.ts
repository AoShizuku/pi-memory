/**
 * Memory location type and the legacy `.pi/settings.json` reader.
 *
 * Earlier versions kept `{ location, id }` under the `pi-memory` key of the
 * project settings file. That file is a trust-gated pi resource, so writing it
 * made pi ask for project trust on the next start. The config now lives in the
 * per-machine project registry; this module only reads the old key once so an
 * existing memory directory keeps resolving after the upgrade.
 */

export const SETTINGS_KEY = "pi-memory";
export const DEFAULT_LOCATION = "local";

export type MemoryLocation = "project" | "local";

export type MemoryConfig = {
	location: MemoryLocation;
	id?: string;
};

export const ID_PATTERN = /^(repo|path)-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMemoryLocation(value: unknown): value is MemoryLocation {
	return value === "project" || value === "local";
}

/** Reads the legacy `pi-memory` key out of pi's merged settings. Undefined when the key is absent. */
export function readLegacyConfig(settings: unknown): MemoryConfig | undefined {
	if (!isRecord(settings)) return undefined;
	const raw = settings[SETTINGS_KEY];
	if (!isRecord(raw)) return undefined;
	const location = isMemoryLocation(raw.location) ? raw.location : DEFAULT_LOCATION;
	const id = typeof raw.id === "string" && ID_PATTERN.test(raw.id) ? raw.id : undefined;
	return id ? { location, id } : { location };
}
