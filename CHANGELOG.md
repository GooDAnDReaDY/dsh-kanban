# Changelog

Notable changes to `@goodandready/dsh-kanban`.

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
