<script lang="ts">
  import { onMount } from 'svelte'
  import { RefreshCw, Search, X } from '@lucide/svelte'
  import type { AppConfigPatch } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'
  import { speechSettingsStore as speech } from '$lib/stores/speech.svelte'
  import type { SpeechSettings } from '../../../../lib/speech/types'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import SoundPlaygroundTab from './SoundPlaygroundTab.svelte'
  import SoundSettingsTabHistory from './SoundSettingsTabHistory.svelte'
  import SoundSettingsTabLearning from './SoundSettingsTabLearning.svelte'
  import SoundSettingsTabModels from './SoundSettingsTabModels.svelte'
  import SoundSettingsTabPreferences from './SoundSettingsTabPreferences.svelte'
  import { soundTabs, type PendingDeletion, type SoundTab } from './sound-settings-helpers'

  interface Props {
    settings: SpeechSettings
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { settings, settingsReady: _settingsReady, updateConfig }: Props = $props()
  let deleting = $state<PendingDeletion | null>(null)
  let mutationBusy = $state(false)
  let activeTab = $state<SoundTab>('models')
  let searchQuery = $state('')

  onMount(() => {
    void speech.load()
    return () => speech.dispose()
  })

  function patch(next: Partial<SpeechSettings>): void {
    void updateConfig({ sound: { ...settings, ...next } })
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
            : pending.action === 'lesson'
              ? await invoke('speech:deleteLesson', pending.targetId, token)
              : pending.action === 'model' && pending.isImported
                ? await invoke('speech:unregisterModel', pending.targetId, token)
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
</script>

<div class="p-6">
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

  <div
    class="mb-6 flex items-center gap-1 rounded-lg border bg-surface p-1"
    role="tablist"
    aria-label="Sound settings sections"
    data-onboarding="sound-settings"
  >
    {#each soundTabs as tab (tab.id)}
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === tab.id}
        class="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors {activeTab ===
        tab.id
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:text-foreground'}"
        onclick={() => {
          activeTab = tab.id
          searchQuery = ''
        }}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  {#if activeTab === 'history' || activeTab === 'learning'}
    <label class="relative block">
      <span class="sr-only"
        >Search {activeTab === 'history' ? 'recording history' : 'learned lessons'}</span
      >
      <Search
        size={15}
        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dimmed"
        aria-hidden="true"
      />
      <input
        type="search"
        bind:value={searchQuery}
        placeholder={activeTab === 'history'
          ? 'Search recording history…'
          : 'Search learned lessons…'}
        class="w-full rounded-lg border bg-surface py-2 pl-9 pr-8 text-sm text-foreground outline-none transition-colors placeholder:text-dimmed focus:border-primary"
      />
      {#if searchQuery}
        <button
          type="button"
          class="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-dimmed hover:bg-overlay hover:text-foreground"
          title="Clear search"
          aria-label="Clear search"
          onclick={() => (searchQuery = '')}><X size={13} aria-hidden="true" /></button
        >
      {/if}
    </label>
  {/if}

  <div class="space-y-4">
    {#if activeTab === 'models'}
      <SoundSettingsTabModels
        {settings}
        {patch}
        onRequestDelete={(pending) => (deleting = pending)}
      />
    {/if}

    {#if activeTab === 'history'}
      <SoundSettingsTabHistory
        {settings}
        {patch}
        {searchQuery}
        onRequestDelete={(pending) => (deleting = pending)}
      />
    {/if}

    {#if activeTab === 'learning'}
      <SoundSettingsTabLearning {searchQuery} onRequestDelete={(pending) => (deleting = pending)} />
    {/if}

    {#if activeTab === 'playground'}
      <SoundPlaygroundTab {settings} />
    {/if}

    {#if activeTab === 'preferences'}
      <SoundSettingsTabPreferences {settings} {patch} />
    {/if}
  </div>
</div>

<ConfirmDialog
  open={deleting !== null}
  title="Confirm deletion"
  confirmLabel="Delete"
  busy={mutationBusy}
  onCancel={() => (deleting = null)}
  onConfirm={confirmDeletion}
>
  <p>
    Delete {deleting?.label}? This removes the app-owned data and cannot be undone. Imported files
    are never deleted.
  </p>
</ConfirmDialog>
