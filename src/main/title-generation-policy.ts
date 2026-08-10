/**
 * Claude Code processes share OAuth refresh state, so its disposable title
 * session must wait for the main turn. Every other harness owns an isolated
 * title transport and must start immediately, including Engineering entry turns.
 */
export function shouldDeferAutoTitleUntilIdle(driverId: string): boolean {
  return driverId === 'claude-code'
}
