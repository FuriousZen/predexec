---
name: predexec
description: Use predexec for all read-only shell operations. Use bash only for writes/installs/deletes and interactive commands. Use it for ls/cat/grep/find-style reads, read/grep/find/ls tool calls, and predictable multi-step read sequences (one plan tree, one round-trip); it hard-stops before the writes, installs and deletes it detects.
---

# predexec routing (Antigravity)

- Call the `predexec` tool via `call_mcp_tool` (ServerName `predexec`, or `predexec_predexec` when installed as the predexec plugin).
- Use parallel:true for independent reads, cwd for a shared base dir, and edges to branch.
- A node's `commands` mixes shell strings and tool ops: `{tool:"read",path,offset?,limit?} | {tool:"grep",pattern,path?,glob?,ignoreCase?,literal?,context?,limit?} | {tool:"find",pattern,path?,limit?} | {tool:"ls",path?,limit?}`.
- Edge conditions — when: "always" | "exit == 0" (ops ==,!=,<,>) | "stdout =~ /regex/" (also stderr, !~) | "file exists <path>" / "file missing <path>", or a {kind,...} condition object.
- Relative paths resolve against the session directory (the transcript's '# cwd:' header). Do not build depth on unverified paths: verify layout in the first node (ls) and gate children with 'file exists' edges.
- predexec hard-stops (`mutationStop`) before writes, installs and deletes — including interpreter one-liners that write, shell scripts (`bash x.sh`), `sh -c` with writes, and commands whose name is computed at run time (`$c`). It does NOT stop an interpreter running an existing script file (`python3 script.py`, `node x.js`, `node --test`): that code is not inspected, so run a script you do not know to be read-only with `run_command`. Run writes, installs, deletes and interactive commands with `run_command`.
- Permissions: shell commands and file reads are re-checked against your Antigravity grants (`command(...)` / `read_file(...)`, Deny > Ask > Allow). A deny OR ask match hard-stops the walk (`policyStop`), because predexec cannot prompt mid-walk — run that step with your own tools instead. Under `toolPermission: "strict"` every step needs a matching allow, `allowNonWorkspaceAccess: false` stops tool ops outside the workspace, and an unreadable settings file stops everything until it is fixed.
- mutationStop/noEdgeMatch is recoverable — read the transcript and resume with bash. Never retry the same plan blindly. `policyStop` recovers the same way. ("bash" here means `run_command`.)
- A tool op exiting 2 never ran (missing, unreadable or out-of-scope path, bad argument) — read/ls included; exit 1 means it ran and found nothing (a grep/find with no matches).
- Truncated output is always flagged (`…[truncated`) — never branch on it as if it were complete.
- predexec's read/grep/find/ls are its own filesystem implementations, not the host's native tools — line numbering, truncation and .gitignore handling differ. Use the native tool when exact fidelity matters.
