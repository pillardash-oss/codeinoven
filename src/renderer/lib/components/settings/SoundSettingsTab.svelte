<script lang="ts">
  import { onMount } from 'svelte'
  import { Download, LoaderCircle, Play, RefreshCw, Trash2, X } from '@lucide/svelte'
  import type { AppConfigPatch } from '$shared/types'
  import type { SpeechDestructiveAction, SpeechSettings } from '../../../../lib/speech/types'
  import { invoke } from '$lib/ipc.svelte'
  import { speechSettingsStore as speech } from '$lib/stores/speech.svelte'
  import Switch from '../ui/Switch.svelte'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    settings: SpeechSettings
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  interface PendingDeletion {
    action: SpeechDestructiveAction
    targetId: string
    label: string
  }

  let { settings, settingsReady, updateConfig }: Props = $props()
  let deleting = $state<PendingDeletion | null>(null)
  let mutationBusy = $state(false)

  onMount(() => {
    void speech.load()
    return () => speech.dispose()
  })

  function patch(next: Partial<SpeechSettings>): void {
    void updateConfig({ sound: { ...settings, ...next } })
  }

  function patchCues(next: Partial<SpeechSettings['cues']>): void {
    patch({ cues: { ...settings.cues, ...next } })
  }

  async function confirmDeletion(): Promise<void> {
    if (!deleting || mutationBusy) return
    mutationBusy = true
    const pending = deleting
    try {
      const confirmation = await invoke(
        'speech:requestConfirmation',
        pending.action,
        pending.targetId
      )
      if (!confirmation.ok) throw new Error(confirmation.error.message)
      const token = confirmation.value.token
      const result =
        pending.action === 'history-item'
          ? await invoke('speech:deleteHistory', pending.targetId, token)
          : pending.action === 'all-history'
            ? await invoke('speech:deleteAllHistory', token)
            : pending.action === 'rule'
              ? await invoke('speech:deleteCorrectionRule', pending.targetId, token)
              : await invoke('speech:deleteArtifact', pending.targetId, token)
      if (!result.ok) throw new Error(result.error.message)
      deleting = null
      await speech.load()
    } catch (cause) {
      speech.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      mutationBusy = false
    }
  }

  async function saveHistoryLimit(
    event: Event & { currentTarget: HTMLInputElement }
  ): Promise<void> {
    const limit = Math.min(500, Math.max(1, Math.round(event.currentTarget.valueAsNumber)))
    patch({ historyLimit: limit })
    await invoke('speech:enforceHistoryLimit', limit)
    await speech.load()
  }
</script>

<div class="mx-auto max-w-3xl p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Sound</h1>
      <p class="mt-0.5 text-sm text-muted">
        Local dictation, cleanup, models, and spoken responses.
      </p>
    </div>
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-lg border bg-elevated text-muted hover:text-foreground"
      title="Refresh Sound settings"
      aria-label="Refresh Sound settings"
      onclick={() => void speech.load()}
    >
      <RefreshCw size={14} class={speech.loading ? 'animate-spin' : ''} aria-hidden="true" />
    </button>
  </div>

  {#if speech.error}
    <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {speech.error}
    </p>
  {/if}

  <div class="space-y-4">
    <section id="settings-block-sound-runtime" class="rounded-xl border bg-surface p-4">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Runtime</h2>
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">Local speech runtime</p>
          <p class="text-xs text-dimmed">
            Apple Silicon defaults to MLX; other desktops use sherpa-onnx.
          </p>
        </div>
        <select
          class="rounded-lg border bg-elevated px-2.5 py-1.5 text-xs outline-none focus:border-primary"
          aria-label="Local speech runtime"
          value={settings.runtimeOverride ?? ''}
          disabled={!settingsReady}
          onchange={(event) =>
            patch({
              runtimeOverride:
                event.currentTarget.value === ''
                  ? undefined
                  : (event.currentTarget.value as 'mlx' | 'sherpa-onnx')
            })}
        >
          <option value="">Platform default</option>
          <option value="mlx">MLX</option>
          <option value="sherpa-onnx">sherpa-onnx</option>
        </select>
      </div>
    </section>

    <section id="settings-block-sound-cleanup" class="rounded-xl border bg-surface p-4">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
        Transcript cleanup
      </h2>
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium">Local cleanup</p>
            <p class="text-xs text-dimmed">Punctuation and learned rules stay on this device.</p>
          </div>
          <Switch
            checked={settings.localCleanupEnabled}
            onchange={(checked) => patch({ localCleanupEnabled: checked })}
            aria-label="Toggle local transcript cleanup"
          />
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

    <section id="settings-block-sound-cues" class="rounded-xl border bg-surface p-4">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
        Cues and playback
      </h2>
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

    <section id="settings-block-sound-models" class="rounded-xl border bg-surface p-4">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Models</h2>
      <div class="divide-y divide-border">
        {#each speech.catalog?.artifacts ?? [] as artifact (artifact.id)}
          {@const installed = speech.capabilities?.installedArtifacts.find(
            (item) => item.artifactId === artifact.id && item.available
          )}
          {@const download = speech.downloads[artifact.id]}
          <div class="flex items-center gap-3 py-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{artifact.label}</p>
              <p class="text-[11px] text-dimmed">
                {artifact.runtime} · {artifact.capability} · {(
                  artifact.byteSize / 1_048_576
                ).toFixed(0)} MB · {artifact.license} · {artifact.qualification.status}
              </p>
            </div>
            {#if installed}
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                title={`Delete ${artifact.label}`}
                aria-label={`Delete ${artifact.label}`}
                onclick={() =>
                  (deleting = { action: 'model', targetId: artifact.id, label: artifact.label })}
                ><Trash2 size={14} aria-hidden="true" /></button
              >
            {:else if download?.state === 'downloading'}
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg text-muted"
                title={`Cancel ${artifact.label} download`}
                aria-label={`Cancel ${artifact.label} download`}
                onclick={() => void speech.cancelDownload(artifact.id)}
                ><X size={14} aria-hidden="true" /></button
              >
            {:else}
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                title={`Download ${artifact.label}`}
                aria-label={`Download ${artifact.label}`}
                disabled={artifact.qualification.status !== 'qualified'}
                onclick={() => void speech.download(artifact.id)}
                ><Download size={14} aria-hidden="true" /></button
              >
            {/if}
          </div>
        {/each}
      </div>
    </section>

    <section id="settings-block-sound-history" class="rounded-xl border bg-surface p-4">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">
            Recording history
          </h2>
          <p class="mt-1 text-[11px] text-dimmed">
            Every success and failure counts toward retention.
          </p>
        </div>
        <label class="flex items-center gap-2 text-xs text-muted"
          >Keep <input
            class="w-16 rounded-lg border bg-elevated px-2 py-1 text-right"
            type="number"
            min="1"
            max="500"
            value={settings.historyLimit}
            aria-label="Speech history limit"
            onchange={(event) => void saveHistoryLimit(event)}
          /></label
        >
      </div>
      <div class="max-h-80 divide-y divide-border overflow-y-auto">
        {#each speech.history.items as attempt (attempt.id)}
          <div class="flex items-start gap-3 py-3">
            <div class="min-w-0 flex-1">
              <p class="text-xs font-medium">
                {new Date(attempt.createdAt).toLocaleString()} · {attempt.stage}
              </p>
              <p class="mt-0.5 line-clamp-2 text-[11px] text-dimmed">
                {attempt.finalTranscript ??
                  attempt.rawTranscript ??
                  attempt.errors.at(-1)?.error.message ??
                  'No transcript'}
              </p>
              <p class="mt-1 text-[10px] text-dimmed">
                {(attempt.byteSize / 1024).toFixed(1)} KB{attempt.runtime
                  ? ` · ${attempt.runtime}`
                  : ''}{attempt.retries.length ? ` · ${attempt.retries.length} retries` : ''}
              </p>
            </div>
            {#if attempt.audioAvailable}<button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated"
                title="Play recording"
                aria-label="Play recording"
                onclick={() => void speech.playRecording(attempt.id)}
                ><Play size={13} aria-hidden="true" /></button
              >{/if}
            {#if attempt.audioAvailable && attempt.stage === 'failed'}
              {@const asr = speech.catalog?.artifacts.find(
                (item) =>
                  item.capability === 'asr' &&
                  item.qualification.status === 'qualified' &&
                  speech.capabilities?.installedArtifacts.some(
                    (installed) => installed.available && installed.artifactId === item.id
                  )
              )}
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated disabled:opacity-40"
                title="Retry transcription"
                aria-label="Retry transcription"
                disabled={!asr}
                onclick={() => asr && void speech.retry(attempt.id, asr.runtime, asr.id)}
                ><RefreshCw size={13} aria-hidden="true" /></button
              >
            {/if}
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
              title="Delete recording attempt"
              aria-label="Delete recording attempt"
              onclick={() =>
                (deleting = {
                  action: 'history-item',
                  targetId: attempt.id,
                  label: new Date(attempt.createdAt).toLocaleString()
                })}><Trash2 size={13} aria-hidden="true" /></button
            >
          </div>
        {/each}
      </div>
      {#if speech.history.total > 0}<button
          type="button"
          class="mt-3 text-xs text-danger hover:underline"
          onclick={() =>
            (deleting = { action: 'all-history', targetId: 'all', label: 'all recording history' })}
          >Delete all history</button
        >{/if}
    </section>

    <section id="settings-block-sound-rules" class="rounded-xl border bg-surface p-4">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
        Learned corrections
      </h2>
      {#if speech.rules.length === 0}<p class="text-xs text-dimmed">
          No corrections learned yet.
        </p>{/if}
      {#each speech.rules as rule (rule.id)}
        <div class="flex items-center gap-3 border-t py-2 first:border-0">
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs">
              <span class="text-muted">{rule.source}</span> → {rule.replacement}
            </p>
            <p class="text-[10px] text-dimmed">
              {rule.scope.kind} · {Math.round(rule.confidence * 100)}% · {rule.evidenceCount} observations
            </p>
          </div>
          <Switch
            checked={rule.enabled}
            onchange={(checked) => void speech.setRuleEnabled(rule.id, checked)}
            aria-label={`Toggle correction ${rule.source}`}
          /><button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
            title={`Delete correction ${rule.source}`}
            aria-label={`Delete correction ${rule.source}`}
            onclick={() =>
              (deleting = {
                action: 'rule',
                targetId: rule.id,
                label: `${rule.source} → ${rule.replacement}`
              })}><Trash2 size={13} aria-hidden="true" /></button
          >
        </div>
      {/each}
    </section>
  </div>
</div>

<Modal open={deleting !== null} title="Confirm deletion" onClose={() => (deleting = null)}>
  <p class="text-sm text-muted">
    Delete {deleting?.label}? This removes the app-owned data and cannot be undone.
  </p>
  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg border px-3 py-1.5 text-sm"
      onclick={() => (deleting = null)}>Cancel</button
    >
    <button
      type="button"
      class="rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-on-danger disabled:opacity-50"
      data-modal-primary
      disabled={mutationBusy}
      onclick={() => void confirmDeletion()}
      >{#if mutationBusy}<LoaderCircle
          size={13}
          class="mr-1 inline animate-spin"
          aria-hidden="true"
        />{/if}Delete</button
    >
  {/snippet}
</Modal>
