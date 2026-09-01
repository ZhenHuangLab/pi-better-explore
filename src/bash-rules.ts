/**
 * Rules that detect searching / file-dumping done through bash when a bounded
 * tool exists for the same job.
 *
 * Every rule is deliberately conservative: a false positive costs the model a
 * whole wasted turn, so anything ambiguous is allowed through.
 */

import { parseShellSegments, type ResolvedCommand, resolveCommand } from "./shell.ts";

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

/**
 * `rtk` subcommands that stand in for a blocked binary, mapped to that binary.
 * pi-rtk-optimizer rewrites `grep`/`find`/`cat`/`head`/`tail`/`ls` into these
 * forms, and `rtk` is on PATH, so the rewritten and hand-written spellings must
 * reach the same rule. `rtk rg` is deliberately absent: `rg` is the sanctioned
 * bash fallback. Everything else (`git`, `test`, `docker`, `tree`, …) is real
 * bash work and is left alone.
 */
const RTK_SUBCOMMANDS = new Map<string, string>([
	["grep", "grep"],
	["find", "find"],
	["read", "cat"],
	["ls", "ls"],
]);

/**
 * `rtk read` flags whose value is a separate word (`--max-lines 50`), produced
 * when rtk rewrites `head -50 f` / `tail -20 f`. The value must not be counted
 * as a second file, which would make the read look like a concatenation.
 */
const RTK_VALUE_FLAGS = new Set(["--max-lines", "--tail-lines"]);

const REDIRECTION = /^\d*(>>?|<)/;

/** Paths where a bash dump is the only sensible option. */
const STREAMING_PREFIXES = ["/dev/", "/proc/", "/sys/"];

function isFlag(word: string): boolean {
	return word.startsWith("-") && word !== "-";
}

/** `ls` flags that turn a listing into a recursive walk: `-R`, `-laR`, `--recursive`. */
function isRecursiveListing(word: string): boolean {
	return word === "--recursive" || /^-[A-Za-z]*R/.test(word);
}

/**
 * Rewrite `rtk <subcommand> …` into the native command it replaces, so a single
 * set of rules covers both spellings. Non-discovery subcommands are returned
 * unchanged and therefore never match a rule.
 */
function unwrapRtk(resolved: ResolvedCommand): ResolvedCommand {
	if (resolved.name !== "rtk" || resolved.args.length === 0) return resolved;
	const native = RTK_SUBCOMMANDS.get(resolved.args[0]);
	if (native === undefined) return resolved;

	const args: string[] = [];
	for (let i = 1; i < resolved.args.length; i += 1) {
		const word = resolved.args[i];
		args.push(word);
		if (RTK_VALUE_FLAGS.has(word)) i += 1;
	}
	return { name: native, args };
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
		const { name, args } = unwrapRtk(resolved);

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
			// A recursive walk is file discovery, and the listing tool cannot do it:
			// send it to the file finder instead, whatever else the flags carry.
			if (args.some(isRecursiveListing)) return "findFiles";
			// Only bare listings; `ls -lt`, `ls -S` etc. have no tool equivalent.
			if (args.some(isFlag)) continue;
			if (operands(args).length > 1) continue;
			return "listDir";
		}
	}

	return null;
}
