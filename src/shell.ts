/**
 * Minimal shell scanner.
 *
 * Splits a bash command string into simple-command segments while respecting
 * quotes, command substitutions and heredoc bodies. Rules only ever look at
 * pipeline heads, so `cmd | grep foo` (legitimate downstream filtering) and a
 * literal "grep" inside a quoted string are never mistaken for a violation.
 */

export interface ShellSegment {
	/** Words of one simple command, e.g. ["grep", "-rn", "foo", "src/"]. */
	words: string[];
	/** True when this segment reads from a `|` pipe. */
	afterPipe: boolean;
	/** True when this segment writes into a `|` pipe. */
	beforePipe: boolean;
}

const WHITESPACE = new Set([" ", "\t", "\r"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Wrappers that delegate to the real command, e.g. `sudo grep ...`. */
const TRANSPARENT_WRAPPERS = new Set([
	"sudo",
	"env",
	"time",
	"command",
	"builtin",
	"exec",
	"nohup",
	"nice",
	"stdbuf",
	"unbuffer",
]);

/** Consume a single- or double-quoted string, returning the index after it. */
function scanQuoted(input: string, start: number): number {
	const quote = input[start];
	let i = start + 1;
	while (i < input.length) {
		const ch = input[i];
		if (quote === '"' && ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === quote) return i + 1;
		i += 1;
	}
	return input.length;
}

/** Consume a `$(...)` or backtick substitution, returning the index after it. */
function scanSubstitution(input: string, start: number): number {
	if (input[start] === "`") {
		let i = start + 1;
		while (i < input.length) {
			if (input[i] === "\\") {
				i += 2;
				continue;
			}
			if (input[i] === "`") return i + 1;
			i += 1;
		}
		return input.length;
	}

	let i = start + 2;
	let depth = 1;
	while (i < input.length && depth > 0) {
		const ch = input[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			i = scanQuoted(input, i);
			continue;
		}
		if (ch === "(") depth += 1;
		else if (ch === ")") depth -= 1;
		i += 1;
	}
	return i;
}

/** Drop heredoc bodies so their contents are never parsed as commands. */
function stripHeredocs(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		kept.push(line);
		i += 1;
		const match = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
		if (!match) continue;
		const terminator = match[2];
		while (i < lines.length && lines[i].trim() !== terminator) i += 1;
		if (i < lines.length) i += 1;
	}
	return kept.join("\n");
}

export function parseShellSegments(command: string): ShellSegment[] {
	const input = stripHeredocs(command);
	const segments: ShellSegment[] = [];
	let words: string[] = [];
	let buf = "";
	let afterPipe = false;
	let i = 0;

	const flushWord = () => {
		if (buf !== "") {
			words.push(buf);
			buf = "";
		}
	};

	const flushSegment = (pipe: boolean) => {
		flushWord();
		if (words.length > 0) {
			segments.push({ words, afterPipe, beforePipe: pipe });
			words = [];
			afterPipe = pipe;
			return;
		}
		// Separators that produced no command must not clear a pending pipe,
		// otherwise `foo | ( grep bar )` would look like a pipeline head.
		if (pipe) afterPipe = true;
	};

	while (i < input.length) {
		const ch = input[i];

		if (ch === "\\") {
			buf += input.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const end = scanQuoted(input, i);
			buf += input.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "`" || (ch === "$" && input[i + 1] === "(")) {
			const end = scanSubstitution(input, i);
			buf += input.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "|") {
			const isOr = input[i + 1] === "|";
			flushSegment(!isOr);
			i += isOr ? 2 : 1;
			continue;
		}
		if (ch === "&") {
			const isAnd = input[i + 1] === "&";
			flushSegment(false);
			i += isAnd ? 2 : 1;
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "(" || ch === ")") {
			flushSegment(false);
			i += 1;
			continue;
		}
		if (WHITESPACE.has(ch)) {
			flushWord();
			i += 1;
			continue;
		}

		buf += ch;
		i += 1;
	}
	flushSegment(false);

	return segments;
}

export interface ResolvedCommand {
	/** Basename of the executable, e.g. "grep" for "/usr/bin/grep". */
	name: string;
	/** Everything after the executable word. */
	args: string[];
}

/**
 * Resolve the effective executable of a segment, skipping leading environment
 * assignments and transparent wrappers. Unknown wrapper-like prefixes resolve
 * to themselves, which yields a false negative rather than a false positive.
 */
export function resolveCommand(segment: ShellSegment): ResolvedCommand | null {
	let i = 0;
	while (i < segment.words.length) {
		const word = segment.words[i];
		if (ENV_ASSIGNMENT.test(word)) {
			i += 1;
			continue;
		}
		const name = word.split("/").pop() ?? word;
		if (TRANSPARENT_WRAPPERS.has(name)) {
			i += 1;
			// Skip that wrapper's own flags, e.g. `sudo -u alice grep ...`.
			while (i < segment.words.length && segment.words[i].startsWith("-")) i += 1;
			continue;
		}
		if (name === "") {
			i += 1;
			continue;
		}
		return { name, args: segment.words.slice(i + 1) };
	}
	return null;
}
