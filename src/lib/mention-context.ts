function isEscaped(source: string, index: number): boolean {
  let backslashCount = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1
  }
  return backslashCount % 2 === 1
}

function hasOpenDoubleQuote(source: string): boolean {
  let straightQuoteOpen = false
  let curlyQuoteOpen = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"' && !isEscaped(source, index)) straightQuoteOpen = !straightQuoteOpen
    else if (character === '“') curlyQuoteOpen = true
    else if (character === '”') curlyQuoteOpen = false
  }

  return straightQuoteOpen || curlyQuoteOpen
}

/** Whether a mention begins inside a Markdown block quote or open double-quoted passage. */
export function isQuotedMentionPosition(source: string, mentionStart: number): boolean {
  const textBeforeMention = source.slice(0, Math.max(0, mentionStart))
  const currentLinePrefix = textBeforeMention.slice(textBeforeMention.lastIndexOf('\n') + 1)
  return /^\s*>/u.test(currentLinePrefix) || hasOpenDoubleQuote(textBeforeMention)
}

/** Whether a position after `linePrefix` sits inside an unclosed inline code
 *  span — an odd number of unescaped backticks precedes it, so mention and
 *  badge handling must keep the text literal. */
export function isInsideUnclosedInlineCode(linePrefix: string): boolean {
  let backtickCount = 0
  for (let index = 0; index < linePrefix.length; index += 1) {
    if (linePrefix[index] === '`' && !isEscaped(linePrefix, index)) backtickCount += 1
  }
  return backtickCount % 2 === 1
}

/** Whether a double-quoted passage is open at the end of `text` — exported so
 *  rendering can carry quote state across the lines of a paragraph. */
export function isDoubleQuoteOpen(text: string): boolean {
  return hasOpenDoubleQuote(text)
}
