import { basename } from 'path'

/**
 * Shell families an action script can land in.
 *
 * `fish` is separate because its syntax is not POSIX: `set -e` there means
 * "erase this variable", so prepending a fail-fast line would break the script
 * instead of guarding it.
 */
export type ActionShellFamily = 'posix' | 'fish' | 'powershell' | 'cmd'

/** The family one shell binary belongs to, decided from its file name. */
export function actionShellFamily(shell: string): ActionShellFamily {
  const name = basename(shell)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/u, '')
  if (name === 'cmd') return 'cmd'
  if (name === 'powershell' || name === 'pwsh') return 'powershell'
  if (name === 'fish') return 'fish'
  return 'posix'
}

/** POSIX shells abort a multi-line `-c` script on the first failing command. */
const POSIX_GUARD = 'set -e'

/**
 * PowerShell aborts on a failing cmdlet, and on 7.3+ on a failing native
 * program, which is what an action's `bun`/`git` lines are. The `Get-Variable`
 * probe keeps the second line quiet on Windows PowerShell 5.1, where that
 * preference does not exist.
 */
const POWERSHELL_GUARD = [
  "$ErrorActionPreference = 'Stop'",
  'if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) { $PSNativeCommandUseErrorActionPreference = $true }'
].join('\n')

/**
 * Make an action script stop at the first command that fails.
 *
 * A plain shell runs every line of a multi-line `-c` script even when one of
 * them failed, so an action like
 *
 *     cd packages/convex-backend
 *     bun run deploy -y
 *     bun run dev --once
 *
 * kept running its remaining steps after a failure. That is never what an
 * action means: a deploy that failed must not be followed by a dev server
 * launched against half-published code.
 *
 * An explicit `set +e` in the script still turns the guard back off, which is
 * the escape hatch for a step that is allowed to fail.
 */
export function failFastActionScript(script: string, family: ActionShellFamily): string {
  if (!script.trim()) return script
  switch (family) {
    case 'posix': {
      const normalized = script.replace(/\r\n?/gu, '\n')
      return posixGuardApplied(normalized) ? normalized : `${POSIX_GUARD}\n${normalized}`
    }
    case 'powershell':
      return powershellGuardApplied(script) ? script : `${POWERSHELL_GUARD}\n${script}`
    case 'cmd':
      return cmdFailFastScript(script)
    case 'fish':
      // Fish has no guard that keeps the script's own lines untouched.
      return script
  }
}

/** Whether the script already turns POSIX fail-fast on itself. */
function posixGuardApplied(script: string): boolean {
  for (const line of script.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    return /^set\s+-[a-z]*e/iu.test(trimmed)
  }
  return false
}

/** Whether the script already raises PowerShell errors to terminating ones. */
function powershellGuardApplied(script: string): boolean {
  for (const line of script.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    return /\$ErrorActionPreference\s*=\s*['"]Stop['"]/iu.test(trimmed)
  }
  return false
}

/**
 * `cmd.exe` has no fail-fast setting, so its lines are chained with `&&`.
 *
 * Blank lines, `REM` comments and `::` labels are dropped: a comment inside a
 * `&&` chain of its own would run `&&` against a command that produced no
 * status.
 */
function cmdFailFastScript(script: string): string {
  const commands = script
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^@?(?:rem\b|::)/iu.test(line))
  if (commands.length === 0) return script
  if (commands.length === 1) return commands[0] as string
  return commands.join(' && ')
}
