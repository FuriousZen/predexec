---
name: predexec
description: Route read-only shell work (ls/grep/find/cat, read/grep/find/ls tool calls, and predictable command sequences) through the predexec tool instead of bash. Use bash only for writes/installs/deletes and interactive commands.
---

# predexec routing

- Prefer `predexec` for all read-only shell operations and multi-step read sequences.
- Batch independent reads with `parallel:true`; share a base dir with `cwd`; branch with `edges`.
- predexec hard-stops before any write/install/delete — use bash for those and for interactive commands.
- `mutationStop` / `noEdgeMatch` is recoverable: read the transcript and resume with bash. Never retry the same plan blindly.
