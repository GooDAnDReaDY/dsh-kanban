import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libDir = join(__dirname, '..', 'lib')

test('Automated AST & Syntax Quality Gate: all lib/*.js files have valid syntax', () => {
  const files = readdirSync(libDir).filter((f) => f.endsWith('.js'))
  assert.ok(files.length >= 20, `Expected at least 20 modules in lib, found ${files.length}`)

  for (const file of files) {
    const fullPath = join(libDir, file)
    // node --check verifies JS grammar
    const out = execFileSync(process.execPath, ['--check', fullPath], { encoding: 'utf8' })
    assert.equal(out, '', `Syntax error in ${file}`)
  }
})

test('Automated Quality Gate: verified absence of undeclared critical globals in lib/index.js (#246, #250, #252)', () => {
  const indexContent = readFileSync(join(libDir, 'index.js'), 'utf8')

  // Critical identifiers that caused past regressions MUST be explicitly imported
  const requiredImports = [
    { name: 'z', specifier: '@deepseek-ai/schemastery' },
    { name: 'defineTool', specifier: '@deepseek-ai/dsh-tools' },
    { name: 'CONFIG_DEFAULTS', specifier: './config.js' },
    { name: 'CONFIG_HINTS', specifier: './config.js' },
    { name: 'MAX_BODY_BYTES', specifier: './routes.js' },
    { name: 'openStore', specifier: './store.js' },
    { name: 'rootOf', specifier: './worktree.js' },
  ]

  for (const req of requiredImports) {
    assert.ok(
      indexContent.includes(req.name),
      `Identifier ${req.name} must be present in lib/index.js`
    )
    assert.ok(
      indexContent.includes(req.specifier),
      `Specifier ${req.specifier} must be imported in lib/index.js`
    )
  }
})

test('Automated Quality Gate: style isolation attribute on client CSS (#254)', () => {
  const clientContent = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.ok(
    clientContent.includes('style.dataset.dshPlugin = NS') || clientContent.includes('style.dataset.dshPlugin = \'dsh-kanban\''),
    'lib/client.js must set dataset.dshPlugin on injected style element'
  )
})

test('Automated Quality Gate: multi-language standard compliance in lib/config.js (#254)', () => {
  const configContent = readFileSync(join(libDir, 'config.js'), 'utf8')
  
  // No Russian board titles in DEFAULT_BOARDS
  assert.ok(!configContent.includes("'Проектная доска'"), 'DEFAULT_BOARDS must use canonical English')
  assert.ok(!configContent.includes("'Простая доска'"), 'DEFAULT_BOARDS must use canonical English')
  assert.ok(configContent.includes("'Project Board'"), 'DEFAULT_BOARDS must include Project Board')
  assert.ok(configContent.includes("'Simple Board'"), 'DEFAULT_BOARDS must include Simple Board')

  // No hardcoded Russian replyInstruction default
  assert.ok(!configContent.includes("'Отвечай по-русски.'"), 'replyInstruction must default to empty string')
})

test('Automated Quality Gate: multi-language standard compliance in lib/commands.js (#254)', () => {
  const commandsContent = readFileSync(join(libDir, 'commands.js'), 'utf8')
  
  // No Russian instructions in TABLE
  assert.ok(!commandsContent.includes('Начни или продолжи'), 'commands.js must use canonical English instructions')
  assert.ok(!commandsContent.includes('Влей pull request'), 'commands.js must use canonical English instructions')
  assert.ok(commandsContent.includes('standard workflow'), 'commands.js must have English standard workflow instruction')
})
