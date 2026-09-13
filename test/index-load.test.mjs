import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// Register mock loader for external @deepseek-ai/* peer dependencies
const loaderCode = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/schemastery') {
    const code = \`
      const chain = () => {
        const obj = {
          default: () => obj,
          description: () => obj,
          role: () => obj,
        }
        return obj
      }
      const z = {
        object: (shape) => ({ shape, ...chain() }),
        string: chain,
        number: chain,
        boolean: chain,
        array: chain,
      }
      export default z
    \`
    return {
      url: 'data:text/javascript,' + encodeURIComponent(code),
      format: 'module',
      shortCircuit: true,
    }
  }
  if (specifier === '@deepseek-ai/dsh-credentials') {
    const code = 'export function credentialRef(x) { return { ref: x } }'
    return {
      url: 'data:text/javascript,' + encodeURIComponent(code),
      format: 'module',
      shortCircuit: true,
    }
  }
  if (specifier === '@deepseek-ai/dsh-tools') {
    const code = 'export function defineTool(x) { return x }'
    return {
      url: 'data:text/javascript,' + encodeURIComponent(code),
      format: 'module',
      shortCircuit: true,
    }
  }
  return nextResolve(specifier, context)
}
`

const loaderPath = join(tmpdir(), `test-loader-${Date.now()}.mjs`)
writeFileSync(loaderPath, loaderCode, 'utf8')
register(pathToFileURL(loaderPath))

test('lib/index.js успешно импортируется и оценивается без ReferenceError (#246)', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.name, 'dsh-kanban')
  assert.equal(mod.SETTINGS_NAMESPACE, 'dsh-kanban')
  assert.ok(mod.Config, 'Config не экспортирован')
  assert.equal(typeof mod.storeDir, 'function')
})

test('lib/index.js apply() регистрирует эффект и корректно обращается к службам и хранилищу', async () => {
  const mod = await import('../lib/index.js')
  const effects = []
  const mockCtx = {
    inject(deps, fn) {
      fn({
        settings: {
          register: () => ({ get: () => ({}), watch: () => {} }),
        },
      })
    },
    effect(fn, desc) {
      effects.push({ fn, desc })
      return fn()
    },
    on() {},
    get() { return null },
    credentials: {
      resolve: async () => ({ value: 'test' }),
    },
    webServer: {
      use() {},
      register() {},
    },
    agents: {
      get() { return null },
    },
    logger: {
      warn() {},
      info() {},
      error() {},
    },
  }

  // Call apply to verify setup logic does not throw ReferenceError
  assert.doesNotThrow(() => {
    mod.apply(mockCtx, {})
  })

  // Cleanup effects
  for (const eff of effects) {
    if (typeof eff.fn === 'function') {
      try {
        const cleanup = eff.fn()
        if (typeof cleanup === 'function') cleanup()
      } catch {}
    }
  }
})

test('lib/index.js обработчики с чтением тела (readBody) не падают с ReferenceError на MAX_BODY_BYTES (#250)', async () => {
  const { Readable } = await import('node:stream')
  const mod = await import('../lib/index.js')
  const registeredRoutes = new Map()
  const effects = []

  const mockCtx = {
    inject(deps, fn) {
      fn({
        settings: {
          register: () => ({ get: () => ({}), watch: () => {} }),
        },
      })
    },
    effect(fn, desc) {
      effects.push({ fn, desc })
      return fn()
    },
    on() {},
    get() { return null },
    credentials: {
      resolve: async () => ({ value: 'test' }),
    },
    webServer: {
      use() {},
      register(route) {
        registeredRoutes.set(route.path, route)
      },
    },
    agents: {
      get() { return null },
    },
    logger: {
      warn() {},
      info() {},
      error() {},
    },
  }

  mod.apply(mockCtx, {})

  const route = registeredRoutes.get('/dsh-kanban/project-task')
  assert.ok(route, 'Маршрут /dsh-kanban/project-task должен быть зарегистрирован')

  // Создаем mock req со стримом данных
  const req = new Readable({
    read() {
      this.push(Buffer.from(JSON.stringify({ title: 'Test', repo: 'test-repo' })))
      this.push(null)
    },
  })
  req.method = 'POST'
  req.headers = { host: 'localhost' }

  let statusSent = null
  let bodySent = null
  const res = {
    writeHead(code, headers) { statusSent = code },
    end(body) { bodySent = body },
  }

  // Не должно бросать ReferenceError: MAX_BODY_BYTES is not defined
  await assert.doesNotReject(async () => {
    await route.handler(req, res)
  })

  // Очистка эффектов
  for (const eff of effects) {
    if (typeof eff.fn === 'function') {
      try {
        const cleanup = eff.fn()
        if (typeof cleanup === 'function') cleanup()
      } catch {}
    }
  }
})

test('lib/index.js регистрирует board-инструменты через defineTool при boardToolEnabled: true (#252)', async () => {
  const mod = await import('../lib/index.js')
  const registeredTools = []
  const effects = []

  const mockCtx = {
    inject(deps, fn) {
      fn({
        settings: {
          register: () => ({ get: () => ({ boardToolEnabled: true }), watch: () => {} }),
        },
      })
    },
    effect(fn, desc) {
      effects.push({ fn, desc })
      return fn()
    },
    on() {},
    get() { return null },
    credentials: {
      resolve: async () => ({ value: 'test' }),
    },
    webServer: {
      use() {},
      register() {},
    },
    tools: {
      register(tool) {
        registeredTools.push(tool)
        return () => {}
      },
    },
    agents: {
      get() { return null },
    },
    logger: {
      warn() {},
      info() {},
      error() {},
    },
  }

  assert.doesNotThrow(() => {
    mod.apply(mockCtx, { boardToolEnabled: true })
  })

  assert.equal(registeredTools.length, 8, 'Должно быть зарегистрировано ровно 8 инструментов доски')
  const names = registeredTools.map((t) => t.name)
  assert.ok(names.includes('board_move'))
  assert.ok(names.includes('board_plan'))
  assert.ok(names.includes('board_checklist'))
  assert.ok(names.includes('board_report'))
  assert.ok(names.includes('board_comments'))
  assert.ok(names.includes('board_comment_add'))
  assert.ok(names.includes('board_decompose'))
  assert.ok(names.includes('board_checklist_item'))

  for (const eff of effects) {
    if (typeof eff.fn === 'function') {
      try {
        const cleanup = eff.fn()
        if (typeof cleanup === 'function') cleanup()
      } catch {}
    }
  }
})


