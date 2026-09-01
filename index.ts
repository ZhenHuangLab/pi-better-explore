/**
 * pi-better-explore
 *
 * Enforces, at the tool boundary, what would otherwise be prompt rules:
 *
 *   1. Searching through bash (`grep`, `find`, `cat file`, bare `ls`) is
 *      blocked in favour of the bounded search/read tools. `rg` stays allowed
 *      as the sanctioned bash fallback.
 *   2. `read` without offset/limit on a large file is blocked, and the model is
 *      told the file's real size so it can pick a region.
 *
 * Everything happens in `tool_call`, which is append-only with respect to the
 * request: no system-prompt or tool-schema mutation, so the prompt cache prefix
 * is never invalidated.
 *
 * Block messages are short and phrased as positive directives. Prohibitions
 * ("do not use X") prime the very behaviour they forbid, so every message names
 * only the action to take.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type Capability, inspectBashCommand } from "./src/bash-rules.ts";
import { inspectRead, resolveReadPath } from "./src/read-rule.ts";

interface Guidance {
	/** Imperative opening, e.g. "Search content with". */
	verb: string;
	/** Preferred tools, best first. Tools absent from the session are skipped. */
	tools: string[];
	/** Sanctioned bash command for the cases a tool cannot cover. */
	bash?: string;
}

const GUIDANCE: Record<Capability, Guidance> = {
	searchContent: {
		verb: "Search content with",
		tools: ["grep", "signal_grep"],
		bash: "rg",
	},
	findFiles: {
		verb: "Find files with",
		tools: ["fffind", "find"],
		bash: "fd",
	},
	readFile: {
		verb: "Read file contents with",
		tools: ["read"],
	},
	listDir: {
		verb: "List directories with",
		tools: ["ls"],
	},
};

/**
 * How many times one path may be blocked before it is let through. Keeps a
 * model that never adds offset/limit from looping.
 */
const READ_BLOCK_ALLOWANCE = 2;

const PREFIX = "better-explore:";

interface BashInput {
	command?: unknown;
}

interface ReadInput {
	path?: unknown;
	offset?: unknown;
	limit?: unknown;
}

export default function (pi: ExtensionAPI) {
	const readBlocks = new Map<string, number>();

	const availableTools = (capability: Capability): string[] => {
		const active = new Set(pi.getActiveTools());
		return GUIDANCE[capability].tools.filter((name) => active.has(name));
	};

	const checkBash = (input: BashInput): { block: true; reason: string } | undefined => {
		if (typeof input.command !== "string") return undefined;

		const capability = inspectBashCommand(input.command);
		if (!capability) return undefined;

		const tools = availableTools(capability);
		// Nothing better is active — skip advice that cannot be followed.
		if (tools.length === 0) return undefined;

		const { verb, bash } = GUIDANCE[capability];
		const fallback = bash ? ` If a tool cannot cover it, use \`${bash}\` in bash instead.` : "";
		return { block: true, reason: `${PREFIX} ${verb} ${tools.join(" / ")}.${fallback}` };
	};

	const checkRead = async (
		input: ReadInput,
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined> => {
		if (typeof input.path !== "string") return undefined;
		if (input.offset !== undefined || input.limit !== undefined) return undefined;

		const absolutePath = resolveReadPath(input.path, ctx.cwd);
		const strikes = readBlocks.get(absolutePath) ?? 0;
		if (strikes >= READ_BLOCK_ALLOWANCE) return undefined;

		const oversized = await inspectRead(absolutePath);
		if (!oversized) return undefined;
		readBlocks.set(absolutePath, strikes + 1);

		const shape =
			oversized.lines === null
				? `${Math.round(oversized.bytes / 1024)} KB`
				: `${oversized.lines.toLocaleString("en-US")} lines`;
		const locators = availableTools("searchContent");
		const locate = locators.length > 0 ? `Locate with ${locators[0]}, then read` : "Read";

		return {
			block: true,
			reason: `${PREFIX} this file is ${shape}. ${locate} with offset+limit. Whole file: repeat with limit=2000.`,
		};
	};

	pi.on("tool_call", async (event, ctx) => {
		switch (event.toolName.toLowerCase()) {
			case "bash":
				return checkBash(event.input as BashInput);
			case "read":
				return await checkRead(event.input as ReadInput, ctx);
			default:
				return undefined;
		}
	});
}
