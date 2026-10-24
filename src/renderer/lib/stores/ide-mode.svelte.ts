class IdeModeState {
  enabled = $state(false)
  constructor() {
    try {
      this.enabled = localStorage.getItem('editor.ideMode') === 'true'
    } catch {
      /* Storage may be unavailable. */
    }
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    try {
      localStorage.setItem('editor.ideMode', String(enabled))
    } catch {
      /* Keep the session setting. */
    }
  }
}
export const ideMode = new IdeModeState()
