<script lang="ts">
  import { onMount } from 'svelte'
  import { Server, FolderOpen } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { Thread, ThreadSettings } from '$shared/types'
  import type { OvenState } from '$shared/ovens'
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import OvenWorkspace from './OvenWorkspace.svelte'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { getCustomSvgDataUrl } from '../../../../lib/custom-svg'

  interface Props {
    thread: Thread
    settings: ThreadSettings
    busy: boolean
    onSettingsChange: (settings: ThreadSettings) => void
  }
  let { thread, settings, busy, onSettingsChange }: Props = $props()
  let ovens = $state.raw<OvenState | null>(null)
  let editor = $state(false)
  let workspace = $state(false)
  let selected = $state(LOCAL_OVEN_ID)
  let root = $state('')
  let harness = $state('codex')
  let provider = $state('')
  let model = $state('')
  let saving = $state(false)
  let error = $state('')
  let current = $derived(
    ovens?.ovens.find((oven) => oven.id === (settings.ovenId ?? LOCAL_OVEN_ID))
  )

  onMount(() => {
    void invoke('oven:state')
      .then((result) => {
        ovens = result
        if (
          !settings.ovenId &&
          !thread.sessionId &&
          thread.status === 'created' &&
          result.defaultOvenId !== LOCAL_OVEN_ID
        ) {
          onSettingsChange({ ...settings, ovenId: result.defaultOvenId, ovenPath: undefined })
        }
      })
      .catch(
        (failure: unknown) =>
          (error = failure instanceof Error ? failure.message : 'Could not load Ovens.')
      )
  })

  export async function openPicker(): Promise<void> {
    selected = settings.ovenId ?? LOCAL_OVEN_ID
    root = settings.ovenPath ?? ''
    harness = settings.harnessId
    provider = settings.providerId
    model = settings.modelId
    error = ''
    try {
      ovens = await invoke('oven:state')
      editor = true
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not load Ovens.'
    }
  }

  async function select(): Promise<void> {
    saving = true
    error = ''
    try {
      // Persist the settings first because a new thread can still have its initial
      // model only in the composer. The selection endpoint owns the busy guard.
      const nextSettings =
        selected === LOCAL_OVEN_ID
          ? settings
          : {
              ...settings,
              harnessId: harness,
              providerId: provider.trim(),
              modelId: model.trim(),
              accountId: harness === settings.harnessId ? settings.accountId : undefined
            }
      await invoke('thread:updateSettings', thread.projectId, thread.id, nextSettings)
      const updated = await invoke(
        'oven:selectThread',
        thread.projectId,
        thread.id,
        selected,
        root || undefined
      )
      if (updated.settings) onSettingsChange(updated.settings)
      editor = false
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not select this Oven.'
    } finally {
      saving = false
    }
  }
</script>

<div class="relative flex items-center gap-1 text-xs text-muted">
  <button
    type="button"
    class="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-elevated disabled:opacity-50"
    title="Choose the Oven for this chat"
    disabled={busy || saving}
    onclick={() => void openPicker()}
  >
    {#if current}
      <img
        class="h-3 w-3"
        alt=""
        src={current.customSvg
          ? getCustomSvgDataUrl(current.customSvg, current.color)
          : getIconSvgDataUrl(current.icon, current.color)}
      />
    {:else}<Server size={12} />{/if}<span
      >{current?.name ??
        (settings.ovenId && settings.ovenId !== LOCAL_OVEN_ID ? 'Oven unavailable' : 'Local')}</span
    >
  </button>
  {#if settings.ovenId && settings.ovenId !== LOCAL_OVEN_ID}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-elevated"
      title="Open the workspace on this Oven"
      onclick={() => (workspace = true)}><FolderOpen size={12} /> Workspace</button
    >
  {/if}
  {#if error && !editor}<span class="text-danger" role="alert">{error}</span>{/if}

  {#if editor}
    <button
      type="button"
      class="fixed inset-0 z-30 cursor-default"
      title="Close Oven picker"
      aria-label="Close Oven picker"
      onclick={() => (editor = false)}
    ></button>
    <div
      class="absolute bottom-full right-0 z-40 mb-2 max-h-[70vh] w-80 overflow-auto rounded-xl border bg-surface p-3 shadow-lg"
      role="dialog"
      tabindex="-1"
      aria-label="Choose Oven"
      onkeydown={(event) => {
        if (event.key === 'Escape') editor = false
      }}
    >
      <form
        id="oven-selection"
        class="space-y-4"
        onsubmit={(event) => {
          event.preventDefault()
          void select()
        }}
      >
        <div class="space-y-1" role="menu" aria-label="Ovens">
          {#each ovens?.ovens ?? [] as oven (oven.id)}
            <button
              type="button"
              role="menuitem"
              class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated"
              disabled={busy || saving}
              onclick={() => {
                root = oven.id === settings.ovenId ? (settings.ovenPath ?? '') : ''
                selected = oven.id
                void select()
              }}
            >
              <img
                class="h-4 w-4"
                alt=""
                src={oven.customSvg
                  ? getCustomSvgDataUrl(oven.customSvg, oven.color)
                  : getIconSvgDataUrl(oven.icon, oven.color)}
              />
              <span>{oven.name}</span>
              <span class="ml-auto text-xs text-muted"
                >{oven.id === LOCAL_OVEN_ID ? 'This computer' : 'SSH'}</span
              >
            </button>
          {/each}
        </div>
        {#if selected !== LOCAL_OVEN_ID}
          <label class="block space-y-1 text-xs text-muted"
            >Harness on Oven
            <select
              class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground"
              bind:value={harness}
              onchange={() => {
                provider = ''
                model = ''
              }}
            >
              <option value="codex">Codex</option>
              <option value="claude-code">Claude Code</option>
              <option value="opencode">OpenCode</option>
              <option value="pi">Pi</option>
              <option value="muse">Muse</option>
              <option value="cline">Cline</option>
            </select>
          </label>
          <label class="block space-y-1 text-xs text-muted"
            >Provider, optional
            <input
              class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground"
              bind:value={provider}
              placeholder="Use the Oven's configured provider"
            />
          </label>
          <label class="block space-y-1 text-xs text-muted"
            >Model, optional
            <input
              class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground"
              bind:value={model}
              placeholder="Use the Oven's configured model"
            />
          </label>
          <label class="block space-y-1 text-xs text-muted"
            >Workspace on this Oven
            <input
              class="w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-sm text-foreground"
              bind:value={root}
              placeholder="~/projects/my-repo"
            />
          </label>
          <p class="text-xs text-dimmed">
            Leave empty for a workspace owned by this chat. Files move only through an explicit
            transfer.
          </p>
        {/if}
        {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
      </form>
      <div class="mt-3 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm hover:bg-elevated"
          disabled={saving}
          onclick={() => (editor = false)}>Cancel</button
        >
        <button
          type="submit"
          form="oven-selection"
          data-modal-primary
          class="rounded-lg bg-primary px-4 py-2 text-sm text-on-primary"
          disabled={saving || busy}>{saving ? 'Selecting…' : 'Use Oven'}</button
        >
      </div>
    </div>
  {/if}
</div>

{#if workspace && settings.ovenId && settings.ovenId !== LOCAL_OVEN_ID}
  <OvenWorkspace
    open={workspace}
    ovenId={settings.ovenId}
    root={settings.ovenPath ?? ''}
    {thread}
    {ovens}
    onUseRoot={async (path) => {
      selected = settings.ovenId ?? LOCAL_OVEN_ID
      harness = settings.harnessId
      provider = settings.providerId
      model = settings.modelId
      root = path
      await select()
      if (error) throw new Error(error)
    }}
    onClose={() => (workspace = false)}
  />
{/if}
