---
name: predexec-claude
description: Route read-only shell work (ls/grep/find/cat, read/grep/find/ls tool calls, and predictable command sequences) through the predexec MCP tool instead of Bash. Use Bash only for writes/installs/deletes and interactive commands.
---

# predexec routing (Claude Code)

- Prefer `mcp__predexec__predexec` for all read-only shell operations and multi-step read sequences.
- Batch independent reads with `parallel:true`; share a base dir with `cwd`; branch with `edges`.
- Relative paths resolve against the session directory (the transcript's `# cwd:` header). Don't build depth on unverified paths — verify layout in the first node (`ls`) and gate children with `file exists` edges.
- predexec hard-stops before any write/install/delete — use Bash for those and for interactive commands.
- Shell commands are re-checked against your own `permissions` rules: a `deny` **or** `ask` match hard-stops the walk before running, because predexec cannot prompt mid-walk. Run those through Bash instead.
- `mutationStop` / `noEdgeMatch` / `policyStop` is recoverable: read the transcript and resume with Bash. Never retry the same plan blindly.
- predexec's `read`/`grep`/`find`/`ls` are its own filesystem implementations, not Claude Code's native tools — line numbering, truncation and .gitignore handling differ. Use the native Read tool when exact fidelity matters.
