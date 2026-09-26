# predexec routing (manual fallback)

**Most installs don't need this file.** The predexec opencode plugin registers its
packaged skill automatically, via opencode's `config` hook appending to
`skills.paths` — `predexec` shows up in the model's skill list with no manual step.

Use this drop-in block only when:
- an agent's `tools.skill:false` or a `permission.skill` deny rule hides skills from it
  entirely (the plugin's guarded system-prompt fallback covers this case too, but this
  file gives you the exact wording under your own control), or
- your opencode version/host doesn't pick up the config-hook registration (see
  `docs/research/opencode-skills.md` for what was actually measured), or
- you want the routing text without installing the plugin at all.

Drop this block into your project's `AGENTS.md` (or `CLAUDE.md`) so opencode loads the
predexec routing rule natively. When present, the predexec plugin detects it (a quorum
of routing-rule markers, not a mere mention of the name) and skips its own
system-prompt injection — no duplication.

---

Use predexec for all read-only shell operations. Use bash only for writes/installs/deletes
and interactive commands.

- Prefer `predexec` for read-only shell work and multi-step read sequences; batch independent
  reads with `parallel:true`, share a base dir with `cwd`, branch with `edges`.
- Relative paths resolve against the session directory (the transcript's `# cwd:` header). Don't
  build depth on unverified paths — verify layout in the first node (`ls`) and gate children with
  `file exists` edges.
- predexec hard-stops before any write/install/delete — use bash for those.
- `mutationStop` / `noEdgeMatch` is recoverable: read the transcript and resume with bash.
  Never retry the same plan blindly.
