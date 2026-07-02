# predexec routing

Drop this block into your project's `AGENTS.md` (or `CLAUDE.md`) so opencode loads the
predexec routing rule natively. When present, the predexec plugin detects it (via the
`predexec` marker) and skips its own system-prompt injection — no duplication.

---

Use predexec for all read-only shell operations. Use bash only for writes/installs/deletes
and interactive commands.

- Prefer `predexec` for read-only shell work and multi-step read sequences; batch independent
  reads with `parallel:true`, share a base dir with `cwd`, branch with `edges`.
- predexec hard-stops before any write/install/delete — use bash for those.
- `mutationStop` / `noEdgeMatch` is recoverable: read the transcript and resume with bash.
  Never retry the same plan blindly.
