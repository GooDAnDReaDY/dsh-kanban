# Changelog

Notable changes to `@goodandready/dsh-kanban`.

## 0.2.34

### Added
- **Remote Mode for PC Client Operating Against Server 111 (#390)**:
  - Enabled full seamless operation of DSH Kanban when running on Windows PC client desktop against server 111 (`/mnt/external/Project/DEV/**`), matching the behavior of running directly on the Linux server.
  - Implemented remote DSH server HTTP relay (`lib/remote-relay.js`): transparently intercepts `/dsh-kanban/board` requests on PC client and proxies board state, cards, and transitions to server 111 over HTTP with bearer authentication and cookies.
  - Implemented remote SSH Git runner (`lib/remote-runner.js`): executes worktree operations (`createTaskWorktree`, `checkWorktreeDirty`, `mergeTaskWorktree`, `cleanupTaskWorktree`, file diff, and file discard) on server 111 via SSH with POSIX-escaped command wrapping and optional `sudo -u <user>` execution.
  - Added remote worktree path handling (`lib/worktree.js`) resolving paths to POSIX `/mnt/external/Project/DEV/.worktrees` without Windows backslash corruption, and safe worktree existence validation over SSH.
  - Added 10 remote configuration options (`lib/config.js`): `remoteMode`, `remoteHost`, `remotePort`, `remoteUser`, `remoteAuthType`, `remoteKeyPath`, `remoteSudoUser`, `remoteRoot`, `remoteServerUrl`, and `remoteServerToken`.
  - Added UI remote controls (`lib/client.js`): Settings Card Remote Execution section with "Test Connection" button testing both SSH connectivity and DSH Server API responsiveness via `/api/dsh-kanban/remote/test`, visual `🌐 Remote: 111` tag in board header, and remote chat session launcher.
  - Preserved 100% backward compatibility: when `remoteMode: false` (default), local execution paths are completely unchanged.

## 0.2.33

### Added
- **Interactive Live Steering (Nudge) of Active Agent (#373)**:
  - Added interactive steering button (`💬 Nudge`) on kanban cards for tasks in `in-progress` column with active agent sessions.
  - Implemented interactive Nudge modal allowing operators to provide prompts, clarifications, and course corrections directly to the running agent.
  - Implemented `handleTaskNudge` endpoint (`POST /dsh-kanban/task/:id` with action `nudge`) routing prompts to active sessions via `agent.followup` conforming to DSH session format v4 (`source.kind: 'dsh-kanban'`, `source.form: 'task-nudge'`).
  - Recorded steering prompts as user comments with `[Steering Nudge]` prefix for full auditability, and broadcasted updates via `eventHub`.
  - Added real-time agent execution step telemetry (`task.liveStep`) displaying active operations directly on task cards.

- **Token & Cost Telemetry via @goodandready/dsh-cost-meter (#374)**:
  - Integrated token and cost telemetry with `@goodandready/dsh-cost-meter` using zero-coupling dynamic service discovery (`isCostMeterAvailable`), ensuring clean fail-soft behavior when the cost meter plugin is absent.
  - Created `lib/cost-telemetry.js` providing session token usage extraction (`extractSessionUsage`) across models and slot buckets, token cost calculations (`calculateTokenCost`) with support for custom rate schedules and currencies, and budget limit checks (`checkCostLimit`).
  - Added configuration options `costMeterEnabled` and `taskCostLimit` (USD), persisting cost metrics (`costMetrics`, `costLimitExceeded`) on tasks in SQLite store.
  - Added token and cost badges (`🪙 1.5k · $0.21`) and budget limit warning indicators (`⚠️ Budget Exceeded`) on kanban cards, along with detailed token breakdowns (Tokens, Input, Output, Cache) in task modals and settings.

## 0.2.32

### Added
- **Automated Verification Gate on Review (#372)**:
  - Added configurable automated verification gate (`verificationGateEnabled: true`, `verificationCommand: 'npm test'`, `verificationTimeoutMs: 120000`) executed prior to transitioning tasks to `review`.
  - Blocks manual UI column moves and `board_move` agent tool invocations if test commands fail (HTTP 422 Unprocessable Entity), preventing broken code from advancing to review.
  - Automatically posts verification failure diagnostics directly to active agent sessions via `agent.followup` (`source.kind: 'dsh-kanban'`, `source.form: 'verification-failure'`) with command exit code and truncated error logs.
  - Displays dynamic `✓ PASS` / `✗ FAIL` status badges on task cards and failure inspection blocks in the task detail modal.
  - Added per-task command override support via `verificationCommand` attribute in `tasks` table.

- **Worktree Diff Inspector & Granular File Discard (#371)**:
  - Enhanced `GET /task/:id/diff` endpoint with structured inspection data: changed files list with status indicators (`modified`, `added`, `deleted`, `untracked`), line change counts (`+insertions / -deletions` via `git diff --numstat`), and truncated diff payload (500 KB limit).
  - Added `POST /task/:id/discard` endpoint enabling safe, granular file reverts: tracked files are restored via `git restore` and `git checkout`, while untracked files are pruned with strict path-traversal fencing.
  - Built interactive Diff Inspector section in task modal with file status pills, line change indicators, per-file discard button with confirmation prompt, and collapsible unified diff viewer.

## 0.2.31

### Fixed
- **Reverse Proxy Boundary Fencing & Client Credentials Enforcement (#384)**:
  - Closed critical authentication bypass when requests are forwarded through reverse proxies (e.g. `dsh-lanmode` on port 3080) to the backend web server on loopback (`127.0.0.1:3000`).
  - Added `connection` to `export const inject` in `lib/index.js` so Cordis properly provides the DSH connection service to the plugin.
  - Enhanced `getClientIp(req)` to extract the real client IP from `x-forwarded-for` when the incoming socket is on a loopback address.
  - Implemented `hasClientCredentials(req)` to detect genuine client-supplied credentials (Bearer token, `x-dsh-lan-pin`, PIN cookies `dsh_lan_pin`/`dsh_token`, or client authority cookies `dsh-auth-*`), rejecting requests that only carry reverse-proxy injected loopback cookies.
  - Enforced client credential verification in `getRejectionStatus` (`lib/routes.js`) and `isTrustedUpdateRequest` (`lib/updater.js`).
  - Added unit and integration tests verifying 401 rejection on proxied requests without client credentials for `/batch`, `/sessions`, `/project-task`, and updater routes.

## 0.2.30

### Fixed
- **LAN Authentication Bypass & Critical Endpoint Fencing (#384)**:
  - Eliminated authentication bypass where LAN clients forging `Sec-Fetch-Site: same-origin` or without credentials could reach `/dsh-kanban/batch` to execute agent sessions with arbitrary prompt text, as well as read session lists and mutate project tasks.
  - Implemented `getRejectionStatus(req, options)` and `rejectUntrustedRequest(req, res, options)` in `lib/routes.js`, integrating DSH session authentication via `ctx.connection.requestRejection(req)`.
  - Non-loopback calls (including LAN and remote IP addresses) require valid DSH session authentication; unauthenticated requests fail-closed with HTTP 401 Unauthorized.
  - Socket calls with unknown remote addresses fail-closed with HTTP 403 Forbidden.
  - Fenced all 19 plugin HTTP endpoints and the SSE events stream with dynamic connection resolution.
  - Added connection session verification to `lib/updater.js`.
  - Updated Request Trust Policy in `docs/design/DESIGN.md` and added test coverage in `test/routes.test.mjs` and `test/index-load.test.mjs`.

## 0.2.29

### Fixed
- **Agent Prompt & Board Tools Availability Alignment (#382, GitHub #1)**:
  - Replaced unconditional system prompt injection with dynamic helper `buildPromptSectionText(cfg)`.
  - Suppressed prompt section on stock configurations where neither board tools nor progress dumps are active (`boardToolEnabled: false`, `progressDumpEnabled: false`), preventing model hallucinations and saving context tokens.
  - Strictly gated tool usage guidance (`board_move`, `board_plan`) on `boardToolEnabled === true`.
  - Gated `PROGRESSDUMP` guidance on `progressDumpEnabled === true`.
  - Updated `CONFIG_HINTS.announceToAgent` description in `lib/config.js`.

## 0.2.22

### Fixed
- **Git Runner Process Exit Contract (#327)**:
  - Standardized runner status evaluation in `lib/worktree.js` (`diff`, `commits`, `merge`) to support both `result.exitCode` and `result.code` uniformly.
- **Workflow & Batch Permission Negotiation Gate (#328)**:
  - Enforced permission tier verification (`permissionConfirmedTier`) in `lib/launcher.js`, `lib/routes.js`, and `lib/workflow-bridge.js`. Prevents elevation attacks when a task's permission is re-requested at a higher tier than confirmed by the user.
- **Opened & Resumed Session Effective Permission Enforcement (#329)**:
  - Unified `applyPermission` invocation across newly created, opened, and resumed sessions in `lib/launcher.js`. Ensured chosen or stored `task.permission` is consistently applied to the agent session; rejects task execution fail-closed (`permission-unavailable`) if permissions setter is missing or fails.
- **Global Cross-Board Session Concurrency Limit (#330)**:
  - Extended live session counting across all boards via `store.listBoards()` in `lib/launcher.js` and `lib/workflow-bridge.js`, backed by atomic reservation tracking (`reserveSessionSlot`, `releaseSessionSlot`) to eliminate race conditions during concurrent task spawning.
- **Delayed & Queued Launch Parameter Preservation (#331)**:
  - Ensured queued/cron task dispatches in `lib/launcher.js` preserve all card parameters: `provider`, `model`, `permission`, `reasoningEffort`, `agentPreset`, and initial handover text.
- **Dual-Forge Routing for GitHub & Gitea (#332)**:
  - Added native `forge` attribution (`github` vs `gitea`) across `lib/store.js`, `lib/routes.js`, `lib/import.js`, `lib/sync.js`, and `lib/outbound.js`. Synchronizations and outbound dispatches group and route tasks to the corresponding forge client.
- **Full JSON Snapshot Import/Export Data Integrity (#333)**:
  - Extended JSON export and import in `lib/store.js` and `lib/routes.js` to serialize and restore all 16 canonical task fields, archived tasks (`restoreTask`), and full transition history (`restoreTransition`).
- **Human DoD Acceptance Workflow Completion Boundary (#334)**:
  - Restricted automated workflow completion advancement in `lib/workflow-bridge.js` to `review` column (`in-progress` and `review` map to `review`). The `done` column remains strictly reserved for human DoD acceptance and review sign-off.
- **Reasoning Effort Parameter Persistence & Propagation (#335)**:
  - Preserved `reasoningEffort` across card update routes (`updateTask`) and passed it to agent lifecycle calls (`agents.create` and `agents.resume`) in `lib/launcher.js`.
- **Composite Git Provider Repository Creation (#336)**:
  - Exported `createRepo` from composite `lib/git-provider.js` and implemented `createRepo` in `lib/github.js` for parity with Gitea.
- **Multiline Progress Dump Block Roundtrip (#338)**:
  - Enhanced `lib/progress-dump.js` to cleanly capture multiline `Next steps:` blocks and verified `parse(format(dump))` bidirectional roundtrip fidelity.
- **Checklist Toggle API Canonical Completed State (#339)**:
  - Added canonical `completed: Boolean` alongside backward-compatible `done` in `toggleChecklistItem` in `lib/routes.js`.
- **CSV Formula Injection Mitigation (#340)**:
  - Sanitized untrusted cell strings starting with formula trigger prefixes (`=`, `+`, `-`, `@`, `\t`, `\r`) in `exportTasksCsv` in `lib/routes.js` per OWASP guidelines.
- **Fail-Closed Git Cleanup & Safe Removal (#341)**:
  - In `lib/worktree.js`, failed closed when git dirty status check cannot be determined, blocking deletion on runner errors and removing unsafe forced deletion fallbacks.
- **Worktree Isolation Precondition Enforcement (#342)**:
  - Enforced worktree isolation in `lib/launcher.js`: when worktree creation fails for a git repository, execution halts immediately with error rather than unsafely falling back to the project root.
- **Broadcasting SSE State Changes on HTTP Mutations (#343)**:
  - Wired `eventHub` into `lib/index.js` and `lib/board-tool.js` to broadcast `task:change` SSE events on all card mutations (`createTask`, `updateTask`, `deleteTask`, `setArchived`, `importBoard`, `syncAll`, and AI board tools).
- **Documentation & Agent Specification Alignment (#344)**:
  - Added canonical `AGENTS.md` and `docs/index.md`, repaired relative markdown links in `docs/design/DESIGN.md`, and aligned column definitions across documentation.
- **CC0 Fractional Indexing Replacement & Migration (#345)**:
  - Replaced linear string inflation in `lib/order.js` with CC0-1.0 `fractional-indexing` (`lib/fractional-indexing.js`), maintaining bounded key lengths (4 bytes after 10,000 appends). Added atomic SQLite startup migration `fractional_indexing_migrated`.

## 0.2.21

### Fixed
- **Settings Service Compatibility & Schema Protection (#310, #311, #313, #346)**:
  - Eliminated `sctx.settings.register` calls (method does not exist in DSH 0.2.0-rc.x), avoiding runtime exceptions during plugin startup.
  - Migrated configuration updates to standard schema description and watcher lifecycle.
  - Decorated sensitive and transient config schema fields with `.volatile()`.
- **Workflow Script Code Injection Prevention (#314)**:
  - Replaced raw template literal interpolation in `buildWorkflowScript` with safe `JSON.stringify` serialization for dynamic parameters (`issueNumber`, task ids, roles, and titles).
- **Worktree Ownership & Path Traversal Fencing (#315)**:
  - Enforced `isPathFenced` boundary validation across `cleanupTaskWorktree` and `removeTaskWorktree`, blocking execution against foreign or out-of-bounds directories.
- **SSE Origin Verification & Strict Headers (#316)**:
  - Restricted SSE event stream in `lib/events.js` using `isTrustedRequest` and removed wildcard `*` CORS header.
- **Fail-Closed Permission Gate & Config Hint Alignment (#317)**:
  - Defaulted unknown permission tiers to `Infinity` (fail closed) in permission ranking checks.
  - Corrected `sessionDefaultPermission` configuration description hint to `(read-only, workspace-write, danger-full-access)`.
- **Board Move Column Validation (#318)**:
  - Enforced column existence verification against board columns (`columnsOf`) in `applyMove`, rejecting invalid column targets with HTTP 400 `invalid-column`.
- **Credential Reference Recognition (#319)**:
  - Updated secret detection in `lib/gitea.js` (`looksLikeSecret` / `isCredentialName`) to support valid uppercase credential reference identifiers >= 32 characters without misclassifying them as raw secrets.
- **Workflow Completion Comment Preservation (#320)**:
  - Fixed workflow completion handler in `lib/workflow-bridge.js` to call `this.store.addComment`, and added `store.addTaskComment` compatibility alias in `lib/store.js`.
- **Git Branch Argument Injection Prevention (#321)**:
  - Validated target checkout branch with `isSafeBranchName` and enforced disambiguated `git checkout -- <target>` in `mergeTaskWorktree`.
- **Regex Metacharacter Escaping (#322)**:
  - Escaped regex metacharacters in `branchOfTask` and `pullsOfTask` issue matching, and strictly required positive safe integers.
- **Sequential Outbox Delivery (#323)**:
  - Replaced unawaited `forEach` in `runBatch` with sequential `for (const item of batch) await send(item)` to ensure reliable message delivery order.
- **Dynamic Outbox Store Binding (#324)**:
  - Supported dynamic store accessor function in `createOutbox` to prevent capturing stale `undefined` during initialization.
- **User Identity Claim Security (#325)**:
  - Removed client header spoofing via `x-dsh-user` in `claimAs`, resolving user identity exclusively through authenticated `await whoAmI()`.
- **GitHub Issue Index Validation (#326)**:
  - Enforced strict positive safe integer validation (`safeIssueIndex`) and URI encoding for GitHub issue indices.

## 0.2.20

### Fixed
- **Complete Localization & Code Comments English Standardization (#258, #347, #350)**:
  - Eliminated all hardcoded Russian text from runtime server code across `lib/*.js`: API error messages, log warnings, transition history details, CSV export headers, and prompts are now standardized in natural English.
  - Replaced all 1552 lines of Russian code comments across all modules in `lib/` with concise, natural technical English. Verified zero Cyrillic lines across all `lib/*.js` files (`grep -cP '[\u0400-\u04FF]' lib/*.js == 0`).
  - Standardized transition history details in English: assignee assignment/unassignment, conflict resolution messages, PR creation/merge, and session queue events.
  - Exported CSV headers updated to standard English (`ID`, `Title`, `Column`, `Priority`, `Repository`, `Issue #`, `Assignee`, `Model`, `Provider`, `Reasoning Effort`, `Workspace`, `Branch`, `Created`, `Updated`).
  - Unit test suite passes 100% (737/737 tests passing).

## 0.2.19

### Fixed
- **Webhook provider resolution (#303)**: connected `detectWebhookProvider` to route handler in `lib/index.js` and removed unused public export of `LABEL_ROLE_PATTERNS` in `lib/workflow-bridge.js`.
- **Intake rejection slugs & template base (#304)**: converted hardcoded Russian rejection reasons in `lib/intake.js` to canonical English machine slugs (`missing-number`, `pull-request-ignored`, `issue-closed`, `already-exists`, `tombstone-ignored`) and converted default task templates in `lib/templates.js` to canonical English base.
- **SQLite busy timeout & route method enforcement (#305)**: removed duplicate `PRAGMA busy_timeout` call in `lib/store.js` and enforced HTTP 405 Method Not Allowed checks on all read-only routes in `lib/index.js`.

## 0.2.18

### Fixed
- **Workflow start reference error (#302)**: fix undeclared identifier `gitRunner` in `POST /dsh-kanban/task/:id/workflow-start`. Export `defaultGitRunner` from `lib/worktree.js`, import and pass it explicitly in `lib/index.js`, and set `gitRunner = defaultGitRunner` default parameter in `WorkflowBridge.startTaskWorkflow`. Added integration test verifying error-free workflow startup.

## 0.2.17

### Added
- **Core Workflow Engine Bridge (#300)**: integrated directly with core `ctx.workflowEngine` without intermediate orchestrators. Task launch generates a multi-agent workflow script (`buildWorkflowScript`) with role mapping (`spec`, `backend`, `qa_tests`, `docs`) based on card columns and labels, with graceful fallback to default preset if role packages are absent. Synchronizes core lifecycle events (`workflow/agent-start`, `workflow/agent-end`, `workflow/end`) with SQLite task state (`workflowRunId`, `workflowStatus`: `running`, `completed`, `failed`, `cancelled`), auto-advances the card to the target column on completion, and posts completion summaries to linked Gitea/GitHub issues and card comments. Adds workflow run cancellation (`POST /task/:id/workflow-cancel`), status endpoint (`GET /task/:id/workflow-status`), and interactive UI buttons (`⚡ Workflow`, `Cancel Workflow`) in TaskDrawer. Completely removes dependency on `@goodandready/dsh-agent-orchestrator`.

## 0.2.16

### Fixed
- **Database & Backup Filesystem Permissions**: enforced strict `0700` (`rwx------`) permissions on the task store directory and `backups/` directory, and `0600` (`rw-------`) on all SQLite database, WAL, SHM, and backup files (`lib/store.js`). Added automatic legacy installation repair during `openStore` before serving any HTTP routes, preventing local data exposure (#298).

## 0.2.15

### Added
- **Full GitHub Integration**: introduced complete GitHub REST API v3 client (`lib/github.js`) with conditional ETag caching (`If-None-Match` / HTTP 304) protecting GitHub's 5,000 req/hr rate limit (#296).
- **Composite Git Provider**: added `lib/git-provider.js` router seamlessly delegating issue, PR, and repo operations between Gitea and GitHub based on task provider, issue URL, or `gitProvider` setting (`auto`, `gitea`, `github`) (#296).
- **Dual Webhook Verification**: extended webhook listener (`lib/webhook.js`) to parse and verify GitHub HMAC-SHA256 signatures (`x-hub-signature-256`, `sha256=`) alongside Gitea hex payloads, routing inbound events automatically (#296).
- **Forge Settings & Status Badges**: added `gitProvider`, `githubTokenRef`, `githubOwner`, and `githubWebhookSecretRef` to settings schema, UI card, and locale dictionaries (EN, ZH) with live status badges (`GitHub Configured` / `No Token`) (#296).
- **Multi-Forge SQLite Storage**: added `provider` column and `github` task source support to SQLite store and import pipelines (#296).

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
