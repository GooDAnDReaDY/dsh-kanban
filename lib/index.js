// dsh-kanban — доска задач для DeepSeek Harness.
//
// Плагин состоит из двух половин: этот модуль — серверная, `lib/client.js` —
// браузерная. Имя пакета `@goodandready/dsh-kanban` обязано совпадать в трёх
// местах: `package.json`, `cordis.patch.yml` и `load({ id })` в client.js.
// Расхождение НЕ даёт ошибки в журнале — интерфейс просто не появляется.
//
// Чистая часть настроек вынесена в `lib/config.js`: она без зависимостей и
// проверяется тестами без харнесса. Здесь остаётся только обвязка cordis.

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { CONFIG_DEFAULTS, CONFIG_HINTS, withDefaults } from './config.js'

export { COLUMN_ORDER, columnLabelField, wipLimitField, withDefaults } from './config.js'

/** Стабильное имя плагина cordis (строка в патче сборки). */
export const name = 'dsh-kanban'

/**
 * Пока плагину нужны только настройки. Службы добавляются в тех задачах, где
 * впервые нужны: `webServer` — вместе с маршрутами доски, `gitea` — вместе с
 * импортом задач, `agents`/`sessions` — вместе с запуском работы. Объявленная,
 * но отсутствующая служба не даёт плагину загрузиться вовсе, поэтому список
 * держим по факту использования.
 */
export const inject = ['settings']

/** Пространство настроек; то же имя продублировано в браузерной половине. */
export const SETTINGS_NAMESPACE = settingsNamespace('dsh-kanban')

/**
 * Схема собирается из значений по умолчанию, чтобы список полей жил в одном
 * месте. Только скаляры: клиентский API настроек пишет ТОЛЬКО скалярные поля,
 * и словарь или массив здесь сделал бы карточку нередактируемой.
 */
export const Config = z.object(Object.fromEntries(
  Object.entries(CONFIG_DEFAULTS).map(([field, fallback]) => {
    const node = typeof fallback === 'number' ? z.number() : z.string()
    return [field, node.default(fallback).description(CONFIG_HINTS[field] ?? '')]
  }),
))

export function apply(ctx, config) {
  let effective = withDefaults(config)

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: effective })
    const read = () => withDefaults(scope.get() ?? effective)
    effective = read()
    ctx.effect(() => scope.watch(() => { effective = read() }), 'dsh-kanban: слежение за настройками')
  })

  // Читатель настроек для следующих задач: маршруты, импорт и запуск берут
  // значения отсюда, а не из замороженной копии момента загрузки, иначе
  // правка в карточке не доедет до работающего кода без перезапуска.
  ctx.kanbanConfig = () => effective
}
