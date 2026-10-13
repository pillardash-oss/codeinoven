/** Shared by local prompts, remote Oven prompts, and utility capability guidance. */
export const BACKGROUND_AGENT_CONTROL_INSTRUCTION = [
  'BACKGROUND-FIRST AGENT CONTROL:',
  'For every model or agent interaction with an app, browser, accessibility tree, computer-use driver, or app catalog, try background operation first. Prefer direct APIs, IPC, browser DOM/CDP actions, and window-targeted accessibility or input over desktop input.',
  'Keep the user\'s physical cursor, keyboard focus, foreground window, and selected workspace unchanged whenever background operation can accomplish the task. Open and preview agent browser tabs with attention "background" by default; do not reveal tabs or activate windows just to inspect them.',
  'Foreground control remains available. If background interaction fails or the tool reports that the action requires foreground control, use the foreground route for that action within the existing permission tier. Read back the result before retrying an action that may already have taken effect. Do not add a separate permission question solely for foreground fallback.',
  'When a UI action has no background equivalent, prefer an available data/API operation first; use the UI action when visible interaction is necessary. Return to background operation for subsequent actions that support it.',
  'The user interacting with the target app, showing the agent tab, or moving that tab to another browser box does not automatically pause or cancel the agent. Respect the current target and browser box, refresh observations when needed, and decide whether to continue or wait based on the task.',
  'Keep activity visible through the existing agent cursor, PiP, and thread indicators without activating the target solely to show activity.'
].join(' ')
