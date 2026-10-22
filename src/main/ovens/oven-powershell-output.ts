/**
 * Making a PowerShell failure readable.
 *
 * When a PowerShell program runs over SSH with its stderr redirected, Windows
 * PowerShell 5.1 serializes its progress, warning and error streams as CLIXML: a
 * `#< CLIXML` line followed by XML objects. The first object is often a `progress`
 * record from a module being loaded ("Preparing modules for first use."), which
 * carries no diagnosis at all, and reporting the raw transport noise hides the one
 * line that says what actually went wrong. Everything here reads that envelope and
 * returns the text a person can act on.
 *
 * This module is free of Electron and of process control so it can be tested on
 * any platform.
 */

/** `_x000D_` and friends are how CLIXML escapes characters it cannot carry. */
function decodeClixmlText(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/gu, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/gu, '&')
}

/**
 * The plain text of a PowerShell stderr transcript.
 *
 * A transcript that is only transport progress becomes empty, which lets the
 * caller fall back to its own classification instead of printing XML at someone.
 * Anything that is not CLIXML is returned untouched.
 */
export function plainPowerShellStderr(stderr: string): string {
  if (!stderr.includes('#< CLIXML')) return stderr
  const errors = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/gu)].map((match) =>
    decodeClixmlText(match[1] ?? '')
  )
  if (errors.length > 0) return errors.join('\n')
  // Warnings can still carry the reason a command refused; progress records do not.
  const warnings = [...stderr.matchAll(/<S S="Warning">([\s\S]*?)<\/S>/gu)].map((match) =>
    decodeClixmlText(match[1] ?? '')
  )
  return warnings.join('\n')
}
