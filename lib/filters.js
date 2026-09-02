// Отборы доски: репозиторий и пространства меток.
//
// Пространства не зашиты списком. Метки живут в Gitea и меняются без нашего
// участия — набор уже менялся дважды за час, — поэтому пространства собираются
// из того, что реально пришло на карточки. Зашитый список начал бы врать при
// первой же правке разметки.

/** Отбор по репозиторию стоит в одном ряду с метками, но метка ему не нужна. */
export const REPO = 'repo'

/** Автор задачи — такое же измерение отбора, как метка, но живёт своим полем. */
export const AUTHOR = 'author'

/** Ответственный: кто взял задачу, а не кто её завёл. */
export const ASSIGNEE = 'assignee'

/** Выпуск, к которому задача отнесена в Gitea. */
export const MILESTONE = 'milestone'

/** Приоритет — локальное свойство доски, своё измерение отбора. */
export const PRIORITY = 'priority'

/**
 * Значение для задач без автора.
 *
 * Свои задачи заводятся на доске и автора не имеют. Выбросить их из отбора
 * значило бы отвечать на вопрос «кто завёл» неполным списком: «никто» — тоже
 * ответ, и по нему тоже отбирают.
 */
export const NO_AUTHOR = '—'

/**
 * Значение для задач без ответственного.
 *
 * «Никто не взял» — самый нужный отбор на доске: именно эти задачи ищут, когда
 * спрашивают «что свободно».
 */
export const NOBODY = '—'

/** Значение для задач вне выпусков: «когда-нибудь» — тоже ответ. */
export const NO_MILESTONE = '—'

/** Порядок приоритетов в отборе: срочное сверху. */
export const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low']

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
    add(ASSIGNEE, typeof task?.assignee === 'string' && task.assignee !== '' ? task.assignee : NOBODY)
    add(MILESTONE, typeof task?.milestone === 'string' && task.milestone !== '' ? task.milestone : NO_MILESTONE)
    add(AUTHOR, typeof task?.author === 'string' && task.author !== '' ? task.author : NO_AUTHOR)
    // Приоритет живёт и полем (свои карточки), и меткой `priority/*` (задачи
    // из Gitea). Оба попадают в одно измерение — отбор по срочности не должен
    // зависеть от того, откуда пришло значение.
    add(PRIORITY, typeof task?.priority === 'string' ? task.priority : '')
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
        .sort((a, b) => valueRank(ns, a.value) - valueRank(ns, b.value) || a.value.localeCompare(b.value)),
    }))
    .sort((a, b) => rank(a.ns) - rank(b.ns) || a.ns.localeCompare(b.ns))
}

/** Репозиторий первым, затем известные пространства, затем всё прочее. */
function rank(ns) {
  if (ns === REPO) return -3
  // Ответственный идёт раньше автора: «кто делает» спрашивают чаще, чем «кто
  // завёл».
  if (ns === ASSIGNEE) return -2
  // Выпуск идёт сразу за ответственным: «что осталось до релиза» спрашивают
  // тогда же, когда «кто делает».
  if (ns === MILESTONE) return -1.5
  if (ns === AUTHOR) return -1
  const at = KNOWN_ORDER.indexOf(ns)
  return at === -1 ? KNOWN_ORDER.length : at
}

/**
 * Порядок значений внутри пространства.
 *
 * Приоритет — «срочное сначала», а не алфавит: `critical` сперва, `low`
 * в самом низу. Для остальных — обычное сравнение строк.
 */
function valueRank(ns, value) {
  if (ns !== PRIORITY) return 0
  const at = PRIORITY_ORDER.indexOf(value)
  return at === -1 ? PRIORITY_ORDER.length : at
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
  if (ns === ASSIGNEE) {
    const who = typeof task?.assignee === 'string' && task.assignee !== '' ? task.assignee : NOBODY
    return wanted.includes(who)
  }
  if (ns === MILESTONE) {
    const to = typeof task?.milestone === 'string' && task.milestone !== '' ? task.milestone : NO_MILESTONE
    return wanted.includes(to)
  }
  if (ns === AUTHOR) {
    const author = typeof task?.author === 'string' && task.author !== '' ? task.author : NO_AUTHOR
    return wanted.includes(author)
  }
  if (ns === PRIORITY) {
    // Приоритет и полем, и меткой `priority/*` — отбор по срочности не должен
    // зависеть от источника значения.
    if (wanted.includes(typeof task?.priority === 'string' ? task.priority : '')) return true
    for (const name of task?.labels ?? []) {
      const parsed = splitLabel(name)
      if (parsed !== undefined && parsed.ns === PRIORITY && wanted.includes(parsed.value)) return true
    }
    return false
  }
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

/**
 * Цвет метки из ответа Gitea.
 *
 * Приходит шестизначным кодом без решётки (`0e8a16`), но встречается и с ней.
 * Всё, что не похоже на шестнадцатеричный код, считаем отсутствием цвета:
 * значение попадает прямо в стиль, и пускать туда что попало нельзя.
 *
 * @returns {string|undefined} код без решётки
 */
export function labelColor(value) {
  const text = String(value ?? '').trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : undefined
}

/**
 * Карта имя метки -> цвет из списка меток issue.
 *
 * Держим отдельно от имён: имена читают отборы, сверка, чип и поиск, и менять
 * их устройство ради оформления было бы дорого и ни к чему.
 */
export function colorsOfIssue(labels) {
  const out = {}
  for (const l of labels ?? []) {
    const name = typeof l === 'string' ? l : l?.name
    if (typeof name !== 'string' || name === '') continue
    const color = labelColor(typeof l === 'string' ? undefined : l?.color)
    if (color !== undefined) out[name] = color
  }
  return out
}

/**
 * Вес задачи при подъёме наверх колонки.
 *
 * Ждущие впереди идущих намеренно: идущая работа идёт сама, а ждущая стоит
 * из-за человека, и он должен увидеть её первой.
 *
 * Ручной порядок не переписывается — внутри каждой ступени он сохраняется, а
 * подъём работает поверх него.
 */
export function liveRank(task) {
  const state = task?.state
  if (task?.waiting === true || state === 'waiting') return 0
  if (state === 'running') return 1
  if (state === 'stopped') return 2
  return 3
}

/** Вес приоритета при подъёме: срочное впереди тихого. */
export function priorityWeight(priority) {
  const at = PRIORITY_ORDER.indexOf(priority)
  return at === -1 ? PRIORITY_ORDER.length : at
}

/**
 * Поднять идущее наверх и приоритетное следом, не теряя прежнего порядка.
 *
 * Две независимые оси: сначала жизнь (ждёт/идёт/стоит), затем срочность
 * (critical → low). Ручной порядок внутри ступени сохраняется.
 */
export function sortByLife(tasks) {
  return (tasks ?? [])
    .map((task, at) => ({ task, at }))
    .sort((a, b) => liveRank(a.task) - liveRank(b.task)
      || priorityWeight(a.task?.priority) - priorityWeight(b.task?.priority)
      || a.at - b.at)
    .map((x) => x.task)
}

/**
 * Разложить задачи по проектам.
 *
 * Крупные группы впереди: проект с двадцатью задачами не должен теряться под
 * однозадачными. При равенстве — по имени, чтобы порядок не плясал между
 * обновлениями.
 *
 * @returns {Array<{repo: string, tasks: Array<object>}>}
 */
export function groupByRepo(tasks) {
  const byRepo = new Map()
  for (const task of tasks ?? []) {
    const repo = typeof task?.repo === 'string' && task.repo !== '' ? task.repo : ''
    if (!byRepo.has(repo)) byRepo.set(repo, [])
    byRepo.get(repo).push(task)
  }
  return [...byRepo.entries()]
    .map(([repo, list]) => ({ repo, tasks: list }))
    .sort((a, b) => b.tasks.length - a.tasks.length || a.repo.localeCompare(b.repo))
}
