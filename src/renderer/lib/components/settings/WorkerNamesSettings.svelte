<script lang="ts">
  import { Check, ChevronDown, Loader2, Pencil, RotateCcw, Save, X } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { WorkerNameSettings } from '$shared/assignment/worker-names'

  interface Props {
    settingsReady: boolean
  }

  let { settingsReady }: Props = $props()

  let settings = $state<WorkerNameSettings>({ defaults: [], custom: null })
  let loading = $state(true)
  let editing = $state(false)
  let saving = $state(false)
  let draft = $state('')
  let error = $state('')
  let saved = $state(false)

  onMount(() => {
    void loadSettings()
  })

  async function loadSettings(): Promise<void> {
    loading = true
    error = ''
    try {
      settings = await invoke('workerNames:getSettings')
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Worker names could not be loaded.'
    } finally {
      loading = false
    }
  }

  function startEditing(): void {
    draft = JSON.stringify(settings.custom ?? settings.defaults, null, 2)
    error = ''
    saved = false
    editing = true
  }

  function cancelEditing(): void {
    editing = false
    error = ''
  }

  async function save(): Promise<void> {
    error = ''
    saved = false
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch {
      error = 'Invalid JSON. Enter a JSON array of worker-name strings.'
      return
    }
    if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== 'string')) {
      error = 'Invalid JSON. The value must be an array of worker-name strings.'
      return
    }
    if (parsed.length === 0) {
      error = 'Add at least one worker name before saving.'
      return
    }

    saving = true
    try {
      await invoke('workerNames:saveCustom', parsed)
      settings = { ...settings, custom: parsed }
      draft = JSON.stringify(parsed, null, 2)
      editing = false
      saved = true
    } catch (saveError) {
      error = saveError instanceof Error ? saveError.message : 'Worker names could not be saved.'
    } finally {
      saving = false
    }
  }
</script>

<section class="mt-4 rounded-xl border bg-surface" aria-labelledby="worker-names-heading">
  <div class="flex items-start justify-between gap-4 p-4">
    <div>
      <h2 id="worker-names-heading" class="text-sm font-semibold">Worker name pool</h2>
      <p class="mt-0.5 text-xs text-muted">
        Names assigned to workers. Defaults stay preserved when you create a custom pool.
      </p>
    </div>
    {#if !editing}
      <button
        type="button"
        class="flex shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
        title="Edit the worker name pool"
        aria-label="Edit the worker name pool"
        disabled={!settingsReady || loading}
        onclick={startEditing}
      >
        <Pencil size={13} />
        Edit names
      </button>
    {/if}
  </div>

  {#if loading}
    <div class="flex items-center gap-2 border-t px-4 py-3 text-xs text-muted">
      <Loader2 size={14} class="animate-spin" /> Loading worker names…
    </div>
  {:else}
    <details class="border-t group">
      <summary
        class="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs text-muted hover:bg-elevated"
      >
        <span
          ><strong class="text-foreground">{settings.defaults.length}</strong> default names</span
        >
        <ChevronDown size={14} class="transition-transform group-open:rotate-180" />
      </summary>
      <div
        class="grid grid-cols-2 gap-x-4 gap-y-1 border-t px-4 py-3 text-xs text-muted sm:grid-cols-3"
      >
        {#each settings.defaults as name (name)}
          <span>{name}</span>
        {/each}
      </div>
    </details>

    <div class="border-t px-4 py-3">
      {#if settings.custom}
        <p class="text-xs text-muted">
          Custom pool active · <strong class="text-foreground">{settings.custom.length}</strong> saved
          names
        </p>
      {:else}
        <p class="text-xs text-dimmed">Using the default pool.</p>
      {/if}
    </div>
  {/if}

  {#if editing}
    <div class="border-t p-4">
      <label for="worker-names-json" class="text-xs font-semibold text-foreground"
        >Custom names JSON</label
      >
      <p class="mt-1 text-xs text-muted">Use a JSON array containing one string per worker name.</p>
      <textarea
        id="worker-names-json"
        class="mt-3 min-h-56 w-full resize-y rounded-lg border bg-elevated p-3 font-mono text-xs leading-5 text-foreground outline-none focus:border-primary"
        bind:value={draft}
        spellcheck="false"></textarea>
      <div class="mt-3 flex items-center justify-between gap-3">
        <div class="min-h-5 text-xs" aria-live="polite">
          {#if error}<span class="text-danger">{error}</span>{:else if saved}<span
              class="flex items-center gap-1 text-primary"><Check size={13} /> Saved</span
            >{/if}
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs hover:bg-elevated"
            title="Cancel editing worker names"
            aria-label="Cancel editing worker names"
            onclick={cancelEditing}
            disabled={saving}><X size={13} /> Cancel</button
          >
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs hover:bg-elevated"
            title="Reset custom JSON to the defaults"
            aria-label="Reset custom JSON to the defaults"
            onclick={() => (draft = JSON.stringify(settings.defaults, null, 2))}
            disabled={saving}><RotateCcw size={13} /> Reset</button
          >
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs text-on-primary hover:bg-primary-hover disabled:opacity-50"
            title="Save custom worker names"
            aria-label="Save custom worker names"
            onclick={() => void save()}
            disabled={saving}><Save size={13} /> Save</button
          >
        </div>
      </div>
    </div>
  {/if}

  {#if error && !editing}
    <p class="border-t px-4 py-3 text-xs text-danger" role="alert">{error}</p>
  {/if}
</section>
