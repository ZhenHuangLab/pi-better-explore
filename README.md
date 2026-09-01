# pi-better-explore

Turns codebase-exploration conventions from prompt text into tool-boundary
enforcement.

Prompt rules decay: they appear once at the top of the context and get weaker as
the session grows. This extension moves the mechanically decidable ones into a
`tool_call` hook, so a violation is caught at the moment it happens and the
model gets a concrete replacement to copy.

## Rules

| Blocks | Allowed |
|---|---|
| `grep` / `egrep` / `fgrep` at a pipeline head | `cmd \| grep foo` (downstream filtering), `git grep`, `rg` |
| standalone `find` used to locate files | `find ... -exec/-delete/-print0`, `find ... \| xargs`, `fd` |
| `cat` / `head` / `tail` of a single file | pipelines, redirections, `tail -f`, `/dev`, `/proc`, `/sys` |
| bare `ls` / `ls dir` | `ls -la`, `ls -lt`, `ls -S` |
| recursive `ls -R` / `ls -laR` / `ls --recursive`, routed to the file finder | `ls -R \| head` (pipeline head) |
| `rtk grep` / `rtk find` / `rtk read` / `rtk ls`, under the rule of the command they replace | `rtk rg`, `rtk tree`, `rtk git`, `rtk test`, … |
| `read` without `offset`/`limit` on a file over 20 KB or 600 lines | anything smaller, images/archives, an explicit `limit` |

The replacement named in the block message is chosen from the tools actually
active in the session (`grep`, `signal_grep`, `find`, `read`, `ls`, …).
If no better tool is active, the call is not blocked.

## Message shape

Messages are single-line, positive directives:

```text
better-explore: Search content with grep / signal_grep. Bash fallback: rg.
better-explore: this file is 9,558 lines. Locate with grep, then read with offset+limit. Whole file: repeat with limit=2000.
```

Two constraints drive that shape. Every block is paid for in tokens on each
occurrence, so the message states the action and stops. And prohibitions prime
the behaviour they forbid — telling a model "never use grep" keeps `grep` in
play — so messages name only what to do.

## Design notes

**Cache safety.** Everything happens in `tool_call`. A blocked call only appends
a tool result; the system prompt and tool schemas are never touched, so the
prompt-cache prefix survives intact. Modifying `event.input` would also be
cache-safe — the hook receives a validated copy, not the assistant message's
arguments — but no rule here rewrites arguments, because a silent rewrite would
leave the model believing it got something it did not.

**False positives are the expensive failure.** Each wrongful block costs a full
turn, so every rule carries explicit escape hatches, and anything ambiguous is
allowed through. Bash commands are parsed with a quote-, heredoc- and
substitution-aware scanner rather than a regex, so a literal `grep` inside a
string or a heredoc never triggers a rule.

**Wrapper-aware classification.** pi-rtk-optimizer rewrites bash commands into
`rtk <subcommand>` form from inside the same `tool_call` event, so whether a
rule sees `cat f` or `rtk read f` is a load-order accident. `rtk grep`, `rtk
find`, `rtk read` and `rtk ls` are therefore folded back onto the binary they
replace before the rules run, and the verdict is the same for either spelling.
Subcommands with no blocked counterpart pass through untouched.

**No deadlocks.** A given path is blocked at most twice by the read rule; after
that it is allowed through, so a model that will not add `offset`/`limit` cannot
loop.

## What this deliberately does not do

Rules requiring intent cannot be enforced here and stay in the prompt:

- merging several searches into one multi-pattern call — whether patterns can be
  safely OR-ed is a semantic question
- reading a known path directly instead of searching for it — "known" is model
  state, invisible to a hook

## Install

Auto-discovered from `~/.pi/agent/extensions/pi-better-explore/index.ts`.
No configuration. Disable with `pi config`.
