import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatHits, scanContent, scanDirectory } from "./secrets.js";

describe("scanContent", () => {
	it("finds an OpenAI-style key", () => {
		const hits = scanContent("token: sk-abcdefghijklmnopqrstuvwxyz012345");
		expect(hits.map((hit) => hit.rule)).toContain("openai-key");
	});

	it("finds an AWS access key", () => {
		expect(scanContent("AKIAIOSFODNN7EXAMPLE").map((hit) => hit.rule)).toContain("aws-access-key");
	});

	it("finds a private key header", () => {
		expect(scanContent("-----BEGIN OPENSSH PRIVATE KEY-----").map((hit) => hit.rule)).toContain("private-key");
	});

	it("finds a generic assignment", () => {
		expect(scanContent('password = "hunter2hunter2hunter2"').map((hit) => hit.rule)).toContain("generic-assignment");
	});

	it("leaves ordinary prose alone", () => {
		expect(scanContent("The deploy queue is #deploy-queue; staging is at staging.internal.")).toEqual([]);
	});

	it("never returns the secret itself", () => {
		const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
		const hits = scanContent(`token: ${secret}`);
		expect(hits[0]?.preview).not.toContain(secret);
		expect(hits[0]?.preview.startsWith("sk-a")).toBe(true);
	});

	it("reports 1-based line numbers", () => {
		const hits = scanContent("line one\nAKIAIOSFODNN7EXAMPLE");
		expect(hits[0]?.line).toBe(2);
	});
});

describe("formatHits", () => {
	it("includes file, line, rule, and masked preview", () => {
		const text = formatHits("a.md", scanContent("AKIAIOSFODNN7EXAMPLE"));
		expect(text).toContain("a.md:1");
		expect(text).toContain("aws-access-key");
	});
});

describe("scanDirectory", () => {
	it("walks nested markdown files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-memory-secrets-"));
		await mkdir(join(dir, "nested"), { recursive: true });
		await writeFile(join(dir, "nested", "a.md"), "AKIAIOSFODNN7EXAMPLE", "utf8");
		await writeFile(join(dir, "b.txt"), "AKIAIOSFODNN7EXAMPLE", "utf8");
		const hits = await scanDirectory(dir);
		expect(hits.map((hit) => hit.file)).toEqual(["nested/a.md"]);
	});
});
