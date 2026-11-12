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
 * The one process kill this app allows, and everything it refuses.
 *
 * A server belongs to whoever started it, and the user runs servers (dev
 * servers most of all) outside the app. An agent that frees a port with
 * `lsof -ti:5173 | xargs kill`, `pkill -f vite` or `killall node` reliably
 * kills servers it never started, including the user's, so those commands are
 * refused outright: they discover their target at run time and can never prove
 * ownership. Only a literal pid can, so the agent must pass the pid it captured
 * when it started that process itself.
 *
 * Kept self-contained so Pi embeds the same implementation in its generated
 * extension, and returned as a reason rather than a permission card so Full
 * Access cannot auto-approve it.
 */
export function unmanagedProcessKillReason(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (!['bash', 'powershell', 'cmd'].includes(toolName)) return null
  const command = typeof input['command'] === 'string' ? input['command'] : ''
  if (!command.trim()) return null
  const refused =
    'Not executed: this command stops a process by name, by port, by pattern, or by a pid it looks up at run time, so it can hit a server or process this session never started. Kill only a pid you captured yourself when you started that process, for example "kill 48213". If you did not capture a pid, leave the process running and report it, and if a port is busy start your own server on another port instead of freeing it.'
  // Name-, pattern- and port-matching killers: pkill, killall, xkill, and
  // fuser's kill flag, which resolves whatever holds a port.
  if (/\b(?:pkill|killall|xkill)\b/u.test(command)) return refused
  if (/\bfuser\b[^\n]*\s-[a-zA-Z]*k/u.test(command)) return refused
  if (
    /\bStop-Process\b/iu.test(command) &&
    (/\|\s*Stop-Process/iu.test(command) ||
      /-(?:Name|ProcessName|InputObject)\b/iu.test(command) ||
      /\$\w+\.(?:Id|ProcessId)/iu.test(command))
  )
    return refused
  // Every `kill` command word, whether it starts the line, follows a pipe into
  // xargs, or sits behind sudo/exec/env/nohup.
  const killCommand =
    /(?:^[ \t]*|[;&|(][ \t]*|\b(?:xargs|sudo|exec|env|nohup|setsid|time)\b[ \t]+)kill\b([^;&|\n]*)/gu
  let matched = false
  for (const match of command.matchAll(killCommand)) {
    matched = true
    const args = (match[1] ?? '').trim()
    // A runtime lookup cannot prove which process it reaches.
    if (/[$`><*[\]{}]/u.test(args) || /%\d/u.test(args)) return refused
    const targets = args.split(/\s+/u).filter((token) => !/^--?[A-Za-z0-9]+$/u.test(token))
    if (targets.length === 0) return refused
    for (const target of targets) {
      if (!/^[1-9]\d*$/u.test(target)) return refused
    }
  }
  // A kill this parse never reached (a nested shell, an interpreter one-liner,
  // a lookup piped into some other helper) still resolves its target at run
  // time, so a command that both looks one up and kills gets the same answer.
  const runtimeLookup =
    /\b(?:lsof|pgrep|pidof|fuser|pstree|ps|ss|netstat|xargs|jobs)\b|\$\(|`/u.test(command)
  if (!matched && runtimeLookup && /\bkill\b/u.test(command)) return refused
  return null
}
