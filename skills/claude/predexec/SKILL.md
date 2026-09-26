---
name: predexec
description: Use predexec for all read-only shell operations. Use bash only for writes/installs/deletes and interactive commands. Use it for ls/cat/grep/find-style reads, read/grep/find/ls tool calls, and predictable multi-step read sequences (one plan tree, one round-trip); it hard-stops before anything that mutates.
---

# predexec routing (Claude Code)

- Call the `predexec` tool (its full id varies by install, e.g. `mcp__predexec__predexec` or a plugin-namespaced id).
- Use parallel:true for independent reads, cwd for a shared base dir, and edges to branch.
- A node's `commands` mixes shell strings and tool ops: `{tool:"read",path,offset?,limit?} | {tool:"grep",pattern,path?,glob?,ignoreCase?,literal?,context?,limit?} | {tool:"find",pattern,path?,limit?} | {tool:"ls",path?,limit?}`.
- Edge conditions — when: "always" | "exit == 0" (ops ==,!=,<,>) | "stdout =~ /regex/" (also stderr, !~) | "file exists <path>" / "file missing <path>", or a {kind,...} condition object.
- Relative paths resolve against the session directory (the transcript's '# cwd:' header). Do not build depth on unverified paths: verify layout in the first node (ls) and gate children with 'file exists' edges.
- predexec hard-stops (`mutationStop`) before any write/install/delete/exec — including interpreter one-liners that write, shell scripts (`bash x.sh`), and `sh -c` with writes. Run those, and interactive commands, with Bash.
- Permissions: shell commands and read/grep/find/ls tool ops are re-checked against your Claude Code permission rules. A deny OR ask match hard-stops the walk (`policyStop`), because predexec cannot prompt mid-walk — run that step with your own Bash/Read tool instead. `Read(...)` deny rules use gitignore-style paths and also cover shell readers (cat, head, …).
- mutationStop/noEdgeMatch is recoverable — read the transcript and resume with bash. Never retry the same plan blindly. `policyStop` recovers the same way.
- A tool op exiting 2 never ran (missing, unreadable or out-of-scope path, bad argument) — read/ls included; exit 1 means it ran and found nothing (a grep/find with no matches).
- Truncated output is always flagged (`…[truncated`) — never branch on it as if it were complete.
- predexec's read/grep/find/ls are its own filesystem implementations, not the host's native tools — line numbering, truncation and .gitignore handling differ. Use the native tool when exact fidelity matters.
