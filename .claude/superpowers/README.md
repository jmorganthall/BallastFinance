# Superpowers skills (vendored)

The skills in `.claude/skills/` other than `grill-me` and `grilling` are copied
unchanged from [obra/superpowers](https://github.com/obra/superpowers) at commit
`bb92a77741419a4ab5f06e711a283343f1ada0c3` (2026-10-09), MIT licensed — see
`LICENSE` here.

They are copied rather than enabled as a plugin because a cloud session does not
install plugins a repository turns on in `.claude/settings.json`; it does load
the repository's `.claude/skills/`.

Not copied: the plugin's SessionStart hook, which injects `using-superpowers`
into every session. Without it the skills fire on their descriptions. The
skills refer to each other as `superpowers:<name>`; here each is just `<name>`.
The repo's CLAUDE.md is the source of truth where the two disagree.

To update: clone the repo, replace these skill directories with its `skills/`,
and change the commit above.
