import { invoke } from '$lib/ipc.svelte'
import { posixBasename } from '$shared/paths'
import type {
  SpeechArtifactQualification,
  SpeechCapability,
  SpeechCleanupMode,
  SpeechInstalledArtifact,
  SpeechModelArtifact,
  SpeechModelFamilyId,
  SpeechRuntime,
  SpeechSettings
} from '../../../lib/speech/types'
import type { ActiveCapture } from './speech-controller-types'

export interface SpeechArtifactSelection {
  runtime: SpeechRuntime
  artifact: SpeechModelArtifact
}

const IMPORTED_QUALIFICATION: SpeechArtifactQualification = {
  status: 'qualified',
  licenseReviewed: true,
  compatibilityReviewed: true,
  checksumReviewed: true,
  benchmark: { status: 'passed' }
}

/**
 * A user-imported model has no catalog entry, so synthesize the artifact shape
 * the speech service expects from the installed record it was registered with.
 */
function importedArtifact(
  installed: SpeechInstalledArtifact,
  familyId: SpeechModelFamilyId,
  capability: SpeechCapability
): SpeechModelArtifact {
  return {
    id: installed.artifactId,
    familyId,
    capability,
    runtime: installed.runtime,
    label: installed.importPath ? posixBasename(installed.importPath) : installed.artifactId,
    description: '',
    tier: 'balanced',
    version: 'imported',
    repositoryRevision: 'imported',
    platforms: [],
    architectures: [],
    languages: [],
    voices: [],
    files: [],
    byteSize: 0,
    license: 'user-provided',
    attribution: '',
    sourcePageUrl: '',
    minimumMemoryBytes: 0,
    qualification: IMPORTED_QUALIFICATION
  }
}

/**
 * Choose the local ASR artifact for a transcription. Reports a configured
 * selection that is no longer installed through the callback so the caller can
 * clear it, then falls back to the first qualified installed model.
 */
export async function selectAsrArtifact(
  sound: SpeechSettings,
  onUnavailableSelection: (artifactId: string) => void
): Promise<SpeechArtifactSelection> {
  const [capabilities, catalog] = await Promise.all([
    invoke('speech:getCapabilities'),
    invoke('speech:getCatalog')
  ])
  if (!capabilities.ok) throw new Error(capabilities.error.message)
  if (!catalog.ok) throw new Error(catalog.error.message)
  const installedAll = capabilities.value.installedArtifacts.filter((a) => a.available)
  const installedIds = new Set(installedAll.map((a) => a.artifactId))
  const activeArtifactId = sound.asrArtifactId
  if (activeArtifactId) {
    const chosenInstalled = installedAll.find((a) => a.artifactId === activeArtifactId)
    if (chosenInstalled) {
      const catalogHit = catalog.value.artifacts.find((c) => c.id === chosenInstalled.artifactId)
      if (catalogHit) {
        if (catalogHit.capability === 'asr' && catalogHit.qualification.status !== 'retired')
          return { runtime: chosenInstalled.runtime, artifact: catalogHit }
      } else if (chosenInstalled.capability !== 'tts') {
        return {
          runtime: chosenInstalled.runtime,
          artifact: importedArtifact(chosenInstalled, 'whisper', 'asr')
        }
      }
    }
    onUnavailableSelection(activeArtifactId)
  }
  const artifact = catalog.value.artifacts.find(
    (candidate) =>
      candidate.capability === 'asr' &&
      candidate.qualification.status !== 'retired' &&
      installedIds.has(candidate.id)
  )
  if (!artifact) throw new Error(`Install a speech-to-text model in Sound settings.`)
  return { runtime: artifact.runtime, artifact }
}

/** Choose the local TTS artifact for read-aloud. Throws when the configured
 *  voice is gone or nothing qualified is installed. */
export async function selectTtsArtifact(sound: SpeechSettings): Promise<SpeechArtifactSelection> {
  const [capabilities, catalog] = await Promise.all([
    invoke('speech:getCapabilities'),
    invoke('speech:getCatalog')
  ])
  if (!capabilities.ok) throw new Error(capabilities.error.message)
  if (!catalog.ok) throw new Error(catalog.error.message)
  const installedAll = capabilities.value.installedArtifacts.filter((item) => item.available)
  const installed = new Set(installedAll.map((item) => item.artifactId))
  if (sound.ttsArtifactId) {
    const chosenInstalled = installedAll.find((a) => a.artifactId === sound.ttsArtifactId)
    if (chosenInstalled) {
      const catalogHit = catalog.value.artifacts.find((c) => c.id === chosenInstalled.artifactId)
      if (catalogHit) {
        if (catalogHit.capability === 'tts' && catalogHit.qualification.status !== 'retired')
          return { runtime: chosenInstalled.runtime, artifact: catalogHit }
      } else {
        return {
          runtime: chosenInstalled.runtime,
          artifact: importedArtifact(chosenInstalled, 'kokoro', 'tts')
        }
      }
    }
    throw new Error(`The active text-to-speech model is not installed.`)
  }
  const artifact = catalog.value.artifacts.find(
    (item) =>
      item.capability === 'tts' && item.qualification.status !== 'retired' && installed.has(item.id)
  )
  if (!artifact) throw new Error(`Install a text-to-speech model.`)
  return { runtime: artifact.runtime, artifact }
}

/** Cleanup behaviour assembled from the user's Sound settings. */
export function speechCleanupMode(sound: SpeechSettings): SpeechCleanupMode {
  const flags = sound.refinementFlags
  if (sound.remoteCleanupEnabled) {
    return {
      kind: 'remote',
      selection: sound.remoteCleanupSelection,
      ...(sound.remoteCleanupModelId ? { modelId: sound.remoteCleanupModelId } : {}),
      ...(flags ? { flags } : {})
    }
  }
  return sound.localCleanupEnabled
    ? { kind: 'local', artifactId: sound.cleanupArtifactId, ...(flags ? { flags } : {}) }
    : { kind: 'disabled' }
}

/**
 * Produce the final transcript for a finished capture. Prefers an installed
 * local ASR model; when voice recording is enabled and no local ASR is
 * installed, falls back to audio-to-LLM transcription (audio never leaves the
 * device unless the user has opted in via the default-`false` toggle).
 */
export async function transcribeCapture(
  active: ActiveCapture,
  sound: SpeechSettings,
  selectAsr: () => Promise<SpeechArtifactSelection>
): Promise<string> {
  if (sound.voiceRecordingEnabled) {
    let selection: SpeechArtifactSelection | null
    try {
      selection = await selectAsr()
    } catch {
      selection = null
    }
    if (selection) {
      const result = await invoke(
        'speech:transcribe',
        active.attemptId,
        selection.runtime,
        selection.artifact.id,
        'auto',
        speechCleanupMode(sound)
      )
      if (!result.ok) throw new Error(result.error.message)
      return result.value.finalTranscript
    }
    const audioLlm = await invoke(
      'speech:transcribeAudioToLlm',
      active.attemptId,
      active.scope,
      'auto',
      speechCleanupMode(sound)
    )
    if (!audioLlm.ok) throw new Error(audioLlm.error.message)
    return audioLlm.value.finalTranscript
  }
  const selection = await selectAsr()
  const result = await invoke(
    'speech:transcribe',
    active.attemptId,
    selection.runtime,
    selection.artifact.id,
    'auto',
    speechCleanupMode(sound)
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.value.finalTranscript
}
