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
