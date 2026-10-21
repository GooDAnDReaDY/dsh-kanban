/**
 * Remote SSH runner for git and worktree operations (#390).
 * Allows DSH running on PC (Windows) to execute commands on remote server (111).
 * Zero Cyrillic literals in lib/ according to Issue #366 standard.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Check whether remote execution mode is enabled in config.
 *
 * @param {object} config
 * @returns {boolean}
 */
export function isRemoteMode(config) {
  return Boolean(config && config.remoteMode)
}

/**
 * Quote argument safely for remote POSIX shell execution.
 *
 * @param {string|number} s
 * @returns {string}
 */
export function quoteArg(s) {
  return "'" + String(s ?? '').replace(/'/g, "'\\''") + "'"
}

/**
 * Build arguments array for SSH CLI process.
 *
 * @param {object} config
 * @param {string} remoteCommand
 * @returns {string[]}
 */
export function buildSshArgs(config, remoteCommand) {
  const host = String(config?.remoteHost || '192.168.1.111').trim()
  const port = Number(config?.remotePort) || 22
  const user = String(config?.remoteUser || 'migrate').trim()
  const keyPath = String(config?.remoteKeyPath || '').trim()
  const sudoUser = config?.remoteSudoUser !== undefined ? String(config.remoteSudoUser).trim() : 'vadim'

  const args = [
    '-p', String(port),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
  ]

  if (keyPath) {
    args.push('-i', keyPath)
  }

  const target = `${user}@${host}`
  args.push(target)

  let fullCmd = remoteCommand
  if (sudoUser) {
    fullCmd = `sudo -u ${sudoUser} -H bash -c ${quoteArg(remoteCommand)}`
  }

  args.push(fullCmd)
  return args
}

/**
 * Create a git runner function that delegates to remote host over SSH when remoteMode is active.
 * Conforms to (args, cwd) => Promise<{ stdout: string, stderr: string }>.
 *
 * @param {object} config
 * @param {Function} [localGitRunner] fallback local runner
 * @returns {Function}
 */
export function createRemoteGitRunner(config, localGitRunner) {
  return async function remoteGitRunner(args, cwd) {
    if (!isRemoteMode(config)) {
      if (typeof localGitRunner === 'function') {
        return localGitRunner(args, cwd)
      }
      throw new Error('[dsh-kanban] No local git runner available in non-remote mode')
    }

    const escapedArgs = (Array.isArray(args) ? args : []).map(quoteArg).join(' ')
    const cdPart = cwd ? `cd ${quoteArg(cwd)} && ` : ''
    const gitCmd = `${cdPart}git ${escapedArgs}`
    const sshArgs = buildSshArgs(config, gitCmd)

    try {
      const { stdout, stderr } = await execFileAsync('ssh', sshArgs, {
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      })
      return { stdout: stdout ?? '', stderr: stderr ?? '' }
    } catch (err) {
      const error = new Error(`[dsh-kanban-remote] git ${args?.[0] || ''} failed on ${config?.remoteHost || 'remote'}: ${err.message}`)
      error.code = err.code ?? 1
      error.stdout = err.stdout ?? ''
      error.stderr = err.stderr ?? err.message ?? ''
      throw error
    }
  }
}

/**
 * Check connectivity to remote server and verify remote root directory.
 *
 * @param {object} config
 * @returns {Promise<{ ok: boolean, latencyMs?: number, remoteRootFound?: boolean, error?: string }>}
 */
export async function testRemoteConnection(config) {
  const root = String(config?.remoteRoot || '/mnt/external/Project/DEV').trim()
  const probeCmd = `test -d ${quoteArg(root)} && echo REMOTE_ROOT_OK || echo REMOTE_ROOT_MISSING`
  const sshArgs = buildSshArgs(config, probeCmd)

  const startTime = Date.now()
  try {
    const { stdout } = await execFileAsync('ssh', sshArgs, {
      maxBuffer: 1024 * 1024,
      timeout: 12000,
      env: { ...process.env, LC_ALL: 'C' },
    })
    const latencyMs = Date.now() - startTime
    const trimmed = (stdout || '').trim()
    const remoteRootFound = trimmed.includes('REMOTE_ROOT_OK')

    return {
      ok: true,
      latencyMs,
      remoteRootFound,
    }
  } catch (err) {
    return {
      ok: false,
      error: err.stderr ? err.stderr.trim() : err.message,
    }
  }
}

/**
 * Check if path exists on remote host.
 *
 * @param {string} remotePath
 * @param {object} config
 * @returns {Promise<boolean>}
 */
export async function remotePathExists(remotePath, config) {
  if (!remotePath) return false
  const probeCmd = `test -e ${quoteArg(remotePath)} && echo 1 || echo 0`
  const sshArgs = buildSshArgs(config, probeCmd)

  try {
    const { stdout } = await execFileAsync('ssh', sshArgs, {
      maxBuffer: 1024 * 1024,
      timeout: 10000,
      env: { ...process.env, LC_ALL: 'C' },
    })
    return (stdout || '').trim() === '1'
  } catch {
    return false
  }
}
