// Разбор тела задачи в дерево узлов.
//
// Тело приходит из Gitea и пишет его кто угодно. Поэтому разбор отдаёт ДЕРЕВО,
// а не строку HTML: браузерная половина собирает его элементами React, и
// подстановка чужой разметки становится невозможной по построению, а не по
// бдительности того, кто вспомнит про экранирование.
//
// Полноценный markdown здесь не нужен и не будет: заголовки, списки, выделение,
// код и ссылки покрывают почти всякое тело issue. Всё непонятое остаётся
// текстом как есть — это честнее, чем угадывать.

/** Ссылки открываем только по этим схемам: `javascript:` в теле — тот же обход. */
const SAFE_LINK = /^https?:\/\//i

/**
 * Разобрать тело в список блоков.
 *
 * @returns {Array<object>} блоки вида
 *   `{kind:'heading', level, spans}`, `{kind:'para', spans}`,
 *   `{kind:'list', ordered, items:[spans]}`, `{kind:'code', text}`,
 *   `{kind:'quote', spans}`, `{kind:'rule'}`
 */
export function parseBody(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') { i += 1; continue }

    // Блок кода: всё внутри дословно, включая то, что похоже на разметку.
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence !== null) {
      const body = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i += 1 }
      i += 1
      blocks.push({ kind: 'code', lang: fence[1].trim(), text: body.join('\n') })
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ kind: 'rule' }); i += 1; continue }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1].length, spans: parseSpans(heading[2]) })
      i += 1
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push({ kind: 'quote', spans: parseSpans(body.join(' ')) })
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet !== null || numbered !== null) {
      const ordered = numbered !== null
      const items = []
      while (i < lines.length) {
        const m = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
          : /^\s*[-*+]\s+(.*)$/.exec(lines[i])
        if (m === null) break
        items.push(parseSpans(m[1]))
        i += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // Абзац: строки до пустой склеиваются, как это делает markdown.
    const body = []
    while (i < lines.length && lines[i].trim() !== ''
      && !/^\s*(#{1,6})\s+/.test(lines[i])
      && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+[.)]\s+/.test(lines[i])
      && !/^\s*```/.test(lines[i])
      && !/^\s*>\s?/.test(lines[i])) {
      body.push(lines[i])
      i += 1
    }
    blocks.push({ kind: 'para', spans: parseSpans(body.join(' ')) })
  }

  return blocks
}

/**
 * Разобрать строку на куски: обычный текст, код, выделение, ссылка.
 *
 * @returns {Array<{kind: 'text'|'code'|'strong'|'em'|'link', text: string, href?: string}>}
 */
export function parseSpans(text) {
  const out = []
  const src = String(text ?? '')
  // Код первым: внутри обратных кавычек разметки нет, там всё дословно.
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/g
  let at = 0
  let m = re.exec(src)

  while (m !== null) {
    if (m.index > at) out.push({ kind: 'text', text: src.slice(at, m.index) })
    const piece = m[0]

    if (piece.startsWith('`')) {
      out.push({ kind: 'code', text: piece.slice(1, -1) })
    } else if (piece.startsWith('[')) {
      const cut = piece.indexOf('](')
      const label = piece.slice(1, cut)
      const href = piece.slice(cut + 2, -1)
      // Небезопасная схема — не ссылка, а текст. Молча выбрасывать нельзя:
      // человек должен видеть, что там было написано.
      if (SAFE_LINK.test(href)) out.push({ kind: 'link', text: label, href })
      else out.push({ kind: 'text', text: piece })
    } else if (piece.startsWith('**') || piece.startsWith('__')) {
      out.push({ kind: 'strong', text: piece.slice(2, -2) })
    } else {
      out.push({ kind: 'em', text: piece.slice(1, -1) })
    }

    at = m.index + piece.length
    m = re.exec(src)
  }

  if (at < src.length) out.push({ kind: 'text', text: src.slice(at) })
  return mergeText(out)
}

/**
 * Склеить соседние куски текста.
 *
 * Разбор дробит строку там, где нашёл разметку и передумал: `[клик](javascript:…)`
 * не стал ссылкой, но оставил после себя два куска. Дробление наружу не
 * выпускаем — оно не значит ничего, а читателю мешает.
 */
function mergeText(spans) {
  const out = []
  for (const span of spans) {
    const last = out[out.length - 1]
    if (span.kind === 'text' && last !== undefined && last.kind === 'text') {
      last.text += span.text
      continue
    }
    out.push(span)
  }
  return out
}

/** Безопасна ли ссылка. Наружу — чтобы браузерная половина не решала это заново. */
export function isSafeHref(href) {
  return SAFE_LINK.test(String(href ?? ''))
}
