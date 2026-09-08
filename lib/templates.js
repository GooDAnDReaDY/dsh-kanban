// Шаблоны задач для быстрой постановки типовых работ (#220).

export const TASK_TEMPLATES = [
  {
    id: 'feature',
    title: 'Новая функциональность (Feature)',
    promptTemplate: 'Реализовать новую функциональность:\n- Цель:\n- Требования:\n- Границы изменений:',
    checklist: [
      { id: '1', text: 'Архитектурный план и дизайн-контракт согласованы', required: true, completed: false },
      { id: '2', text: 'Код написан с соблюдением стандартов проекта', required: true, completed: false },
      { id: '3', text: 'Написаны автоматические модульные/интеграционные тесты', required: true, completed: false },
      { id: '4', text: 'Документация обновлена (README, docs/)', required: true, completed: false },
    ],
    priority: 'medium',
  },
  {
    id: 'bugfix',
    title: 'Исправление ошибки (Bugfix)',
    promptTemplate: 'Локализовать и исправить дефект:\n- Шаги воспроизведения:\n- Ожидаемое поведение:\n- Фактическое поведение:',
    checklist: [
      { id: '1', text: 'Дефект воспроизведен изолированным тестом', required: true, completed: false },
      { id: '2', text: 'Причина устранена без побочных эффектов', required: true, completed: false },
      { id: '3', text: 'Регрессионный тест добавлен в test suite', required: true, completed: false },
    ],
    priority: 'high',
  },
  {
    id: 'refactor',
    title: 'Рефакторинг и оптимизация (Refactoring)',
    promptTemplate: 'Провести рефакторинг модуля без изменения внешнего поведения:\n- Целевой модуль:\n- Проблема архитектуры:\n- Критерии завершения:',
    checklist: [
      { id: '1', text: 'Покрыто существующими тестами (100% green)', required: true, completed: false },
      { id: '2', text: 'Упрощена структура/устранен техдолг', required: true, completed: false },
      { id: '3', text: 'Производительность не деградировала', required: true, completed: false },
    ],
    priority: 'low',
  },
  {
    id: 'security',
    title: 'Аудит безопасности и зависимостей (Security)',
    promptTemplate: 'Проверить безопасность и уязвимости зависимостей:\n- Область проверки:\n- Ревизия зависимостей:',
    checklist: [
      { id: '1', text: 'Проверен supply-chain и лицензии зависимостей', required: true, completed: false },
      { id: '2', text: 'Устранены известные CVE', required: true, completed: false },
      { id: '3', text: 'Секреты и токены проверены на отсутствие утечек', required: true, completed: false },
    ],
    priority: 'high',
  },
  {
    id: 'release',
    title: 'Подготовка и выпуск релиза (Release Prep)',
    promptTemplate: 'Подготовить релиз пакета:\n- Версия:\n- Список изменений:\n- Проверки перед публикацией:',
    checklist: [
      { id: '1', text: 'Все тесты репозитория пройдены (npm test)', required: true, completed: false },
      { id: '2', text: 'Совместимость с ядром подтверждена (npm run compat)', required: true, completed: false },
      { id: '3', text: 'Размер упакованного пакета проверен (< 256 КБ)', required: true, completed: false },
      { id: '4', text: 'Документация и changelog дополнены', required: true, completed: false },
    ],
    priority: 'medium',
  },
]

export function getTemplateById(id) {
  return TASK_TEMPLATES.find((t) => t.id === id)
}