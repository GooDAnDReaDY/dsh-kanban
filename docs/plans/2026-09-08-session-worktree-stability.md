# План: Вектор 1 — Стабильность сессий и воркдеревьев (#227, #226, #213, #215)

## 1. Контекст и цели
Повышение отказоустойчивости жизненного цикла сессий задач в DSH Kanban:
- Сохранение привязки сессии к проекту в левом сайдбаре DSH (meta.cwd = projectRoot) при изоляции в воркдереве (#227).
- Возможность продолжить работу над задачей («↻ Продолжить / Resume») в существующем воркдереве без деструктивного сброса ветки (#226).
- Игнорирование структурного шума субмодулей и gitlink drift в проверках чистоты воркдерева checkWorktreeDirty (#213).
- Исключение дочерних сессий субагентов (invoke_subagent) из списка живых сессий и трекинга карточек (#215).

## 2. Архитектурные изменения
- **lib/worktree.js**:
  - checkWorktreeDirty: вызов gitRunner(['status', '--porcelain', '--ignore-submodules=all'], worktreePath) для устранения ложного dirty-статуса от субмодулей.
- **lib/launcher.js**:
  - obtainAgent: meta.cwd фиксируется как projectRoot, meta.worktreePath = worktreePath.
  - unTask: поддержка флага esume: boolean. При esume: true ветка и файлы сохраняются, а в промпт добавляется директива продолжения работы.
  - liveSessions: фильтрация сессий с origin === 'subagent' или parentId !== undefined.
- **lib/lifecycle.js**:
  - handleSessionEvent: игнорирование событий от сессий-субагентов.
- **lib/routes.js**:
  - Эндпоинт POST /tasks/:id/resume.
- **lib/index.js**:
  - Регистрация маршрута /dsh-kanban/tasks/:id/resume.
- **lib/client.js**:
  - Кнопка «↻ Resume» в TaskDrawer.

## 3. Верификация
- Юнит-тесты: 	est/worktree-dirty.test.mjs, 	est/launcher-cwd.test.mjs, 	est/resume.test.mjs, 	est/subagent-filter.test.mjs.
- Полный прогон 
pm test и 
pm run compat.
- Проверка пакета 
pm pack --dry-run --json.
- Тест на MiniPC test runner через dsh-test-plugin.