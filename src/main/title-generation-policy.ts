/**
 * TITLE-GENERATION INVARIANT: invoke this launcher as soon as the driver is
 * resolved. Never defer it to the main session's idle/success event. A title
 * updates its thread by ID, while provider-specific authentication concurrency
 * belongs inside that provider's driver.
 */
export function createAutoTitleLauncher(
  enabled: boolean,
  generate: () => Promise<void>
): () => Promise<void> {
  let launched = false
  return (): Promise<void> => {
    if (!enabled || launched) return Promise.resolve()
    launched = true
    return generate()
  }
}
