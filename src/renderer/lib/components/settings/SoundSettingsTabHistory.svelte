<script lang="ts">
  import { Check, RefreshCw, Trash2 } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { speechSettingsStore as speech, type SpeechRetryStatus } from '$lib/stores/speech.svelte'
  import { formatDateTime } from '$shared/date-time-format'
  import type { SpeechSettings } from '../../../../lib/speech/types'
  import HistoryAudioPlayer from './HistoryAudioPlayer.svelte'
  import HistoryTranscriptCopyMenu from './HistoryTranscriptCopyMenu.svelte'
  import type { PendingDeletion } from './sound-settings-helpers'

  interface Props {
    settings: SpeechSettings
    patch: (next: Partial<SpeechSettings>) => void
    searchQuery: string
    onRequestDelete: (pending: PendingDeletion) => void
  }

  let { settings, patch, searchQuery, onRequestDelete }: Props = $props()

  const normalizedQuery = $derived(searchQuery.trim().toLowerCase())

  const filteredHistory = $derived.by(() => {
    if (!normalizedQuery) return speech.history.items
    return speech.history.items.filter((attempt) => {
      const haystack = [
        attempt.finalTranscript,
        attempt.rawTranscript,
        attempt.cleanedTranscript,
        ...attempt.errors.map((e) => e.error.message)
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  })

  /**
   * Transient retry feedback for a row: `running` spins the retry button,
   * `done` shows its check and highlights the copy control, `undefined` is the
   * resting state.
   */
  function retryStatusOf(attemptId: string): SpeechRetryStatus | undefined {
    return speech.retryStatus[attemptId]
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

<section id="settings-block-sound-history" class="border bg-surface p-4">
  <div class="mb-3 flex items-center justify-between gap-3 border-b border-border pb-2">
    <div>
      <h2 class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">Recording history</h2>
      <p class="mt-1 text-[0.6875rem] text-dimmed">
        Every success and failure counts toward retention. Audio, raw transcript, and cleaned
        transcript are kept per attempt. Oldest attempts are evicted first at the limit.
      </p>
    </div>
    <label class="flex items-center gap-2 text-xs text-muted"
      >Keep <input
        class="w-16 border bg-elevated px-2 py-1 text-right"
        type="number"
        min="1"
        max="500"
        value={settings.historyLimit}
        aria-label="Speech history limit"
        onchange={(event) => void saveHistoryLimit(event)}
      /></label
    >
  </div>
  <div class="max-h-[60dvh] divide-y divide-border overflow-y-auto">
    {#each filteredHistory as attempt (attempt.id)}
      <div class="py-3">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium">
              {formatDateTime(attempt.createdAt)} · {attempt.stage}
            </p>
            <p class="mt-0.5 line-clamp-2 text-[0.6875rem] text-dimmed">
              {attempt.finalTranscript ??
                attempt.rawTranscript ??
                attempt.errors.at(-1)?.error.message ??
                'No transcript'}
            </p>
            <p class="mt-1 text-[0.625rem] text-dimmed">
              {(attempt.byteSize / 1024).toFixed(1)} KB{attempt.runtime
                ? ` · ${attempt.runtime}`
                : ''}{attempt.rawTranscript ? ' · raw + cleaned' : ''}{attempt.retries.length
                ? ` · ${attempt.retries.length} retries`
                : ''}
            </p>
          </div>
          {#if attempt.audioAvailable && (attempt.stage === 'failed' || retryStatusOf(attempt.id))}
            {@const asr = speech.catalog?.artifacts.find(
              (item) =>
                item.capability === 'asr' &&
                item.qualification.status !== 'retired' &&
                speech.capabilities?.installedArtifacts.some(
                  (installed) => installed.available && installed.artifactId === item.id
                )
            )}
            {@const retryState = retryStatusOf(attempt.id)}
            <button
              type="button"
              class="flex h-8 w-8 shrink-0 items-center justify-center text-muted hover:bg-elevated disabled:opacity-40"
              title={retryState === 'running'
                ? 'Transcribing'
                : retryState === 'done'
                  ? 'Transcription complete'
                  : 'Retry transcription'}
              aria-label={retryState === 'running'
                ? 'Transcribing'
                : retryState === 'done'
                  ? 'Transcription complete'
                  : 'Retry transcription'}
              disabled={!asr || retryState !== undefined}
              onclick={() => asr && void speech.retry(attempt.id, asr.runtime, asr.id)}
              >{#if retryState === 'running'}<RefreshCw
                  size={13}
                  class="animate-spin"
                  aria-hidden="true"
                />{:else if retryState === 'done'}<Check
                  size={13}
                  class="text-success"
                  aria-hidden="true"
                />{:else}<RefreshCw size={13} aria-hidden="true" />{/if}</button
            >
          {/if}
          <HistoryTranscriptCopyMenu {attempt} highlighted={retryStatusOf(attempt.id) === 'done'} />
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center text-muted hover:bg-danger/10 hover:text-danger"
            title="Delete recording attempt"
            aria-label="Delete recording attempt"
            onclick={() =>
              onRequestDelete({
                action: 'history-item',
                targetId: attempt.id,
                label: formatDateTime(attempt.createdAt)
              })}><Trash2 size={13} aria-hidden="true" /></button
          >
        </div>
        {#if attempt.audioAvailable}
          <div class="mt-2">
            <HistoryAudioPlayer
              attemptId={attempt.id}
              label="Recording {formatDateTime(attempt.createdAt)}"
            />
          </div>
        {/if}
      </div>
    {/each}
  </div>
  {#if normalizedQuery && filteredHistory.length === 0}
    <p class="py-6 text-center text-sm text-dimmed">
      No history entries match “{searchQuery.trim()}”.
    </p>
  {/if}
  {#if speech.history.total > 0}<button
      type="button"
      class="mt-3 text-xs text-danger hover:underline"
      onclick={() =>
        onRequestDelete({
          action: 'all-history',
          targetId: 'all',
          label: 'all recording history'
        })}>Delete all history</button
    >{/if}
</section>
