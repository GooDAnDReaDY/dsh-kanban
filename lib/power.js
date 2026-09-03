// dsh-kanban: кроссплатформенный ингибитор сна системы во время работы задач.
// Поддерживает Windows (PowerShell + Win32 API), Linux (systemd-inhibit) и macOS (caffeinate).

import { spawn as defaultSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const WINDOWS_HELPER = [
  '$source = @\'',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class DshExecutionState {',
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  '  public static extern uint SetThreadExecutionState(uint flags);',
  '}',
  '\'@',
  'Add-Type -TypeDefinition $source',
  "$continuous = [Convert]::ToUInt32('80000000', 16)",
  '$systemRequired = [uint32]0x00000001',
  'try {',
  '  $result = [DshExecutionState]::SetThreadExecutionState($continuous -bor $systemRequired)',
  '  if ($result -eq 0) { throw \'SetThreadExecutionState failed\' }',
  '  [Console]::Out.WriteLine(\'READY\')',
  '  [Console]::Out.Flush()',
  '  while ([Console]::In.ReadLine() -ne $null) { }',
  '} finally {',
  '  [void][DshExecutionState]::SetThreadExecutionState($continuous)',
  '}',
].join('\n')

const LINUX_HELPER = "process.stdout.write('READY\\n'); process.stdin.resume();"

const LINUX_INHIBIT_PATHS = ['/usr/bin/systemd-inhibit', '/bin/systemd-inhibit']

export class PowerInhibitor {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform
    this.pid = options.pid ?? process.pid
    this.spawn = options.spawn ?? defaultSpawn
    this.exists = options.exists ?? existsSync
    this.enabled = false
    this.reasons = 0
    this.child = null
    this.phase = 'disabled'
    this.lastError = null
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled)
    this.sync()
  }

  setReasons(count) {
    this.reasons = Math.max(0, Number(count) || 0)
    this.sync()
  }

  acquire() {
    this.reasons++
    this.sync()
  }

  release() {
    this.reasons = Math.max(0, this.reasons - 1)
    this.sync()
  }

  sync() {
    const shouldHold = this.enabled && this.reasons > 0
    if (shouldHold && !this.child) {
      this.startHelper()
    } else if (!shouldHold && this.child) {
      this.stopHelper()
    }
  }

  startHelper() {
    this.stopHelper()
    try {
      if (this.platform === 'win32') {
        const psPath = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        this.child = this.spawn(psPath, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_HELPER], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } else if (this.platform === 'darwin') {
        this.child = this.spawn('/usr/bin/caffeinate', ['-i', '-w', String(this.pid)], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        })
      } else if (this.platform === 'linux') {
        const bin = LINUX_INHIBIT_PATHS.find((p) => this.exists(p))
        if (!bin) {
          this.phase = 'unsupported'
          return
        }
        this.child = this.spawn(
          bin,
          ['--what=idle', '--who=dsh-kanban', '--why=Task running', 'node', '-e', LINUX_HELPER],
          { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        )
      } else {
        this.phase = 'unsupported'
        return
      }

      this.phase = 'running'
      this.lastError = null

      this.child.on('error', (err) => {
        this.lastError = err?.message
        this.phase = 'error'
        this.child = null
      })

      this.child.on('exit', () => {
        this.child = null
        if (this.enabled && this.reasons > 0) {
          this.phase = 'disabled'
        }
      })
    } catch (err) {
      this.lastError = err?.message
      this.phase = 'error'
      this.child = null
    }
  }

  stopHelper() {
    if (this.child) {
      try {
        if (this.child.stdin && !this.child.stdin.destroyed) {
          this.child.stdin.end()
        }
        this.child.kill()
      } catch {}
      this.child = null
    }
    this.phase = 'disabled'
  }

  snapshot() {
    return {
      enabled: this.enabled,
      reasons: this.reasons,
      phase: this.phase,
      lastError: this.lastError,
    }
  }

  destroy() {
    this.enabled = false
    this.reasons = 0
    this.stopHelper()
  }
}
