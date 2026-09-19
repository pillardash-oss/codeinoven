<script lang="ts">
  import type { SpeechSettings } from '../../../../lib/speech/types'
  import Switch from '../ui/Switch.svelte'
  import VoiceShortcutInput from './VoiceShortcutInput.svelte'
  import { unloadItems, unloadOptions } from './sound-settings-helpers'

  interface Props {
    settings: SpeechSettings
    patch: (next: Partial<SpeechSettings>) => void
  }

  let { settings, patch }: Props = $props()

  function patchCues(next: Partial<SpeechSettings['cues']>): void {
    patch({ cues: { ...settings.cues, ...next } })
  }
</script>

<section id="settings-block-sound-cleanup" class="rounded-xl border bg-surface p-4">
  <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Transcript cleanup</h2>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-4">
      <div>
        <p class="text-sm font-medium">Local cleanup</p>
        <p class="text-xs text-dimmed">
          The local instruct cleanup model applies punctuation and your learned style lessons.
          Everything stays on this device.
        </p>
      </div>
      <Switch
        checked={settings.localCleanupEnabled}
        onchange={(checked) => patch({ localCleanupEnabled: checked })}
        aria-label="Toggle local transcript cleanup"
      />
    </div>
    <div class="space-y-3 rounded-lg border bg-elevated/40 p-3">
      <p class="text-xs font-medium text-muted">Cleanup behavior</p>
      <div class="flex items-center justify-between gap-4">
        <p class="text-xs text-dimmed">
          Smart cleanup remove “um, uh” disfluencies and add punctuation
        </p>
        <Switch
          checked={settings.refinementFlags.smartCleanup}
          onchange={(checked) =>
            patch({
              refinementFlags: { ...settings.refinementFlags, smartCleanup: checked }
            })}
          aria-label="Toggle smart cleanup"
        />
      </div>
      <div class="flex items-center justify-between gap-4">
        <p class="text-xs text-dimmed">
          Self-correction drop “no wait / scratch that” retracts, keep final intent
        </p>
        <Switch
          checked={settings.refinementFlags.selfCorrection}
          onchange={(checked) =>
            patch({
              refinementFlags: { ...settings.refinementFlags, selfCorrection: checked }
            })}
          aria-label="Toggle self-correction removal"
        />
      </div>
      <div class="flex items-center justify-between gap-4">
        <p class="text-xs text-dimmed">
          Preserve technical keep code identifiers exact; “index dot tsx” → “index.tsx”
        </p>
        <Switch
          checked={settings.refinementFlags.preserveTechnical}
          onchange={(checked) =>
            patch({
              refinementFlags: { ...settings.refinementFlags, preserveTechnical: checked }
            })}
          aria-label="Toggle technical term preservation"
        />
      </div>
    </div>
    <div class="flex items-center justify-between gap-4">
      <div>
        <p class="text-sm font-medium">Remote cleanup</p>
        <p class="text-xs text-dimmed">
          Send transcript text and minimal context only. Audio never leaves the device.
        </p>
      </div>
      <Switch
        checked={settings.remoteCleanupEnabled}
        onchange={(checked) => patch({ remoteCleanupEnabled: checked })}
        aria-label="Toggle remote transcript cleanup"
      />
    </div>
    <select
      class="w-full rounded-lg border bg-elevated px-2.5 py-2 text-xs outline-none focus:border-primary disabled:opacity-50"
      aria-label="Remote cleanup model source"
      disabled={!settings.remoteCleanupEnabled}
      value={settings.remoteCleanupSelection}
      onchange={(event) =>
        patch({
          remoteCleanupSelection: event.currentTarget.value as 'fixed' | 'conversation'
        })}
    >
      <option value="conversation">Current conversation model</option>
      <option value="fixed">Selected fixed model</option>
    </select>
    {#if settings.remoteCleanupSelection === 'fixed'}
      <label class="block text-xs text-muted">
        Fixed model ID
        <input
          class="mt-1 w-full rounded-lg border bg-elevated px-2.5 py-2 text-xs outline-none focus:border-primary disabled:opacity-50"
          type="text"
          value={settings.remoteCleanupModelId ?? ''}
          disabled={!settings.remoteCleanupEnabled}
          placeholder="Model ID from the current harness"
          autocomplete="off"
          oninput={(event) =>
            patch({
              remoteCleanupModelId: event.currentTarget.value.trim() || undefined
            })}
        />
      </label>
    {/if}
  </div>
</section>

<section id="settings-block-sound-voice-shortcut" class="rounded-xl border bg-surface p-4">
  <div class="flex items-center justify-between gap-4">
    <div class="min-w-0">
      <p class="text-sm font-medium">Voice recording shortcut</p>
      <p class="text-xs text-dimmed">
        Starts dictation in whichever input with a microphone is on view the chat composer, a
        selection comment, the temporary chat, or an open editor. While recording, Escape stops it.
      </p>
    </div>
    <VoiceShortcutInput
      value={settings.voiceRecordingShortcut}
      onchange={(shortcut) => patch({ voiceRecordingShortcut: shortcut })}
    />
  </div>
</section>

<section id="settings-block-sound-voice-recording" class="rounded-xl border bg-surface p-4">
  <div class="flex items-center justify-between gap-4">
    <div>
      <p class="text-sm font-medium">Enable voice recording</p>
      <p class="text-xs text-dimmed">
        When no local speech-to-text model is installed, dictation can send audio to an
        audio-capable conversation model. Audio never leaves this device unless you turn this on.
        Off by default.
      </p>
    </div>
    <Switch
      checked={settings.voiceRecordingEnabled}
      onchange={(checked) => patch({ voiceRecordingEnabled: checked })}
      aria-label="Toggle voice recording via the conversation model"
    />
  </div>
</section>

<section id="settings-block-sound-memory" class="rounded-xl border bg-surface p-4">
  <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Model memory</h2>
  <div class="space-y-3">
    {#each unloadItems as item (item.key)}
      <label class="flex items-center justify-between gap-3 text-xs text-muted">
        {item.label}
        <select
          class="rounded-lg border bg-elevated px-2.5 py-1.5 text-xs outline-none focus:border-primary"
          aria-label={`${item.label} unload delay`}
          value={settings[item.key]}
          onchange={(event) =>
            patch({
              [item.key]: event.currentTarget.value as '5m' | '10m' | '20m' | '30m' | 'keep'
            })}
        >
          {#each unloadOptions as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>
    {/each}
  </div>
</section>

<section id="settings-block-sound-cues" class="rounded-xl border bg-surface p-4">
  <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Cues and playback</h2>
  <div class="grid gap-3 sm:grid-cols-2">
    <Switch
      checked={settings.cues.listeningStarted}
      onchange={(checked) => patchCues({ listeningStarted: checked })}
      label="Listening started"
      aria-label="Toggle listening-start cue"
    />
    <Switch
      checked={settings.cues.recordingStopped}
      onchange={(checked) => patchCues({ recordingStopped: checked })}
      label="Recording stopped"
      aria-label="Toggle recording-stop cue"
    />
    <Switch
      checked={settings.cues.transcriptReady}
      onchange={(checked) => patchCues({ transcriptReady: checked })}
      label="Transcript ready"
      aria-label="Toggle transcript-ready cue"
    />
    <Switch
      checked={settings.includeCodeBlocksInSpeech}
      onchange={(checked) => patch({ includeCodeBlocksInSpeech: checked })}
      label="Read code blocks"
      aria-label="Toggle code blocks in spoken responses"
    />
  </div>
  <label class="mt-4 flex items-center gap-3 text-xs text-muted">
    Cue volume
    <input
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={settings.cues.volume}
      aria-label="Speech cue volume"
      oninput={(event) => patchCues({ volume: event.currentTarget.valueAsNumber })}
    />
  </label>
</section>
