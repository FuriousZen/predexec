Use predexec (call it via `call_mcp_tool`, ServerName `predexec` or `predexec_predexec` when
installed as the predexec plugin) for all read-only shell operations. Run `run_command` directly
only for writes/installs/deletes and interactive commands.

- Prefer `predexec` for read-only shell work and multi-step read sequences; batch independent
  reads with `parallel:true`, share a base dir with `cwd`, branch with `edges`.
- Relative paths resolve against the session directory (the transcript's `# cwd:` header). Don't
  build depth on unverified paths — verify layout in the first node (`ls`) and gate children with
  `file exists` edges.
- predexec hard-stops before any write/install/delete — run those directly with `run_command` instead.
- `mutationStop` / `noEdgeMatch` / `policyStop` is recoverable: read the transcript and resume
  normally. Never retry the same plan blindly.
