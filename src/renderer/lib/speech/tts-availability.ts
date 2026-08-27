interface ProbeGlobal {
  __cioTtsProbe?: Promise<boolean>
  __cioTtsResult?: boolean | null
}

/**
 * Resolves once whether any installed, non-retired TTS artifact exists.
 * Single-flight via a shared promise on globalThis, so many mounted buttons
 * trigger exactly one capabilities/catalog round-trip per renderer lifetime.
 */
export function probeInstalledTts(): Promise<boolean> {
  const g = globalThis as unknown as ProbeGlobal
  if (g.__cioTtsResult !== undefined && g.__cioTtsResult !== null) {
    return Promise.resolve(g.__cioTtsResult)
  }
  if (!g.__cioTtsProbe) {
    g.__cioTtsProbe = (async () => {
      try {
        const { invoke } = await import('$lib/ipc.svelte')
        const [capabilities, catalog] = await Promise.all([
          invoke('speech:getCapabilities'),
          invoke('speech:getCatalog')
        ])
        if (!capabilities.ok || !catalog.ok) return false
        const installedIds = new Set(
          capabilities.value.installedArtifacts
            .filter((artifact) => artifact.available)
            .map((artifact) => artifact.artifactId)
        )
        return catalog.value.artifacts.some(
          (artifact) =>
            artifact.capability === 'tts' &&
            artifact.qualification.status !== 'retired' &&
            installedIds.has(artifact.id)
        )
      } catch {
        return false
      }
    })()
  }
  return g.__cioTtsProbe
}
