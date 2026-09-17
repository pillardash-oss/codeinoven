import {
  applyEdits,
  format,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError
} from 'jsonc-parser'

/**
 * Beautifiers for files whose content can be reformatted losslessly. Layout is
 * the only thing that changes: comments, trailing commas, key order, string
 * escaping and line endings all survive, so the user's data is never rewritten.
 * Today that is JSON and JSONC; another format joins by extending the matcher
 * and the formatter below.
 */
const JSON_PATH_PATTERN = /\.(?:json|jsonc)$/iu

const DEFAULT_INDENT_WIDTH = 2
const MAX_INDENT_WIDTH = 8

export type FileBeautifyOutcome =
  /** `text` is the reformatted document, ready to become the editor draft. */
  | { status: 'formatted'; text: string }
  /** The document is already laid out exactly like this; nothing to change. */
  | { status: 'unchanged' }
  /** No beautifier exists for this path. */
  | { status: 'unsupported' }
  /** The document does not parse, so `message` explains where and why. */
  | { status: 'invalid'; message: string }

/**
 * Name of the format this path can be beautified as ("JSON"), or `null` when the
 * editor has no beautifier for it. Callers use the label for both the action
 * text and the decision to offer the action at all.
 */
export function fileBeautifyLabel(path: string): string | null {
  return JSON_PATH_PATTERN.test(path) ? 'JSON' : null
}

/**
 * Reformat a document's layout, leaving everything it says untouched.
 *
 * The content is parsed first so an unparseable document is reported instead of
 * being mangled; whitespace is then re-emitted from the document's own tokens so
 * comments and trailing commas survive. The document's line endings, indentation
 * style and final newline are preserved.
 */
export function beautifyFileContent(path: string, content: string): FileBeautifyOutcome {
  if (fileBeautifyLabel(path) === null) return { status: 'unsupported' }
  // An empty document has nothing to lay out, and the parser's "value expected"
  // would be noise rather than help.
  if (content.trim() === '') return { status: 'unchanged' }
  const errors: ParseError[] = []
  parse(content, errors, { allowTrailingComma: true })
  const firstError = errors[0]
  if (firstError) {
    return { status: 'invalid', message: describeParseError(firstError, content) }
  }
  const formatted = applyEdits(
    content,
    format(content, { offset: 0, length: content.length }, formattingOptions(content))
  )
  return formatted === content ? { status: 'unchanged' } : { status: 'formatted', text: formatted }
}

/** Keep the style the document already reads in; only its layout may change. */
function formattingOptions(content: string): FormattingOptions {
  const indent = detectIndent(content)
  return {
    tabSize: indent.width,
    insertSpaces: indent.spaces,
    eol: content.includes('\r\n') ? '\r\n' : '\n',
    // A document without a final newline keeps it that way: adding or removing
    // one is the author's choice, not a formatting decision.
    insertFinalNewline: /(?:\r\n|\n)$/u.test(content)
  }
}

/**
 * Indentation of the first indented line, which is the document's own style
 * (a minified one-line document has none, so the default applies). A line inside
 * a block comment can win that race, but only when it agrees with the file's
 * indentation anyway.
 */
function detectIndent(content: string): { spaces: boolean; width: number } {
  const match = /^([ \t]+)\S/mu.exec(content)
  const indent = match?.[1]
  if (!indent) return { spaces: true, width: DEFAULT_INDENT_WIDTH }
  if (indent.includes('\t')) return { spaces: false, width: DEFAULT_INDENT_WIDTH }
  return { spaces: true, width: Math.min(Math.max(indent.length, 1), MAX_INDENT_WIDTH) }
}

/** Turns the parser's error code into a sentence for the user, pointing at the
 *  exact position they need to fix. */
function describeParseError(error: ParseError, content: string): string {
  const location = offsetToLineColumn(content, error.offset)
  return `${humanizeParseErrorCode(printParseErrorCode(error.error))} at line ${location.line}, column ${location.column}.`
}

function offsetToLineColumn(content: string, offset: number): { line: number; column: number } {
  const position = Math.max(0, Math.min(offset, content.length))
  const preceding = content.slice(0, position)
  const lastBreak = preceding.lastIndexOf('\n')
  return { line: preceding.split('\n').length, column: position - lastBreak }
}

/** `PropertyNameExpected` reads like a compiler; "property name expected" like
 *  a sentence. */
function humanizeParseErrorCode(code: string): string {
  return code.replace(/(?<=[a-z])(?=[A-Z])/gu, ' ').toLocaleLowerCase()
}
