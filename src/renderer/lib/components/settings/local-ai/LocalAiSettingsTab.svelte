<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import {
    LOCAL_AI_UNLOAD_LABELS,
    LOCAL_AI_UNLOAD_OPTIONS,
    isLocalAiUnloadOption
  } from '$shared/llama-cpp'
  import { toast } from 'svelte-sonner'
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte'
  import { localAi } from './local-ai-controller.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  let confirming = $state(false)
  let unloading = $state(false)

  const entries = $derived(config.llamaCppServers ?? [])

  function setUnloadWindow(value: string): void {
    if (!isLocalAiUnloadOption(value)) return
    void updateConfig({ llamaCppUnload: value })
  }

  /** Model file names, for a result line a person can read. */
  function modelNames(models: string[]): string {
    const names = models.map((file) => file.split(/[/\\]/u).pop() ?? file)
    if (names.length <= 2) return names.join(', ')
    return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
  }

  async function unloadNow(): Promise<void> {
    if (unloading) return
    unloading = true
    confirming = false
    try {
      const result = await invoke('localAi:unloadNow')
      for (const entry of entries) void localAi.attach(entry)
      if (result.stopped === 0) {
        toast.info('Nothing was loaded', { description: 'No local model was held in memory.' })
        return
      }
      toast.success(
        result.stopped === 1 ? 'Unloaded 1 model' : `Unloaded ${result.stopped} models`,
        { description: modelNames(result.models) }
      )
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'The models could not be unloaded'
      toast.error('Unload failed', { description: message })
    } finally {
      unloading = false
    }
  }
</script>

<div class="space-y-3">
  <section class="border bg-surface">
    <header class="border-b px-3 py-2">
      <h2 class="text-xs font-semibold">Model memory</h2>
    </header>
    <div class="flex items-center justify-between gap-3 px-3 py-3">
      <label
        class="text-xs text-foreground"
        for="local-ai-unload-window"
        title="A loaded model stays resident until this much idle time passes"
      >
        Unload an idle model after
      </label>
      <select
        id="local-ai-unload-window"
        class="border bg-elevated px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-overlay focus:border-primary disabled:opacity-50"
        value={config.llamaCppUnload}
        disabled={!settingsReady}
        onchange={(event) => setUnloadWindow(event.currentTarget.value)}
      >
        {#each LOCAL_AI_UNLOAD_OPTIONS as option (option)}
          <option value={option}>{LOCAL_AI_UNLOAD_LABELS[option]}</option>
        {/each}
      </select>
    </div>
    <div class="flex items-center justify-between gap-3 border-t px-3 py-3">
      <p class="text-xs text-dimmed" title="Free the memory now instead of waiting for the window">
        Free the memory now
      </p>
      <button
        type="button"
        class="shrink-0 border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay disabled:opacity-50"
        title="Unload every loaded local model now"
        disabled={!settingsReady || unloading}
        onclick={() => (confirming = true)}
      >
        {unloading ? 'Unloading…' : 'Unload now'}
      </button>
    </div>
  </section>
</div>

<ConfirmDialog
  open={confirming}
  title="Unload every loaded model?"
  confirmLabel="Unload now"
  variant="danger"
  onCancel={() => (confirming = false)}
  onConfirm={() => void unloadNow()}
>
  <p class="text-sm leading-relaxed text-muted">
    Every local model in memory is stopped now, including one a session is using.
  </p>
  <p class="mt-2 text-sm leading-relaxed text-muted">
    A cleanup or search that runs while the model is gone waits for it to load again. Nothing is
    removed from disk.
  </p>
</ConfirmDialog>
