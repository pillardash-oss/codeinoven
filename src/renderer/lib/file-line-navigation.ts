export interface FileLineSelection {
  line: number
  start: number
  end: number
}

/** Resolve a one-based line request to a clamped text selection. */
export function fileLineSelection(value: string, requestedLine: number): FileLineSelection {
  const targetLine = Math.max(1, Math.floor(requestedLine))
  let line = 1
  let start = 0
  while (line < targetLine) {
    const nextLine = value.indexOf('\n', start)
    if (nextLine === -1) break
    start = nextLine + 1
    line += 1
  }
  const lineBreak = value.indexOf('\n', start)
  return {
    line,
    start,
    end: lineBreak === -1 ? value.length : lineBreak
  }
}
