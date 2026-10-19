import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Run verification gate command for task before moving to review (#372).
 *
 * @param {object} options
 * @param {object} options.task
 * @param {object|Function} options.config
 * @param {string} [options.worktreePath]
 * @param {Function} [options.spawnRunner]
 * @returns {Promise<{
 *   passed: boolean,
 *   skipped?: boolean,
 *   skipReason?: string,
 *   command: string,
 *   exitCode: number,
 *   stdout: string,
 *   stderr: string,
 *   logSnippet: string,
 *   durationMs: number
 * }>}
 */
export async function runVerificationGate({
  task,
  config,
  worktreePath,
  spawnRunner = spawn,
}) {
  const cfg = typeof config === 'function' ? config() : (config || {})
  const enabled = cfg.verificationGateEnabled !== false
  const customCmd = typeof task?.verificationCommand === 'string' && task.verificationCommand.trim() !== ''
    ? task.verificationCommand.trim()
    : ''
  const defaultCmd = typeof cfg.verificationCommand === 'string' && cfg.verificationCommand.trim() !== ''
    ? cfg.verificationCommand.trim()
    : 'npm test'
  const command = customCmd || defaultCmd
  const timeoutMs = Number(task?.verificationTimeoutMs || cfg.verificationTimeoutMs) || 120000

  const cwd = worktreePath || task?.worktree
  if (!cwd || !existsSync(cwd)) {
    return {
      passed: true,
      skipped: true,
      skipReason: 'worktree-not-found',
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
      logSnippet: '',
      durationMs: 0,
    }
  }

  // If gate is disabled and no task-specific command was configured, skip
  if (!enabled && !customCmd) {
    return {
      passed: true,
      skipped: true,
      skipReason: 'gate-disabled',
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
      logSnippet: '',
      durationMs: 0,
    }
  }

  // If using default 'npm test' but no package.json exists in worktree, skip safely
  if (!customCmd && defaultCmd === 'npm test') {
    const pkgPath = join(cwd, 'package.json')
    if (!existsSync(pkgPath)) {
      return {
        passed: true,
        skipped: true,
        skipReason: 'no-package-json',
        command,
        exitCode: 0,
        stdout: '',
        stderr: '',
        logSnippet: '',
        durationMs: 0,
      }
    }
  }

  const start = Date.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const MAX_OUTPUT = 64 * 1024

    const proc = spawnRunner('bash', ['-lc', command], {
      cwd,
      timeout: timeoutMs,
      env: {
        ...process.env,
        CI: 'true',
        DEBIAN_FRONTEND: 'noninteractive',
      },
    })

    const timer = setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
    }, timeoutMs)

    proc.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += chunk.toString('utf8')
      }
    })

    proc.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += chunk.toString('utf8')
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      const durationMs = Date.now() - start
      stderr += '\n' + (err.message || String(err))
      resolve({
        passed: false,
        command,
        exitCode: 1,
        stdout,
        stderr,
        logSnippet: (stdout + '\n' + stderr).trim().slice(-4000),
        durationMs,
      })
    })

    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      const durationMs = Date.now() - start
      if (timedOut || signal === 'SIGTERM') {
        stderr += `\n[Verification Gate] Execution timed out after ${timeoutMs}ms.`
      }
      const exitCode = typeof code === 'number' ? code : (timedOut ? 124 : 1)
      const passed = exitCode === 0
      const logSnippet = (stdout + '\n' + stderr).trim().slice(-4000)
      resolve({
        passed,
        command,
        exitCode,
        stdout,
        stderr,
        logSnippet,
        durationMs,
      })
    })
  })
}

/**
 * Send failure prompt to agent session if active.
 */
export function sendVerificationFailurePrompt({ agents, task, createMessage, command, exitCode, logSnippet }) {
  const sessionId = typeof task?.sessionId === 'string' ? task.sessionId : ''
  if (!sessionId || !agents) return false
  let agent
  try { agent = agents.get(sessionId) } catch { agent = undefined }
  if (!agent || typeof agent.followup !== 'function') return false

  const text = "Automated verification before Review failed (" + command + ", exit code " + exitCode + ").\nFix the test failures:\n\n```\n" + logSnippet + "\n```"
  try {
    const msg = typeof createMessage === 'function'
      ? createMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'dsh-kanban', plugin: 'dsh-kanban', form: 'verification-failure' },
        })
      : { content: [{ type: 'text', text }] }
    agent.followup(msg)
    return true
  } catch {
    return false
  }
}

/**
 * Check and run verification gate before move to review, recording outcome.
 *
 * @returns {Promise<{ allowed: boolean, verification: object }>}
 */
export async function verifyAndRecordGate({
  task,
  config,
  store,
  agents,
  createMessage,
  spawnRunner,
}) {
  const vRes = await runVerificationGate({ task, config, spawnRunner })
  if (vRes.skipped) {
    return { allowed: true, verification: vRes }
  }

  const currentReport = typeof task.report === 'object' && task.report ? { ...task.report } : {}
  currentReport.verification = {
    status: vRes.passed ? 'passed' : 'failed',
    command: vRes.command,
    exitCode: vRes.exitCode,
    durationMs: vRes.durationMs,
    verifiedAt: Date.now(),
    log: vRes.logSnippet,
  }

  if (store) {
    store.setReport(task.id, currentReport)
    store.updateTask(task.id, {
      verificationStatus: vRes.passed ? 'passed' : 'failed',
    })

    if (!vRes.passed) {
      store.addComment(task.id, {
        author: 'system',
        role: 'system',
        text: `[Verification Gate Failed]: \`${vRes.command}\` exited with code ${vRes.exitCode}.\n\`\`\`\n${vRes.logSnippet.slice(-2000)}\n\`\`\``,
      })
    }
  }

  if (!vRes.passed) {
    sendVerificationFailurePrompt({
      agents,
      task,
      createMessage,
      command: vRes.command,
      exitCode: vRes.exitCode,
      logSnippet: vRes.logSnippet,
    })
    return { allowed: false, verification: vRes }
  }

  return { allowed: true, verification: vRes }
}
