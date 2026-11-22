/**
 * Shared types for pi-memory.
 */

/** Runs a command and resolves with its captured output. Matches `pi.exec`. */
export type Exec = (
	command: string,
	args: string[],
	options?: { cwd?: string; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;
