// Отборы доски: репозиторий и пространства меток.
//
// Пространства не зашиты списком. Метки живут в Gitea и меняются без нашего
// участия — набор уже менялся дважды за час, — поэтому пространства собираются
// из того, что реально пришло на карточки. Зашитый список начал бы врать при
// первой же правке разметки.

/** Отбор по репозиторию стоит в одном ряду с метками, но метка ему не нужна. */
export const REPO = 'repo'

/**
 * Порядок известных пространств.
 *
 * Алфавит поставил бы `priority` перед `type`, а смотрят в первую очередь на
 * тип и срочность. Незнакомые пространства дописываются в конец по алфавиту:
 * заведут в Gitea новое — оно появится само, без правки кода.
 */
export const KNOWN_ORDER = ['type', 'priority', 'status', 'scope', 'risk', 'signal', 'release']

/** Разбор метки на пространство и значение; без `/` — пространства нет. */
export function splitLabel(name) {
  const text = String(name ?? '')
  const at = text.indexOf('/')
  if (at <= 0 || at === text.length - 1) return undefined
  return { ns: text.slice(0, at), value: text.slice(at + 1) }
}

/**
 * Из чего собрать отборы.
 *
 * Метки без пространства (`epic`, `hotfix`) своего отбора не получают: список
 * из двух значений ради двух меток — мебель. На карточках они видны и находятся
 * поиском.
 *
 * Считаем по ВСЕМ переданным задачам, а не по уже отобранным: счётчик рядом со
 * значением отвечает на вопрос «сколько там всего», а не «сколько осталось
 * после моего же выбора».
 *
 * @returns {Array<{ns: string, values: Array<{value: string, count: number}>}>}
 */
export function facetsOf(tasks) {
  const byNs = new Map()
  const add = (ns, value) => {
    if (value === '') return
    if (!byNs.has(ns)) byNs.set(ns, new Map())
    const values = byNs.get(ns)
    values.set(value, (values.get(value) ?? 0) + 1)
  }

  for (const task of tasks ?? []) {
    add(REPO, typeof task?.repo === 'string' ? task.repo : '')
    for (const name of task?.labels ?? []) {
      const parsed = splitLabel(name)
      if (parsed !== undefined) add(parsed.ns, parsed.value)
    }
  }

  return [...byNs.entries()]
    .map(([ns, values]) => ({
      ns,
      values: [...values.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    }))
    .sort((a, b) => rank(a.ns) - rank(b.ns) || a.ns.localeCompare(b.ns))
}

/** Репозиторий первым, затем известные пространства, затем всё прочее. */
function rank(ns) {
  if (ns === REPO) return -1
  const at = KNOWN_ORDER.indexOf(ns)
  return at === -1 ? KNOWN_ORDER.length : at
}

/**
 * Подходит ли задача под выбранное.
 *
 * Между пространствами — И, внутри пространства — ИЛИ. «Срочные баги» это
 * `priority/high` И `type/bug`; а выбор `high` вместе с `critical` означает
 * «любая из двух», потому что срочность у задачи одна и «И» внутри
 * пространства всегда давало бы пусто.
 *
 * @param {object} selected карта пространство -> список выбранных значений
 */
export function matchesFilters(task, selected) {
  for (const [ns, values] of Object.entries(selected ?? {})) {
    const wanted = values ?? []
    if (wanted.length === 0) continue
    if (!hasAny(task, ns, wanted)) return false
  }
  return true
}

function hasAny(task, ns, wanted) {
  if (ns === REPO) return wanted.includes(task?.repo ?? '')
  for (const name of task?.labels ?? []) {
    const parsed = splitLabel(name)
    if (parsed !== undefined && parsed.ns === ns && wanted.includes(parsed.value)) return true
  }
  return false
}

/** Выбрано ли хоть что-нибудь: пустой набор отборов доску не сужает. */
export function anySelected(selected) {
  return Object.values(selected ?? {}).some((values) => (values ?? []).length > 0)
}

/**
 * Переключить одно значение.
 *
 * Возвращает новую карту, а не правит прежнюю: состояние отборов живёт в
 * React, и правка на месте не вызвала бы перерисовку.
 */
export function toggleValue(selected, ns, value) {
  const current = (selected ?? {})[ns] ?? []
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value]
  const out = { ...(selected ?? {}) }
  if (next.length === 0) delete out[ns]
  else out[ns] = next
  return out
}

/** Снять всё разом. */
export function clearFilters() {
  return {}
}

/**
 * Метки задачи, разобранные по пространствам.
 *
 * Едет на карточке вместе с задачей: браузерная половина — отдельный бандл и
 * позвать этот модуль не может, а разбор, написанный там во второй раз,
 * однажды разойдётся с этим.
 *
 * @returns {object} карта пространство -> список значений
 */
export function facetsOfTask(task) {
  const out = {}
  for (const name of task?.labels ?? []) {
    const parsed = splitLabel(name)
    if (parsed === undefined) continue
    if (out[parsed.ns] === undefined) out[parsed.ns] = []
    if (!out[parsed.ns].includes(parsed.value)) out[parsed.ns].push(parsed.value)
  }
  return out
}
