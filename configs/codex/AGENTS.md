Use predexec (the model sees it as `mcp__predexec__predexec`) for all read-only shell
operations. Run shell commands directly only for writes/installs/deletes and interactive
commands.

- Prefer `predexec` for read-only shell work and multi-step read sequences; batch independent
  reads with `parallel:true`, share a base dir with `cwd`, branch with `edges`.
- Relative paths resolve against the session directory (the transcript's `# cwd:` header). Don't
  build depth on unverified paths — verify layout in the first node (`ls`) and gate children with
  `file exists` edges.
- predexec hard-stops before any write/install/delete, and before unknown commands and
  repository code (`bash x.sh`, `python3 script.py`, `npm test`, `make`) — run those directly instead.
- `mutationStop` / `noEdgeMatch` is recoverable: read the transcript and resume normally.
  Never retry the same plan blindly.
