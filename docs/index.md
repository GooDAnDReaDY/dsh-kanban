# dsh-kanban Documentation Index

Welcome to the technical documentation for `@goodandready/dsh-kanban`.

## Documents
- [Design Contract](design/DESIGN.md) — UI/UX specifications, palette, typography, columns, and acceptance gates.
- [AGENTS.md](../AGENTS.md) — Developer and agent workflow contract for MiniAI and Gitea.
- [English README](../README.md) — Public package overview, setup, and configuration.
- [Русская документация](../README.ru.md) — Полное руководство пользователя и администратора.
- [中文文档](../README.zh.md) — 完整的使用和配置说明.

## Architecture Highlights
- **Task Store (`lib/store.js`)**: SQLite WAL database with fractional indexing ordering (`lib/order.js`).
- **Launcher & Concurrency (`lib/launcher.js`)**: Session limits, permissions gate, atomic reservations, worktree isolation.
- **Dual-Forge Routing (`lib/git-provider.js`, `lib/sync.js`, `lib/outbound.js`)**: Gitea and GitHub composite integration.
- **Workflow Engine (`lib/workflow-bridge.js`)**: Sequential multi-role workflows delivering completed tasks to `review`.
- **Live SSE Event Hub (`lib/events.js`, `lib/index.js`)**: Real-time board mutations broadcasting `task:change`.
