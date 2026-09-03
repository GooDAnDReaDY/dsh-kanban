// dsh-kanban: фиксация и безопасная передача среза прогресса задачи (PROGRESSDUMP).
// Парсит блок <<<PROGRESSDUMP ... >>>PROGRESSDUMP, маскирует секреты и генерирует вводный бриф.

export const BEGIN_MARKER = '<<<PROGRESSDUMP'
export const END_MARKER = '>>>PROGRESSDUMP'
export const FIELD_BYTE_LIMIT = 8 * 1024
export const REDACTED = '[REDACTED]'

const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._~+\/=:-]{8,}/gi,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /glpat-[A-Za-z0-9_-]{15,}/g,
  /xox[bpars]-[A-Za-z0-9-]{10,}/g,
]

function sanitizeText(raw) {
  let text = raw
  let redacted = false
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      redacted = true
      text = text.replace(pattern, REDACTED)
    }
  }
  // Блокируем внедрение слэш-команд харнесса
  text = text.split('\n')
    .map((line) => (line.trim().startsWith('/') ? ('# ' + line) : line))
    .join('\n')

  return { text, redacted }
}

function truncateBytes(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8')
  if (buf.length <= maxBytes) return str
  return buf.subarray(0, maxBytes).toString('utf8')
}

/**
 * Разобрать блок PROGRESSDUMP из произвольного текста.
 * @param {string} text 
 * @returns {{ ok: true, dump: { goal: string, progress: string, next: string, redacted: boolean } } | { ok: false, error: string }}
 */
export function parseProgressDump(text) {
  if (typeof text !== 'string') return { ok: false, error: 'text-required' }

  const startIdx = text.indexOf(BEGIN_MARKER)
  const endIdx = text.indexOf(END_MARKER)
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { ok: false, error: 'markers-not-found' }
  }

  const inner = text.slice(startIdx + BEGIN_MARKER.length, endIdx).trim()
  const lines = inner.split('\n')

  let currentKey = null
  const sections = { goal: [], progress: [], next: [] }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    const lower = line.toLowerCase()

    if (lower.startsWith('цель:') || lower.startsWith('goal:')) {
      currentKey = 'goal'
      const val = line.slice(line.indexOf(':') + 1).trim()
      if (val) sections.goal.push(val)
    } else if (lower.startsWith('прогресс:') || lower.startsWith('progress:')) {
      currentKey = 'progress'
      const val = line.slice(line.indexOf(':') + 1).trim()
      if (val) sections.progress.push(val)
    } else if (lower.startsWith('следующие шаги:') || lower.startsWith('next:') || lower.startsWith('шаги:')) {
      currentKey = 'next'
      const val = line.slice(line.indexOf(':') + 1).trim()
      if (val) sections.next.push(val)
    } else if (currentKey) {
      sections[currentKey].push(rawLine)
    }
  }

  let totalRedacted = false
  const result = { goal: '', progress: '', next: '', redacted: false }

  for (const key of ['goal', 'progress', 'next']) {
    const rawVal = sections[key].join('\n').trim()
    const { text: cleanText, redacted } = sanitizeText(rawVal)
    if (redacted) totalRedacted = true
    result[key] = truncateBytes(cleanText, FIELD_BYTE_LIMIT)
  }

  result.redacted = totalRedacted
  return { ok: true, dump: result }
}

/**
 * Сериализовать срез в канонический блок <<<PROGRESSDUMP ... >>>PROGRESSDUMP.
 */
export function formatProgressDump(dump) {
  if (!dump) return ''
  return [
    BEGIN_MARKER,
    'Цель:',
    dump.goal || '—',
    '',
    'Прогресс:',
    dump.progress || '—',
    '',
    'Следующие шаги:',
    dump.next || '—',
    END_MARKER,
  ].join('\n')
}

/**
 * Сформировать аккуратный вводный бриф для новой сессии агента.
 */
export function formatHandoverPreamble(dump) {
  if (!dump || (!dump.goal && !dump.progress && !dump.next)) return ''
  return [
    '## 📋 Эстафета задачи (PROGRESSDUMP)',
    '> [!NOTE]',
    '> Предыдущий ход зафиксировал текущее состояние работы:',
    '',
    '**Цель:** ' + (dump.goal || '—'),
    '',
    '**Сделано:** ' + (dump.progress || '—'),
    '',
    '**Следующие шаги:** ' + (dump.next || '—'),
    '',
    '---',
    '',
  ].join('\n')
}
