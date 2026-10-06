# AGENTS.md — dsh-kanban

## Project Overview
`@goodandready/dsh-kanban` is a full-featured visual Kanban plugin for DeepSeek Harness (DSH).
It integrates tasks with Gitea and GitHub issues, manages agent session execution,
provides workflow columns with DoD checklist verification, and delivers real-time SSE updates.

## Environment & Server Access
- Host: MiniAI `192.168.1.111`.
- Transport user: `migrate`.
- Work directory: `/mnt/external/Project/DEV/dhsplugins/dsh-kanban`.
- Execution user: `vadim`. All git commands, tests, and builds run as `vadim` via:
  `sudo -u vadim -H bash -lc '<command>'`.
- Git author wrapper: `/home/vadim/.ssh/bin/git-antigravity`.
- Gitea credentials: `/mnt/external/Project/DEV/.gitea-agent-credentials.json`.
- Gitea repository: `goodandready/dsh-kanban`.
- GitHub repository: `GooDAnDReaDY/dsh-kanban`.

## Development & Git Workflow
1. Never work directly in root DEV checkout; always work inside an isolated worktree under `.worktrees/<branch>`.
2. Follow Gitea issues strictly:
   - Priority prefixes: `[critical]`, `H:`, `M:`, `L:`.
   - Post start comment with worktree path, plan, and scope.
3. Conventional Commits: `<type>(<scope>): <summary>` with `Refs: #<issue>`.
4. Run full test suite before committing: `npm test`.
5. Preflight check: verify plugin preflight script passes before release.
6. Open Gitea PR to `main`.
7. Non-negotiable versioning: patch releases ONLY (`0.2.z` -> `0.2.(z+1)`). Never change minor version without explicit user instruction.
8. Release authorization: Never merge PR, publish to npm, or deploy to production without explicit user permission.
9. Cleanup: Verify merge via `git merge-base --is-ancestor`, delete worktree and branch, update DEV root `main`.

## Safety Rules & Architecture Boundaries
- The `done` column is a human-only acceptance gate. Agent sessions and workflows must transition tasks to `review`, never directly to `done`.
- Worktree isolation precondition: if worktree creation fails, task launch must fail closed.
- Atomic session reservations and global board concurrency limits must be enforced.
- Never publish internal docs (`AGENTS.md`, `index.md`, `openwiki/`, `docs/plans/`) to npm or public GitHub releases.
