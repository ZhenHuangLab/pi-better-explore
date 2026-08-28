/**
 * Rules that detect searching / file-dumping done through bash when a bounded
 * tool exists for the same job.
 *
 * Every rule is deliberately conservative: a false positive costs the model a
 * whole wasted turn, so anything ambiguous is allowed through.
 */

import { parseShellSegments, resolveCommand } from "./shell.ts";

/** Which tool family should have handled the job. */
export type Capability = "searchContent" | "findFiles" | "readFile" | "listDir";

const GREP_BINARIES = new Set(["grep", "egrep", "fgrep"]);
const DUMP_BINARIES = new Set(["cat", "head", "tail"]);

/** `find` predicates that perform an action rather than just locating files. */
const FIND_ACTION_FLAGS = new Set([
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-print0",
	"-printf",
	"-fprint",
	"-fprintf",
	"-fls",
]);

const REDIRECTION = /^\d*(>>?|<)/;

/** Paths where a bash dump is the only sensible option. */
const STREAMING_PREFIXES = ["/dev/", "/proc/", "/sys/"];

function isFlag(word: string): boolean {
	return word.startsWith("-") && word !== "-";
}

function hasRedirection(words: string[]): boolean {
	return words.some((word) => REDIRECTION.test(word));
}

function operands(args: string[]): string[] {
	return args.filter((word) => !isFlag(word) && !REDIRECTION.test(word));
}

/**
 * Inspect one bash command. Returns the capability that should have been used,
 * or null when the command is fine.
 */
export function inspectBashCommand(command: string): Capability | null {
	for (const segment of parseShellSegments(command)) {
		if (segment.afterPipe) continue;

		const resolved = resolveCommand(segment);
		if (!resolved) continue;
		const { name, args } = resolved;

		if (GREP_BINARIES.has(name)) return "searchContent";

		// The remaining rules only fire on standalone commands: feeding a pipe
		// (`find . -name '*.ts' | xargs ...`, `cat f | jq`) is a real bash job.
		if (segment.beforePipe) continue;

		if (name === "find") {
			if (args.some((arg) => FIND_ACTION_FLAGS.has(arg))) continue;
			return "findFiles";
		}

		if (DUMP_BINARIES.has(name)) {
			if (hasRedirection(segment.words)) continue;
			if (args.includes("-f") || args.includes("--follow")) continue;
			const targets = operands(args);
			if (targets.length !== 1) continue;
			if (STREAMING_PREFIXES.some((prefix) => targets[0].startsWith(prefix))) continue;
			return "readFile";
		}

		if (name === "ls") {
			// Only bare listings; `ls -lt`, `ls -S` etc. have no tool equivalent.
			if (args.some(isFlag)) continue;
			if (operands(args).length > 1) continue;
			return "listDir";
		}
	}

	return null;
}
