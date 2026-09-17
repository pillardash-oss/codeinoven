import {
  applyEdits,
  format,
  parseTree,
  printParseErrorCode,
  stripComments,
  type FormattingOptions,
  type Node as JsonNode,
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
const BYTE_ORDER_MARK = '\uFEFF'

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
 * comments and trailing commas survive. The document's own indentation style,
 * line endings and final newline are all preserved, and a document that already
 * reads that way comes back as `unchanged` rather than as a pointless rewrite.
 */
export function beautifyFileContent(path: string, content: string): FileBeautifyOutcome {
  if (fileBeautifyLabel(path) === null) return { status: 'unsupported' }
  // A byte-order mark is not JSON, but it is content: format the document behind
  // it and put it back, so a file written by a Windows tool is not reported as
  // broken.
  const bom = content.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : ''
  const document = bom ? content.slice(bom.length) : content
  // Nothing to lay out in a document that holds no value at all, and the parser's
  // "value expected" would be noise rather than help for comments-only content.
  if (stripComments(document).trim() === '') return { status: 'unchanged' }
  const errors: ParseError[] = []
  const tree = parseTree(document, errors, { allowTrailingComma: true })
  const firstError = errors[0]
  if (firstError) {
    return { status: 'invalid', message: describeParseError(firstError, document) }
  }
  const formatted = applyEdits(
    document,
    format(document, { offset: 0, length: document.length }, formattingOptions(document, tree))
  )
  if (formatted === document) return { status: 'unchanged' }
  return { status: 'formatted', text: `${bom}${formatted}` }
}

/** Keep the style the document already reads in; only its layout may change. */
function formattingOptions(content: string, tree: JsonNode | undefined): FormattingOptions {
  const indent = detectIndent(content, tree)
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
 * Indentation of the document's own first indented value, read from the parse
 * tree so comment continuation lines (indented text, but not code) cannot be
 * mistaken for the file's style. A minified single-line document has no
 * indentation to read, so the default applies.
 */
function detectIndent(
  content: string,
  tree: JsonNode | undefined
): { spaces: boolean; width: number } {
  const offset = tree ? firstIndentedTokenOffset(tree, content) : null
  if (offset === null) return { spaces: true, width: DEFAULT_INDENT_WIDTH }
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1
  const indent = content.slice(lineStart, offset)
  if (indent.includes('\t')) return { spaces: false, width: DEFAULT_INDENT_WIDTH }
  return { spaces: true, width: indent.length }
}

/** Offset of the first token that begins its own line, or `null` when the
 *  document is written as one line (or all its values follow another token). */
function firstIndentedTokenOffset(node: JsonNode, content: string): number | null {
  const lineStart = content.lastIndexOf('\n', node.offset - 1) + 1
  const prefix = content.slice(lineStart, node.offset)
  if (prefix.length > 0 && /^[ \t]+$/u.test(prefix)) return node.offset
  for (const child of node.children ?? []) {
    const offset = firstIndentedTokenOffset(child, content)
    if (offset !== null) return offset
  }
  return null
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
 *  a sentence. Plain `toLowerCase` on purpose: the code is an ASCII identifier,
 *  and a locale-aware variant mangles it (Turkish dotless i). */
function humanizeParseErrorCode(code: string): string {
  return code.replace(/(?<=[a-z])(?=[A-Z])/gu, ' ').toLowerCase()
}
