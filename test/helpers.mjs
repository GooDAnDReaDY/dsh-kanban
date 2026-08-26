// Общий помощник для тестов хранилища: свежая база на временном каталоге,
// который убирается за собой. Вынесен сразу, а не после третьего копирования —
// им пользуются тесты хранилища, маршрутов, запуска и чипа.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../lib/store.js'

export function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-'))
  const store = openStore({ dir })
  return {
    store,
    dir,
    cleanup() {
      // Закрытие терпит повтор: часть тестов закрывает базу сама, чтобы
      // проверить переоткрытие.
      try { store.close() } catch { /* уже закрыта */ }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Открыть заново тот же каталог — для проверки, что данные пережили перезапуск. */
export function reopenStore(dir) {
  return openStore({ dir })
}
