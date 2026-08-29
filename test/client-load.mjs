// Браузерная половина грузится загрузчиком и импортировать файлы репозитория
// не может, поэтому тесты поднимают её через node:vm с заглушкой загрузчика и
// заглушкой React. Так проверяются и чистые помощники, и регистрация слотов —
// без браузера и без сборки.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, runInNewContext } from 'node:vm'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

export function loadClient({ storage } = {}) {
  const src = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
  let spec
  // Хранилище браузера подставляется тестом: своего у песочницы нет, а
  // помощники памяти запуска читают именно `window.localStorage`.
  const sandbox = {
    window: { __ModuleLoader__: { load: (s) => { spec = s } }, localStorage: storage },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  }
  createContext(sandbox)
  runInNewContext(src, sandbox)
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (v) => [v, () => {}],
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useSyncExternalStore: (_sub, get) => get(),
  }
  const exported = spec.factory((name) => (name === 'react' ? react : {}))
  return { spec, exported, src, sandbox }
}

/** Заглушка контекста браузерной половины: запоминает, куда что зарегистрировано. */
export function stubCtx({ available }) {
  const registered = []
  return {
    registered,
    ctx: {
      effect: (fn) => fn(),
      locale: { register: () => {}, bind: () => (k) => k },
      slots: {
        inject(name, run) {
          if (!available.includes(name)) throw new Error(`слота ${name} нет в этой сборке`)
          run()
        },
        register(entry) { registered.push(entry) },
      },
    },
  }
}
