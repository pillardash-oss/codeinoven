/**
 * Agent work in the machine's temp directory.
 *
 * The app hands every session a scratch folder (`.cio/tmp/<name>/` inside its
 * workspace) and the behavior contract bans the OS temp directory outright:
 * nothing there belongs to the session, nothing there survives a reboot, and a
 * throwaway file the agent leaves behind is a leftover the user has to find.
 * Agents reach for `/tmp` anyway, so the ban is enforced, not just described.
 *
 * Kept dependency-free and self-contained because bundled Pi embeds these two
 * functions in its generated extension (`core-tools-header.ts`), where nothing
 * from this module exists except the function source itself.
 */

/** One reference to a temporary location, as the caller spelled it. */
export interface TempWorkspaceReference {
  /** The value that named it: an absolute path, an environment variable, or a
   *  temp-creating command. */
  reference: string
}

/**
 * The temp-directory references in the text a tool call carries: a command
 * line, a path argument.
 *
 * It never guesses about intent. A string that names a temp root, a temp
 * environment variable, or a temp-creating command is a reference. A path
 * inside the session's own `.cio/tmp` is not, because a temp root there is
 * preceded by a path character (`.cio/tmp` is not `/tmp`).
 */
export function tempWorkspaceReferences(
  texts: readonly (string | undefined)[]
): TempWorkspaceReference[] {
  // Every spelling a command or a tool argument reaches for. `tmpdir()` is not
  // consulted: it is this host's path, not necessarily the one the session runs
  // on (an Oven, a container), and the contract names these roots.
  const roots = ['/private/tmp', '/var/tmp', '/var/folders', '/tmp']
  // Windows spells it two ways a drive path can be told apart from a project
  // folder named "Temp".
  const windowsRoots = [/[\\/]AppData[\\/]Local[\\/]Temp\b/iu, /[\\/]Windows[\\/]Temp\b/iu]
  const envPatterns = [
    /\$\{?(?:TMPDIR|TMP|TEMP|XDG_RUNTIME_DIR)\}?/u,
    /%TMP(?:DIR)?%/iu,
    /%TEMP%/iu
  ]
  const creatorPatterns = [
    /(?:^|[;&|(]\s*|\s)(?:mktemp|tempfile)(?:\s|$)/u,
    /\bos\.tmpdir\s*\(/u,
    /\btempfile\.(?:mkstemp|mkdtemp|TemporaryDirectory|gettempdir)\b/u
  ]
  const found: TempWorkspaceReference[] = []
  const seen = new Set<string>()
  const note = (reference: string): void => {
    if (seen.has(reference)) return
    seen.add(reference)
    found.push({ reference })
  }
  for (const raw of texts) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    for (const root of roots) {
      let index = raw.indexOf(root)
      while (index >= 0) {
        const before = index === 0 ? '' : (raw[index - 1] ?? '')
        const after = raw[index + root.length] ?? ''
        // A root must start a path and end one: `.cio/tmp/attachments` and
        // `https://tmp.example` are not the temp directory, and `/tmpfoo` is a
        // different directory than `/tmp`.
        const startsHere = before === '' || !/[A-Za-z0-9._~/\\]/u.test(before)
        const endsHere = after === '' || after === '/' || !/[A-Za-z0-9._~-]/u.test(after)
        if (startsHere && endsHere) {
          note(root)
          break
        }
        index = raw.indexOf(root, index + 1)
      }
    }
    for (const pattern of windowsRoots) {
      const match = pattern.exec(raw)
      if (match) note(match[0])
    }
    for (const pattern of envPatterns) {
      const match = pattern.exec(raw)
      if (match) note(match[0])
    }
    for (const pattern of creatorPatterns) {
      const match = pattern.exec(raw)
      if (match) note(match[0].trim())
    }
  }
  return found
}

/**
 * The refusal an agent gets in place of a card.
 *
 * It names what it caught and where the work belongs, because a refusal the
 * agent cannot act on just moves the retry to another temp path.
 */
export function tempWorkspaceRefusal(
  references: readonly TempWorkspaceReference[],
  scratchFolder: string
): string {
  const named = references
    .slice(0, 3)
    .map((entry) => `"${entry.reference}"`)
    .join(', ')
  const more = references.length > 3 ? ` (+${references.length - 3} more)` : ''
  return [
    `Refused: this action works in the OS temp directory (${named}${more}), which is banned for agent work.`,
    'The behavior contract bans `os.tmpdir()`, `$TMPDIR`, `$TMP`, `$TEMP`, `%TEMP%`, `$XDG_RUNTIME_DIR`, `mktemp`, `tempfile`, `/tmp`, `/private/tmp`, `/var/tmp` and `/var/folders/...`, in code and in a shell command alike: nothing there belongs to this session, and whatever it leaves behind outlives the step.',
    `Stage disposable files in this session's scratch folder instead: \`${scratchFolder}\`, created with \`mkdir -p\` and cleaned up when the step ends. A tool that insists on a temp directory gets one: point \`TMPDIR\`, \`TEMP\` and \`TMP\` at that folder for its own process.`,
    'If the step genuinely cannot run without the OS temp directory, report that blocker instead of retrying it.'
  ].join(' ')
}
