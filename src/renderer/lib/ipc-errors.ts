/**
 * Renderer-side normalization of an IPC rejection for display.
 *
 * A rejected `ipcRenderer.invoke` arrives wrapped
 * (`Error invoking remote method 'channel': Error: <message>`), so the wrapper
 * has to be stripped before the message can be shown to the user. The main
 * process already writes human-readable, user-safe messages for the channels
 * that surface them.
 */
export function ipcErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return error.message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')
}
