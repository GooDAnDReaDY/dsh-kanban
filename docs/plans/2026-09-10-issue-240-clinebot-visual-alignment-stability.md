# 2026-09-10 — Задача #240: Приведение визуальной части к стилю dsh-clinebot и устранение дефектов рантайма

## Контекст и цели
1. Привести визуальный слой и настройки `dsh-kanban` к эталонному стандарту `dsh-clinebot`.
2. Устранить дефекты рантайма и потенциальные точки отказа.
3. Сохранить размер бандла в пределах строгого лимита (< 256 KiB для `client.js`).
4. Обеспечить 100% прохождение тестов (652/652) и проверку совместимости ядра.

## Выполненные изменения
- **Рruntime bugfix (`lib/index.js`)**:
  - В обработчике маршрута `/dsh-kanban/task/:id/resume` исправлена передача `permissions: ctx.permissions` (undefined) на канонический `permissions: ctx.get('permissionPresets')`. Это гарантирует корректное применение пресетов безопасности при возобновлении задач в `lib/launcher.js`.
- **Регрессионный тест (`test/resume.test.mjs`)**:
  - Добавлен тест на передачу пресетов разрешений в рантайм.
- **Визуальная синхронизация с `dsh-clinebot` (`lib/client.js`)**:
  - Внедрена функция `ensureCss()`: единая DOM-инжекция стилей с идентификатором `dsh-kanban-full-css` и `dataset.dshPlugin="dsh-kanban"`. Устранено троекратное создание тегов `<style>` при рендере компонентов `KanbanSettingsCard`, `BoardScreen`, `TaskChip`.
  - Внедрена защита через `createErrorBoundary()` с возможностью повтора при сбоях рендера (SafeSettingsCard).
  - Реализован `refreshMirrorUntilVisible(ctx)` для гарантированной загрузки пространств настроек при старте хоста.
  - В `KanbanSettingsCard` реализована поддержка `(ctx?.get && ctx.get('lanSettings')) || ctx?.settingsScope`.
  - Поля настроек сгруппированы в визуальные карточки-секции (`.dkb-section-card`, `.dkb-section-title`) со статусными индикаторами/бейджами (Gitea status badge, Sync interval badge).
- **Quality Gates**:
  - `npm test`: 652/652 тестов пройдено успешно.
  - `npm run compat`: расхождений с ядром нет.
  - Размер `lib/client.js`: 252 301 байт (< 256 KiB лимит выдержан).
  - Обновление версионирования до 0.2.3 строго по канону Antigravity (инкремент только patch-версии $z$).