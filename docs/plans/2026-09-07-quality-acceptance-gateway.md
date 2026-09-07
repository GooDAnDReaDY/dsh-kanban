# План реализации: Human-in-the-Loop Quality & Acceptance Gateway (#205–#209)

Пакетная реализация сквозного контура контроля качества и человеческой приёмки для `@goodandready/dsh-kanban`:
- **#205**: DoD Acceptance Checklist с фиксацией доказательств (`board_checklist`)
- **#206**: Структурированный отчёт выполнения задачи (`board_report`)
- **#207**: Двусторонний цикл приёмки человеком (Accept / Send back with reason)
- **#208**: Ветка комментариев к задаче и синхронизация с агентом (`board_comments`, `board_comment_add`)
- **#209**: Протокольный шлюз запрета перевода задачи в Done агентом

## 1. Архитектурные требования
1. **Протокольный шлюз Done (#209)**: агент через инструмент `board_move` не может перевести задачу в `done`. Статус `done` может быть установлен только человеком.
2. **Шлюз перехода в Review (#205)**: если в задаче заданы обязательные пункты Definition of Done, переход в `review` блокируется до закрытия всех обязательных пунктов с предоставлением evidence.
3. **Отчёт выполнения (#206)**: агент формирует структурированный отчёт (`board_report`) с полями `summary`, `changed_files`, `checks_run`, `artifacts`, `risks`.
4. **Приёмка и возврат (#207)**: в колонке `review` человек может нажать «Принять» (в `done`) или «Вернуть» (в `in-progress`) с обязательным указанием причины, которая инжектируется в следующую сессию агента.
5. **Обсуждение задачи (#208)**: карточка содержит тред комментариев с поддержкой ролей `user` и `agent`, доступный через HTTP API и инструменты `board_comments`, `board_comment_add`.

## 2. Пошаговые задачи
- [ ] 1. Модель данных и миграции SQLite в `lib/store.js`.
- [ ] 2. Инструменты агента `board_checklist`, `board_report`, `board_comments`, `board_comment_add`, валидаторы `board_move` в `lib/board-tool.js`.
- [ ] 3. Регистрация инструментов в `lib/index.js`.
- [ ] 4. Маршруты `/accept`, `/reject`, `/checklist`, `/report`, `/comments` в `lib/routes.js`.
- [ ] 5. Инъекция замечаний возврата и DoD в `lib/launcher.js`.
- [ ] 6. Пользовательский интерфейс Task Drawer и карточек в `lib/client.js`.
- [ ] 7. Юнит-тесты: `test/checklist.test.mjs`, `test/report.test.mjs`, `test/acceptance.test.mjs`, `test/comments.test.mjs`.
- [ ] 8. Актуализация `docs/design/DESIGN.md`.
