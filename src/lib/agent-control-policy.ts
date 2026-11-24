/** Shared by local prompts, remote Oven prompts, and utility capability guidance. */
export const BACKGROUND_AGENT_CONTROL_INSTRUCTION = [
  'BACKGROUND-FIRST AGENT CONTROL:',
  'Computer use must go through the app-managed utility or the harness native computer-use tools. Never invoke cua-driver through shell commands, subprocesses, or helper scripts. The app owns the cursor session: reuse it, never generate session names, and never start, end, or reconfigure its lifecycle. If managed computer use is unavailable, report that blocker instead of bypassing it.',
  'For every model or agent interaction with an app, browser, accessibility tree, computer-use driver, or app catalog, try background operation first. Prefer direct APIs, IPC, browser DOM/CDP actions, and window-targeted accessibility or input over desktop input.',
  'Keep the user\'s physical cursor, keyboard focus, foreground window, and selected workspace unchanged whenever background operation can accomplish the task. Open and preview agent browser tabs with attention "background" by default; do not reveal tabs or activate windows just to inspect them.',
  'Foreground control remains available. If background interaction fails or the tool reports that the action requires foreground control, use the foreground route for that action within the existing permission tier. Read back the result before retrying an action that may already have taken effect. Do not add a separate permission question solely for foreground fallback.',
  'When a UI action has no background equivalent, prefer an available data/API operation first; use the UI action when visible interaction is necessary. Return to background operation for subsequent actions that support it.',
  'The user interacting with the target app, showing the agent tab, or moving that tab to another browser box does not automatically pause or cancel the agent. Respect the current target and browser box, refresh observations when needed, and decide whether to continue or wait based on the task.',
  'Keep activity visible through the existing agent cursor, PiP, and thread indicators without activating the target solely to show activity.'
].join(' ')

/**
 * The session flag that says this thread's in-app browser cannot serve it.
 *
 * Set by the app, never by the agent: an Oven thread is always marked, because
 * the browser tab in front of the user shows this machine while the work runs
 * on the Oven, so a headless browser over there is the only way to see the page.
 */
export const THREAD_BROWSER_ENV = 'CIO_THREAD_BROWSER'
/** The value of {@link THREAD_BROWSER_ENV} for a thread without a usable browser. */
export const THREAD_BROWSER_UNAVAILABLE = 'unavailable'

/** A routing guard, independent of permission tier. Kept self-contained so Pi
 * can embed the same implementation in its generated extension. */
export function unmanagedCuaShellReason(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (!['bash', 'powershell', 'cmd'].includes(toolName)) return null
  const command = typeof input['command'] === 'string' ? input['command'] : ''
  const direct = /\bcua-driver(?:\.exe)?["'`]*(?:\s+|\s*,\s*["'`]*)(?:call|mcp|serve|cursor)\b/iu
  // Also cover interpreter scripts that assign the executable to a variable
  // before passing it to a subprocess, as the affected thread's helper did.
  const subprocess =
    /\bcua-driver(?:\.exe)?\b/iu.test(command) &&
    /\b(?:subprocess\.(?:run|Popen|call|check_call|check_output)|spawn|execFile|execSync)\s*\(/u.test(
      command
    ) &&
    /["'](?:call|mcp|serve|cursor)["']/u.test(command)
  if (!direct.test(command) && !subprocess) return null
  return 'Not executed: direct cua-driver automation bypasses the app-owned cursor session and cleanup. Use the app-managed computer-use utility or native computer-use tools. Reuse its session; do not create helper scripts or random session names. If unavailable, report the blocker.'
}

/**
 * The process-lifecycle rule every agent surface obeys: no shell command may
 * stop a process, in any form.
 *
 * A server belongs to whoever started it, and the user runs servers (dev
 * servers most of all) outside the app. Passing a pid proves nothing: an agent
 * that read a pid from `lsof -ti:5173` in an earlier call can pass that pid
 * literally, so a numeric-only allowance still lets it take down another
 * project's server. Shell one-liners, interpreters and child scripts hide the
 * same kill behind different syntax, and a name, port or pattern can only ever
 * discover its target at run time. So this refuses the whole family and points
 * at the app-owned path instead: `cio_process_list` shows the processes this
 * session started and `cio_process_stop` stops one of those by pid, with
 * ownership rechecked in main. It is a block, never a permission card, so Full
 * Access cannot approve it, and it is a parser rather than a keyword search so
 * a quoted search pattern (`rg "kill|pkill"`) still runs.
 *
 * Kept self-contained so Pi embeds the same implementation in its generated
 * extension.
 */
export function unmanagedProcessKillReason(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (!['bash', 'powershell', 'cmd'].includes(toolName)) return null
  const command = typeof input['command'] === 'string' ? input['command'] : ''
  if (!command.trim()) return null

  const refused =
    'Not executed: stopping a process from a shell command is refused in every form (by pid, port, name, signal or pattern, or by an interpreter, a script, or a nested shell that does it), because the command cannot prove it started that process and another project or the user may own it. CodeInOven owns process lifecycle: a process this session started is stopped by pid through the app with cio_process_stop, after listing your own with cio_process_list, and anything else is left running. If a port is busy, start your own server on another port. If a process must go, report it instead of guessing.'

  /** Programs that terminate a process. `kill.exe` and friends reduce to these. */
  const stopPrograms = new Set([
    'kill',
    'pkill',
    'killall',
    'killall5',
    'xkill',
    'skill',
    'tskill',
    'taskkill',
    'stop-process',
    // Third-party port killers, which are the same act with a package name.
    'kill-port',
    'kill-port-cli',
    'killport',
    'fkill'
  ])
  /** Programs that run code handed to them as arguments, files or stdin. */
  const executors = new Set([
    'bash',
    'sh',
    'zsh',
    'dash',
    'ksh',
    'fish',
    'node',
    'bun',
    'deno',
    'python',
    'python2',
    'python3',
    'ruby',
    'perl',
    'php',
    'pwsh',
    'powershell',
    'awk',
    'gawk',
    'mawk',
    'nawk',
    'osascript',
    'lua'
  ])
  /** Prefix programs that execute whatever follows them. */
  const wrappers = new Set([
    'sudo',
    'doas',
    'env',
    'nohup',
    'exec',
    'command',
    'builtin',
    'setsid',
    'time',
    'nice',
    'ionice',
    'stdbuf',
    'xargs',
    'busybox',
    'caffeinate',
    'unbuffer',
    'timeout',
    'bunx',
    'npx',
    'pnpx'
  ])
  /** Wrapper flags that consume the token after them. */
  const valueFlags = new Set([
    '-u',
    '-g',
    '-p',
    '-c',
    '-n',
    '-i',
    '-r',
    '-t',
    '-U',
    '-C',
    '-h',
    '-I',
    '-P',
    '-L',
    '-d',
    '-a',
    '-E',
    '-s',
    '-o',
    '-e'
  ])
  /** Process-termination APIs inside inline code or a script body. */
  const killApi =
    /(?:\.kill\s*\(|\bprocess\.kill\b|\bos\.kill\b|\bchild\.kill\b|\bsubprocess\.(?:kill|terminate|call|run|Popen)\b|\bproc\.kill\b|\bSIGKILL\b|\bSIGTERM\b|\btaskkill\b|\bStop-Process\b)/iu
  /** A kill written as shell in a script body. */
  const killScript =
    /(?:\b(?:pkill|killall5|killall|xkill|taskkill|tskill|skill)\b|\b(?:kill|fuser)\b[^\n]*\s-[a-z]*k|(?:^|[\s;&|({])kill[ \t]+[^\s;]|\.kill\s*\(|\b(?:process|os|child|subprocess|proc)\.kill\b|\bStop-Process\b)/imu
  /** Files an agent wrote for itself are the one place a hidden kill hides. */
  const scratchPath =
    /(?:^|\/)\.cio\/(?:tmp|work|specs)\/|^\/(?:tmp|private\/tmp|var\/folders|private\/var\/folders)\//u

  const programName = (word: string): string => {
    const cleaned = word.replace(/^["']+|["']+$/gu, '')
    const parts = cleaned.split(/[\\/]/u)
    const last = parts[parts.length - 1] ?? cleaned
    return last.replace(/\.exe$/iu, '').toLowerCase()
  }

  /** Read a scratch script the command is about to run, so its body is vetted. */
  const readScratchScript = (path: string): string | null => {
    if (
      !scratchPath.test(path) ||
      !/\.[cm]?[jt]sx?$|\.(?:sh|bash|zsh|py|rb|pl|php|ps1)$/iu.test(path)
    ) {
      return null
    }
    const moduleProcess = (
      globalThis as {
        process?: { getBuiltinModule?: (specifier: string) => unknown; cwd?: () => string }
      }
    ).process
    const fsModule = moduleProcess?.getBuiltinModule?.('node:fs')
    const readFileSync = (
      fsModule as { readFileSync?: (target: string, encoding: string) => string } | undefined
    )?.readFileSync
    if (!readFileSync) return null
    const candidates = [path, `${moduleProcess?.cwd?.() ?? '.'}/${path}`]
    for (const candidate of candidates) {
      try {
        return String(readFileSync.call(fsModule, candidate, 'utf8')).slice(0, 200_000)
      } catch {
        // A path this process cannot read cannot be executed by it either.
      }
    }
    return null
  }

  /** Split a command into simple commands, honouring quotes, escapes and substitutions. */
  const tokenize = (text: string): { commands: string[][]; nested: string[] } => {
    const commands: string[][] = []
    const nested: string[] = []
    let words: string[] = []
    let word = ''
    let open = false
    let quote = ''
    const finishWord = (): void => {
      if (!open) return
      words.push(word)
      word = ''
      open = false
    }
    const finishCommand = (): void => {
      finishWord()
      if (words.length > 0) {
        commands.push(words)
        words = []
      }
    }
    for (let index = 0; index < text.length; index++) {
      const character = text.charAt(index)
      if (quote) {
        if (character === quote) {
          quote = ''
          open = true
          continue
        }
        if (quote === '"' && character === '\\') {
          word += text.charAt(index + 1)
          index++
          open = true
          continue
        }
        word += character
        open = true
        continue
      }
      if (character === "'" || character === '"') {
        quote = character
        open = true
        continue
      }
      if (character === '\\') {
        word += text.charAt(index + 1)
        index++
        open = true
        continue
      }
      if (character === '`') {
        const close = text.indexOf('`', index + 1)
        if (close > index) {
          nested.push(text.slice(index + 1, close))
          index = close
        }
        open = true
        continue
      }
      if (character === '$' && text.charAt(index + 1) === '(') {
        let depth = 0
        let cursor = index + 1
        for (; cursor < text.length; cursor++) {
          const inner = text.charAt(cursor)
          if (inner === '(') depth++
          else if (inner === ')') {
            depth--
            if (depth === 0) break
          }
        }
        nested.push(text.slice(index + 2, cursor))
        index = cursor
        open = true
        continue
      }
      if (character === '#' && !open) {
        const newline = text.indexOf('\n', index)
        if (newline < 0) break
        index = newline - 1
        continue
      }
      if (
        character === '\n' ||
        character === ';' ||
        character === '&' ||
        character === '|' ||
        character === '(' ||
        character === ')'
      ) {
        finishCommand()
        continue
      }
      if (character === ' ' || character === '\t' || character === '\r') {
        finishWord()
        continue
      }
      word += character
      open = true
    }
    finishCommand()
    return { commands, nested }
  }

  /** One simple command, minus wrappers, checked for any way to stop a process. */
  const inspectWords = (words: string[], depth: number): string | null => {
    if (words.length === 0) return null
    let cursor = 0
    while (cursor < words.length) {
      const name = programName(words[cursor] ?? '')
      if (!wrappers.has(name)) break
      cursor++
      while (cursor < words.length) {
        const word = words[cursor] ?? ''
        if (name === 'env' && /^[A-Za-z_]\w*=/u.test(word)) {
          cursor++
          continue
        }
        // `timeout 10 cmd` and `busybox kill` pass the program as the next word.
        if (name === 'timeout' || name === 'busybox') {
          cursor++
          break
        }
        if (word.startsWith('-')) {
          cursor += valueFlags.has(word.slice(0, 2)) && !word.includes('=') ? 2 : 1
          continue
        }
        break
      }
    }
    const head = programName(words[cursor] ?? '')
    const rest = words.slice(cursor + 1)
    if (stopPrograms.has(head)) {
      // `kill -l` lists signals and `kill -0` probes a pid; neither stops anything.
      if (
        head === 'kill' &&
        rest.some((word) => /^-(?:l|L|0)$/u.test(word) || /^--(?:list|signal=0)$/u.test(word))
      ) {
        return null
      }
      return refused
    }
    // `fuser` only stops a process with its kill flag; without it, it reports.
    if (head === 'fuser' && rest.some((word) => /^-[a-zA-Z]*k/u.test(word))) return refused
    // A wrapper may carry a value flag whose value is itself the program.
    if (cursor > 0 && rest.some((word) => stopPrograms.has(programName(word)))) return refused
    const execAt = words.findIndex((word) => /^-(?:exec|execdir|ok|okdir)$/u.test(word))
    if (execAt >= 0 && inspectWords(words.slice(execAt + 1), depth + 1)) return refused
    if (!executors.has(head)) return null
    for (const word of rest) {
      const source = readScratchScript(word)
      if (source && killScript.test(source)) return refused
      if (killApi.test(word)) return refused
      if (/\b(?:kill|pkill|killall|taskkill|Stop-Process)\b/u.test(word) && /[\s;&|]/u.test(word)) {
        if (inspectScript(word, depth + 1)) return refused
      }
    }
    return null
  }

  /** A whole script: heredoc bodies first, then every simple command in it. */
  function inspectScript(script: string, depth: number): string | null {
    if (depth > 4) return refused
    const lines = script.split('\n')
    const kept: string[] = []
    const bodies: { head: string; body: string }[] = []
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      kept.push(line)
      const opener = /<<(?!<)-?[ \t]*(['"]?)([A-Za-z_][\w.-]*)\1/u.exec(line)
      const delimiter = opener?.[2] ?? ''
      if (!delimiter) continue
      let cursor = index + 1
      const body: string[] = []
      for (; cursor < lines.length; cursor++) {
        const current = lines[cursor] ?? ''
        if (current.trim() === delimiter) break
        body.push(current)
      }
      if (cursor >= lines.length) continue
      bodies.push({ head: line, body: body.join('\n') })
      index = cursor
    }
    for (const entry of bodies) {
      const headWords = tokenize(entry.head).commands[0] ?? []
      const headName = programName(headWords[0] ?? '')
      if (!executors.has(headName)) continue
      if (killApi.test(entry.body)) return refused
      if (inspectScript(entry.body, depth + 1)) return refused
    }
    const parsed = tokenize(kept.join('\n'))
    for (const nested of parsed.nested) {
      if (inspectScript(nested, depth + 1)) return refused
    }
    for (const words of parsed.commands) {
      if (inspectWords(words, depth)) return refused
    }
    return null
  }

  return inspectScript(command, 0)
}

/**
 * The browser rule every agent surface obeys: no shell command may launch a
 * browser of its own.
 *
 * The in-app browser is the only browser an agent has, because it is the only
 * one that shows the page the app actually serves, in the tab the user can see,
 * with the session, extensions and permissions the app already prepared. A
 * chromium, Playwright, Puppeteer or WebKit the agent downloads and launches
 * proves nothing about that tab and can reach a page the app never served.
 *
 * The prompt forbade it and agents substituted anyway: they hunted a
 * Playwright cache for a downloaded "Google Chrome for Testing" binary, ran
 * `--headless` screenshots, and opened remote-debugging ports. A prohibition
 * that only exists in words has already lost twice, so this is a block like the
 * process-kill and cua-driver guards beside it: never a permission card, so no
 * permission tier can approve it. It is a parser rather than a keyword search,
 * so `rg "playwright"` still runs, and quoted text is only read when it is code
 * an executor was handed.
 *
 * Kept self-contained so Pi embeds the same implementation in its generated
 * extension.
 *
 * The rule is not absolute, and the one exception is the app's call, not the
 * agent's: a thread whose browser cannot serve it may use a headless browser.
 * That is an Oven thread (the browser tab shows this machine, never the Oven's
 * checkout) and any thread the app marks unavailable. The app decides before
 * the command runs, through `options.threadBrowserAvailable` or the
 * `CIO_THREAD_BROWSER=unavailable` flag it sets for the session, so an agent can
 * never grant itself the exception by arguing for it.
 */
export function unmanagedBrowserShellReason(
  toolName: string,
  input: Record<string, unknown>,
  options?: { threadBrowserAvailable?: boolean }
): string | null {
  if (!['bash', 'powershell', 'cmd'].includes(toolName)) return null
  const command = typeof input['command'] === 'string' ? input['command'] : ''
  if (!command.trim()) return null
  // The app decides whether the thread browser can serve this thread. An Oven
  // thread is always unavailable, because the tab in front of the user is this
  // machine's, and a headless browser over there is the only option left.
  const marked = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.['CIO_THREAD_BROWSER']
  const threadBrowserAvailable = options?.threadBrowserAvailable ?? marked !== 'unavailable'
  if (!threadBrowserAvailable) return null

  const refused =
    'Not executed: launching your own browser is refused while this thread has its in-app browser, which is the only browser that shows the page the app is serving, in the tab the user can watch. Use it first: find it with cio_util_find (query "browser"), activate it with cio_util_init, and drive the page with its operations   open a tab, navigate, read the console, click, type, and take a screenshot. Only when that browser genuinely cannot serve this thread may you fall back to a headless browser, and the app allows the fallback itself (an Oven thread, where the browser tab belongs to this machine, is already allowed). When you are refused here, that means the app has not marked this thread unavailable: use the in-app browser, or say what it could not do and report the check you could not run. A binary that happens to be on disk is not permission to use it.'

  /** Programs that are a browser, or a launcher that drives one. */
  const browserPrograms = new Set([
    'playwright',
    'playwright-core',
    'puppeteer',
    'chrome',
    'chrome.exe',
    'google-chrome',
    'google-chrome-stable',
    'google-chrome-beta',
    'google-chrome-unstable',
    'chromium',
    'chromium-browser',
    'chrome-headless-shell',
    'headless-shell',
    'headless_shell',
    'msedge',
    'msedge.exe',
    'microsoft-edge',
    'microsoft-edge-stable',
    // The macOS app bundle hands the binary's human name to the shell, so a
    // launch from /Applications has to match on the name as well as the path.
    'google chrome',
    'chrome for testing',
    'google chrome for testing',
    'microsoft edge',
    'chromium headless shell',
    'firefox',
    'firefox.exe',
    'webkit',
    'geckodriver',
    'chromedriver',
    'safaridriver',
    'selenium-side-runner'
  ])
  /** Package runners that can reach a browser package without naming a binary. */
  const packageRunners = new Set([
    'npx',
    'bunx',
    'pnpm',
    'yarn',
    'npm',
    'bun',
    'node',
    'deno',
    'tsx',
    'python',
    'python2',
    'python3',
    'ruby',
    'sh',
    'bash',
    'zsh',
    'pwsh',
    'powershell'
  ])
  /** Browser packages and cache paths, which name the act without naming it. */
  const browserEvidence =
    /(?:^|[\s/\\'"])(?:@playwright\/test|playwright-core|playwright|puppeteer-core|puppeteer)(?:$|[\s/\\'"]|@)|ms-playwright|chrome-headless-shell|google chrome for testing|\.local-chromium|chromium-\d+/iu
  /** Flags that only ever belong to a browser being driven from a shell. */
  const browserFlags =
    /^(?:--headless(?:=\w+)?|--headless-new|--remote-debugging-port(?:=\d+)?|--remote-debugging-pipe|--dump-dom|--print-to-pdf(?:=.*)?|--screenshot(?:=.*)?|--user-data-dir(?:=.*)?|--virtual-time-budget(?:=\d+)?|--window-size(?:=\d+,\d+)?|--disable-gpu|--no-sandbox|--single-process)$/iu
  /** Code an executor was handed, which is the one place a launch hides. */
  const browserApi =
    /\b(?:chromium|chrome|firefox|webkit|puppeteer)\s*\.\s*launch\b|\b(?:playwright)\s*\.\s*(?:chromium|firefox|webkit)\b|\blaunch_persistent_context\b|\bpuppeteer\.launch\b|\brequire\(\s*['"](?:puppeteer|playwright|playwright-core)|\bfrom\s+['"]?(?:puppeteer|playwright|playwright-core)|\bconnect_over_cdp\b|\bremote-debugging-port\b/iu

  /** A browser bundle or cache path, which tokenising would split on its spaces. */
  const browserPath =
    /(?:\.app\/Contents\/MacOS\/|\/ms-playwright\/|\.local-chromium[\\/]|\/chrome-linux\/chrome\b|\/chrome-headless-shell\b|Google Chrome for Testing\b)/iu

  const programName = (word: string): string => {
    const cleaned = word.replace(/^["']+|["']+$/gu, '')
    const parts = cleaned.split(/[\\/]/u)
    const last = parts[parts.length - 1] ?? cleaned
    return last.replace(/\.(?:exe|cmd|bat|ps1)$/iu, '').toLowerCase()
  }

  /** Reading about a browser bundle is not launching it. */
  const readOnlyPrograms =
    /(?:^|[\s;&|])(?:rg|grep|ag|ack|git|ls|cat|find|head|tail|wc|stat|file|readlink|realpath)\b/u
  if (browserPath.test(command) && !readOnlyPrograms.test(command)) return refused

  /** Split a command into words, remembering whether a word was quoted. */
  const tokenize = (text: string): { words: string[]; quoted: boolean[] }[] => {
    const commands: { words: string[]; quoted: boolean[] }[] = []
    let words: string[] = []
    let quoted: boolean[] = []
    let word = ''
    let open = false
    let quote: string | null = null
    let wasQuoted = false
    const finishWord = (): void => {
      if (!open) return
      words.push(word)
      quoted.push(wasQuoted)
      word = ''
      open = false
      wasQuoted = false
    }
    const finishCommand = (): void => {
      finishWord()
      if (words.length > 0) commands.push({ words, quoted })
      words = []
      quoted = []
    }
    let escaped = false
    for (const character of text) {
      if (escaped) {
        word += character
        open = true
        escaped = false
        continue
      }
      if (character === '\\' && quote !== "'") {
        escaped = true
        continue
      }
      if (quote) {
        if (character === quote) quote = null
        else word += character
        open = true
        continue
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character
        open = true
        wasQuoted = true
        continue
      }
      if (
        character === '\n' ||
        character === ';' ||
        character === '&' ||
        character === '|' ||
        character === '(' ||
        character === ')'
      ) {
        finishCommand()
        continue
      }
      if (character === ' ' || character === '\t' || character === '\r') {
        finishWord()
        continue
      }
      word += character
      open = true
    }
    finishCommand()
    return commands
  }

  /** A file an executor was handed, read only when it is a real path. */
  const readScript = (candidate: string): string | null => {
    if (!candidate || /^[|&;<>]+$/u.test(candidate)) return null
    if (!/\.(?:[cm]?[jt]sx?|py|rb|pl|php|ps1)$/iu.test(candidate)) return null
    const moduleProcess = (
      globalThis as {
        process?: { getBuiltinModule?: (specifier: string) => unknown; cwd?: () => string }
      }
    ).process
    const fsModule = moduleProcess?.getBuiltinModule?.('node:fs')
    const readFileSync = (
      fsModule as { readFileSync?: (target: string, encoding: string) => string } | undefined
    )?.readFileSync
    if (!readFileSync) return null
    const cwd = moduleProcess?.cwd?.() ?? '.'
    const candidates = [candidate, `${cwd}/${candidate}`, `${cwd}\\${candidate}`]
    for (const path of candidates) {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        continue
      }
    }
    return null
  }

  for (const segment of tokenize(command)) {
    const { words, quoted } = segment
    let cursor = 0
    while (cursor < words.length && /^[A-Za-z_]\w*=/u.test(words[cursor] ?? '')) cursor++
    const wrappers = new Set([
      'env',
      'sudo',
      'doas',
      'nohup',
      'command',
      'exec',
      'nice',
      'time',
      'timeout'
    ])
    while (cursor < words.length && wrappers.has(programName(words[cursor] ?? ''))) {
      const name = programName(words[cursor] ?? '')
      cursor++
      while (cursor < words.length) {
        const word = words[cursor] ?? ''
        if (name === 'env' && /^[A-Za-z_]\w*=/u.test(word)) {
          cursor++
          continue
        }
        if (name === 'timeout') {
          cursor++
          break
        }
        if (word.startsWith('-')) {
          cursor++
          continue
        }
        break
      }
    }
    const head = programName(words[cursor] ?? '')
    const rest = words.slice(cursor + 1)
    const restQuoted = quoted.slice(cursor + 1)
    // A search reads text about browsers; it never drives one. `rg "playwright"`
    // and `grep -rn chromium.launch src` stay allowed, which is why this is a
    // parser and not a keyword search.
    if (head === 'rg' || head === 'grep' || head === 'ag' || head === 'ack' || head === 'git') {
      continue
    }

    // A flag no other program takes: a headless run, a debugging port, a dump.
    if (rest.some((word) => browserFlags.test(word))) return refused
    // The browser itself, or a launcher that only exists to drive one.
    if (browserPrograms.has(head)) return refused
    // A macOS launch of an installed browser: `open -a "Google Chrome"`.
    if (head === 'open') {
      const appAt = rest.findIndex((word) => /^-(?:a|na|b)$/u.test(word))
      const target = appAt >= 0 ? (rest[appAt + 1] ?? '') : ''
      if (browserPrograms.has(programName(target))) return refused
      if (/chrome|chromium|firefox|playwright|puppeteer|webkit|edge/iu.test(target)) return refused
    }
    // A package runner reaching a browser package: npx playwright, bunx puppeteer.
    if (packageRunners.has(head) || head === '') {
      for (let index = 0; index < rest.length; index++) {
        const word = rest[index] ?? ''
        const isQuoted = restQuoted[index] === true
        if (browserEvidence.test(word)) return refused
        if (browserPrograms.has(programName(word))) return refused
        // Inline code handed to an interpreter.
        if (isQuoted && browserApi.test(word)) return refused
        const source = readScript(word)
        if (source && browserApi.test(source)) return refused
      }
    }
    // Shell text that is itself a whole command, quoted or in a heredoc. Only an
    // executor runs its argument; `echo "chromium --headless"` writes a string
    // and must keep working, which is why this is not a keyword search.
    const executors = new Set([
      'bash',
      'sh',
      'zsh',
      'dash',
      'ksh',
      'fish',
      'cmd',
      'pwsh',
      'powershell',
      'node',
      'bun',
      'deno',
      'tsx',
      'python',
      'python2',
      'python3',
      'ruby',
      'perl',
      'php',
      'source'
    ])
    if (executors.has(head)) {
      for (let index = 0; index < rest.length; index++) {
        const word = rest[index] ?? ''
        const isQuoted = restQuoted[index] === true
        const source = readScript(word)
        if (source && browserApi.test(source)) return refused
        if (!isQuoted) continue
        if (browserApi.test(word)) return refused
        if (!/[\s;&|]/u.test(word)) continue
        const nested = unmanagedBrowserShellReason(toolName, { command: word })
        if (nested) return refused
      }
    }
  }
  return null
}
