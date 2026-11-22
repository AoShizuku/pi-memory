import { describe, expect, it } from "vitest";

import { readLegacyConfig } from "./config.js";

describe("readLegacyConfig", () => {
	it("is undefined when the key is absent", () => {
		expect(readLegacyConfig({})).toBeUndefined();
		expect(readLegacyConfig(undefined)).toBeUndefined();
		expect(readLegacyConfig({ "pi-memory": "nope" })).toBeUndefined();
	});

	it("reads a valid location and id", () => {
		expect(readLegacyConfig({ "pi-memory": { location: "project", id: "repo-0123456789ab" } })).toEqual({
			location: "project",
			id: "repo-0123456789ab",
		});
	});

	it("ignores an invalid location but keeps the id", () => {
		expect(readLegacyConfig({ "pi-memory": { location: "cloud", id: "path-0123456789ab" } })).toEqual({
			location: "local",
			id: "path-0123456789ab",
		});
	});

	it("drops an id that does not match the expected shape", () => {
		expect(readLegacyConfig({ "pi-memory": { location: "local", id: "../escape" } })).toEqual({ location: "local" });
	});
});
