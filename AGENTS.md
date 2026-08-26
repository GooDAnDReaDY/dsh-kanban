# Agent guide

## Package identity

Keep all three package identity sites aligned as `@goodandready/dsh-kanban`:

1. `package.json` package name
2. `cordis.patch.yml` loader name
3. `lib/client.js` loader id

The short Cordis patch id remains `dsh-kanban`. A mismatch produces **no log
error**: the host half works, the interface never appears. `test/identity.test.mjs`
catches it before install.

## Settings

The client settings API writes **scalar fields only**. The settings namespace
schema must stay flat — no arrays, no dictionaries. Boards live in the task
store, not in settings.

The settings card must check the snapshot **status**, not the value. With
status `unavailable` the `writable` flag still reads true, so a card that skips
the status check draws an empty but seemingly working form.

Saving writes every field and collects failures by name. A loop that stops at
the first failure leaves the rest unwritten and looks like a dead button.

Register the card in the `settings.plugin.item` slot with `key` equal to the
settings namespace. Do not add a top-level settings section.

## React

Declare every hook above every return. An early return placed above a hook
raises React error 310 on the first state change — the card works until you
click it.

## Workflow

- Use `git-claude` for every Git operation; never use bare `git`.
- Never commit, print, log, or embed tokens, credentials, private keys, or real
  instance secrets. No absolute paths, host names, or instance URLs either.
- Run `npm test` before committing behaviour changes.
- Staging installs use `file:` only. After a file-based change, reinstall with
  plugin remove followed by plugin add, then verify the installed copy: pnpm
  reuses the existing copy and will not pick up added files otherwise.

## Boundaries

This plugin does not create branches or worktrees, does not write the opening
issue comment, and does not touch Hermes Kanban. Branch and worktree fields on a
card are observations, not intentions.

## Slots

Slot names are not literal strings in the built interface, so a target cannot be
confirmed offline, and registering into a slot that does not exist succeeds
silently with nothing in the log. Register through the candidate list in
`registerFirst` and keep a fallback; never assume a slot exists.

## Store

Ordering is a string fractional index. Never replace it with an integer index:
a move would rewrite every row in the column. The SQL column is `col`, not
`column` — the latter is reserved.

## Launch

`startTask` creates the session, waits for idle, sends the first message and
only then writes to the store. Do not reorder: writing first parks a task in
progress with no session when a start fails.

## Values crossing into core APIs

Where a value is handed to a core API, tests must assert its SHAPE, not just
that the expected text is somewhere inside. A message content string passes
`content.includes('...')` exactly as an array of blocks does, and the core then
fails at runtime with `content.some is not a function`. Assert the array, the
block objects and the field names.
