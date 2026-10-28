import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, runInNewContext } from 'node:vm'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// #396: BoardScreen must not crash with TDZ ReferenceError when load is referenced
// in handleNudgeSubmit's useCallback dependency array.

test('BoardScreen mounts without ReferenceError and triggers initial load (#396)', async () => {
  const src = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
  let spec
  const fetchCalls = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (s) => { spec = s } },
      localStorage: { getItem: () => null, setItem: () => {} },
      EventSource: class {
        addEventListener() {}
        removeEventListener() {}
        close() {}
      },
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ setAttribute: () => {}, dataset: {} }),
      head: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    setTimeout,
    clearTimeout,
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts })
      return {
        ok: true,
        json: async () => ({ columns: [], tasks: [], stats: {} }),
      }
    },
    AbortSignal: typeof AbortSignal !== 'undefined' ? AbortSignal : undefined,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
  }
  createContext(sandbox)
  runInNewContext(src, sandbox)

  const effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (v) => [v, () => {}],
    useMemo: (fn) => fn(),
    useCallback: (fn, deps) => {
      // Evaluate deps to ensure any TDZ or uninitialized references are exposed
      if (Array.isArray(deps)) {
        for (let i = 0; i < deps.length; i++) {
          assert.doesNotThrow(() => deps[i], 'Dependency must be initialized')
        }
      }
      return fn
    },
    useEffect: (fn, deps) => {
      effects.push({ fn, deps })
    },
    useRef: (v) => ({ current: v }),
    useSyncExternalStore: (_sub, get) => get(),
    memo: (fn) => fn,
  }

  const exported = spec.factory((name) => (name === 'react' ? react : {}))
  const BoardScreen = exported.helpers.BoardScreen
  assert.equal(typeof BoardScreen, 'function', 'BoardScreen helper must be exported')

  const dummyCtx = {
    locale: {
      bind: () => (k) => k,
    },
  }
  const dummyToggle = {
    isOpen: () => true,
    set: () => {},
  }

  // Invoking BoardScreen component executes its body hooks
  let element
  assert.doesNotThrow(() => {
    element = BoardScreen({ ctx: dummyCtx, toggle: dummyToggle, onClose: () => {} })
  }, 'BoardScreen mount must not throw ReferenceError for load (#396)')

  assert.ok(element, 'BoardScreen returned a rendered element tree')

  // Run the collected effects (simulating React commit phase)
  for (const eff of effects) {
    await eff.fn()
  }

  // Verify that load(board) was triggered and made fetch call to /board
  const boardFetch = fetchCalls.find((call) => call.url.includes('/board'))
  assert.ok(boardFetch, 'Initial mount effect must invoke load and fetch board data')
})

