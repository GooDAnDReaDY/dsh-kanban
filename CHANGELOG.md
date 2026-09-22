# Changelog

Notable changes to `@goodandready/dsh-kanban`.

## 0.2.14

### Added
- **Plugin Manager Row Seat**: registered `plugins.row.config` slot keyed `@goodandready/dsh-kanban#dsh-kanban` separately as primary configuration seat for DSH `0.1.6-alpha.2`, keeping `plugins.item` and legacy `settings.plugin.item` as fallbacks (#274).
- **View-Aware Settings Card**: `KanbanSettingsCard` renders view-aware surfaces: `view: 'summary'` produces a single-line subtitle, and `view: 'page'` renders a bare, uncollapsed form matching host page chrome (#274).

### Fixed
- **Worktree Drawer Variables**: declared missing `diff` and `commits` state variables in `BoardScreen`, fixing a ReferenceError crash in task modal for worktree-backed tasks (#281).
- **Resume Task Route**: resolved undeclared `mintSessionId`, `createMessage`, `cwdOf`, and `gitRunner` identifiers in `POST /task/:id/resume` (#280).
- **Queue Dispatch & Cron**: imported missing `SessionId`, `randomUUID`, and `createUserMessage` in `lib/index.js`, fixing background dispatch and scheduled cron executions (#279).
- **Plugin Lifecycle Cleanup**: registered `ctx.on('dispose')` handler to clear `KanbanEventHub` heartbeat interval and safely close open SSE client connections upon plugin teardown (#282).
- **Storage Transaction Batching & Indexes**: added `store.withTransaction` atomic batching for board imports, cached prepared `insertTask` statement, and added composite indexes `tasks_updated` and `tasks_archivable` (#283).

### Refactored
- **Dead Exports Cleanup**: connected uncalled internal exports to production execution paths across `lib/` modules (`columnsOfKind`, `looksLikeSecret`, `revivalKind`, `canRevive`, `getTemplateById`, `isSafeHref`, `relativeParts`, `prepareMultiRepoMirror`) (#284).

## 0.2.13

### Fixed
- **Producer-Owned Source Kinds for DSH Format v4**: messages dispatched via `agent.followup` across all execution paths (`task-start`, `task-resume`, `task-queued`, `batch-queued`, `board-command`) now use producer-owned source kind `source.kind: 'dsh-kanban'` satisfying DSH session format v4 validation (`assertV4RowAdmission`) while maintaining backward compatibility with `source.plugin: 'dsh-kanban'` (#287).

## 0.2.12

### Fixed
- Settings no longer wait on the removed settingsScope service. The client uses configForms (#285).

## 0.2.11

### Fixed
- **Settings reachable again on the plugin's own page**: the current DSH core
  (0.1.6-alpha.2) renders a plugin's configuration page only for entries registered
  in the plugin-list seat `plugins.item` — that is how `dsh-agentrouter` and
  `dsh-agent-orchestrator` show their settings, while the row seat and the legacy
  card alone leave the page without the form. The seat is registered additively,
  separately from the existing fallback chain (`registerFirst`), so it does not turn
  the chain into an either/or choice; the label is a static string.

## 0.2.10

### Fixed
- **Settings reachable again**: the card registered into `settings.plugin.item`, a
  slot the current DSH core (0.1.6-alpha.2) no longer renders, so the plugin's
  settings were unreachable. The surface now registers into the Plugins page row
  seat `plugins.row.config` first, keyed `@goodandready/dsh-kanban#dsh-kanban`
  (`rowConfigKey(package, rowId)`): the plugin's row gains a configure control whose
  page is the settings form (`view: 'page'`, open and without our card chrome — the
  host page draws the title, icon, crumb and padding) plus a one-line state for
  `view: 'summary'`. The legacy seat stays in the `registerFirst` list as a fallback
  for older cores.

### Added
- This changelog.
