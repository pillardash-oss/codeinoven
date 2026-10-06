<script lang="ts">
  import { onMount } from 'svelte'
  import { Server, Monitor } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { Thread, ThreadSettings } from '$shared/types'
  import type { OvenProbe, OvenState } from '$shared/ovens'
  import { LOCAL_OVEN_ID, ovenHarnessIdForCommand } from '$shared/ovens'
  import PickerMenuShell from '../shared/PickerMenuShell.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { isTypeableKey } from '../shared/model-picker-helpers'
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
  let probes = $state<Record<string, OvenProbe>>({})
  let editor = $state(false)
  let selected = $state(LOCAL_OVEN_ID)
  let root = $state('')
  let saving = $state(false)
  let error = $state('')
  let query = $state('')
  let menuEl: HTMLDivElement | undefined = $state(undefined)
  let searchInput: HTMLInputElement | undefined
  let visibleOvens = $derived(
    (ovens?.ovens ?? []).filter((oven) =>
      oven.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    )
  )
  function rowKeydown(event: KeyboardEvent, index: number): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(
        0,
        Math.min(visibleOvens.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))
      )
      menuEl?.querySelectorAll<HTMLButtonElement>('[data-oven-row]')[next]?.focus()
    } else if (keymapState.matches('palette-close', event)) {
      event.stopPropagation()
      editor = false
    } else if (isTypeableKey(event)) {
      event.preventDefault()
      query += event.key
      searchInput?.focus()
    }
  }

  let current = $derived(
    ovens?.ovens.find((oven) => oven.id === (settings.ovenId ?? LOCAL_OVEN_ID))
  )

  onMount(() => {
    void invoke('oven:state')
      .then((result) => {
        ovens = result
        if (!settings.ovenId && !thread.sessionId && thread.status === 'created') {
          onSettingsChange({ ...settings, ovenId: LOCAL_OVEN_ID, ovenPath: undefined })
        }
      })
      .catch(
        (failure: unknown) =>
          (error = failure instanceof Error ? failure.message : 'Could not load Ovens.')
      )
  })

  export async function openPicker(): Promise<void> {
    if (busy || saving) return
    query = ''
    selected = settings.ovenId ?? LOCAL_OVEN_ID
    root = settings.ovenPath ?? ''
    error = ''
    try {
      ovens = await invoke('oven:state')
      editor = true
      void loadHarnessBadges(ovens.ovens)
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not load Ovens.'
    }
  }

  async function loadHarnessBadges(entries: OvenState['ovens']): Promise<void> {
    for (const oven of entries) {
      if (oven.kind !== 'ssh' || probes[oven.id]) continue
      try {
        probes = { ...probes, [oven.id]: await invoke('oven:probe', oven.id) }
      } catch {
        // A disconnected oven simply has no current inventory badge.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 80))
    }
  }

  async function select(): Promise<void> {
    saving = true
    error = ''
    try {
      await invoke('thread:updateSettings', thread.projectId, thread.id, settings)
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
    class="flex shrink-0 items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted hover:bg-elevated disabled:opacity-50"
    style="border-radius: 0.375rem !important"
    title="Choose the Oven for this chat"
    aria-haspopup="menu"
    aria-expanded={editor}
    disabled={busy || saving}
    onclick={() => void openPicker()}
  >
    {#if (settings.ovenId ?? LOCAL_OVEN_ID) === LOCAL_OVEN_ID}
      <Monitor size={10} class="shrink-0" />
    {:else if current}
      <img
        class="h-2.5 w-2.5 shrink-0 object-contain"
        alt=""
        src={current.imageDataUrl ??
          (current.customSvg
            ? getCustomSvgDataUrl(current.customSvg, current.color)
            : getIconSvgDataUrl(current.icon, current.color))}
      />
    {:else}<Server size={10} class="shrink-0" />{/if}<span
      >{current?.name ??
        (settings.ovenId && settings.ovenId !== LOCAL_OVEN_ID ? 'Oven unavailable' : 'Local')}</span
    >
  </button>
  {#if error && !editor}<span class="text-danger" role="alert">{error}</span>{/if}

  {#if editor}
    <button
      type="button"
      class="fixed inset-0 z-30 cursor-default"
      title="Close Oven picker"
      aria-label="Close Oven picker"
      onclick={() => (editor = false)}
    ></button>
    <div class="absolute bottom-full right-0 z-40 mb-1.5">
      <PickerMenuShell
        bind:query
        bind:menuEl
        label="Choose Oven"
        placeholder="Search Ovens…"
        autofocusSearch
        onSearchInput={(input) => (searchInput = input)}
        onSearchKeydown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            menuEl?.querySelector<HTMLButtonElement>('[data-oven-row]')?.focus()
          }
          if (keymapState.matches('palette-close', event)) {
            event.stopPropagation()
            editor = false
          }
        }}
      >
        {#each visibleOvens as oven, index (oven.id)}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={oven.id === (settings.ovenId ?? LOCAL_OVEN_ID)}
            data-oven-row={oven.id}
            onkeydown={(event) => rowKeydown(event, index)}
            class="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-elevated focus:bg-elevated focus:outline-none disabled:opacity-50"
            disabled={busy || saving}
            title={`Use ${oven.name}`}
            onclick={() => {
              root = oven.id === settings.ovenId ? (settings.ovenPath ?? '') : ''
              selected = oven.id
              void select()
            }}
          >
            {#if oven.id === LOCAL_OVEN_ID}
              <Monitor size={12} class="shrink-0" />
            {:else}<img
                class="h-3 w-3 shrink-0"
                alt=""
                src={oven.imageDataUrl ??
                  (oven.customSvg
                    ? getCustomSvgDataUrl(oven.customSvg, oven.color)
                    : getIconSvgDataUrl(oven.icon, oven.color))}
              />{/if}
            <span class="min-w-0 flex-1 truncate">{oven.name}</span>
            <span class="shrink-0 text-[0.625rem] text-dimmed"
              >{oven.id === LOCAL_OVEN_ID ? 'Local' : 'SSH'}</span
            >
            {#if oven.kind === 'ssh' && probes[oven.id]}
              {@const inventory = probes[oven.id].inventory?.filter(
                (item) => item.health !== 'missing'
              )}
              <span class="flex shrink-0 items-center gap-1" aria-label="Installed harnesses">
                {#if inventory?.length}
                  {#each inventory.slice(0, 4) as item (item.harnessId)}
                    <span
                      class="flex items-center rounded bg-elevated p-0.5"
                      title={item.installedVersion
                        ? `${item.command} ${item.installedVersion}`
                        : item.command}
                    >
                      <AgentIcon agentId={item.harnessId} label={item.command} size={14} />
                    </span>
                  {/each}
                {:else if probes[oven.id].harnesses.some((entry) => entry.path)}
                  {#each probes[oven.id].harnesses
                    .filter((entry) => entry.path)
                    .slice(0, 4) as entry (entry.command)}
                    <span class="flex items-center rounded bg-elevated p-0.5" title={entry.command}>
                      <AgentIcon
                        agentId={ovenHarnessIdForCommand(entry.command) ?? entry.command}
                        label={entry.command}
                        size={14}
                      />
                    </span>
                  {/each}
                {:else}
                  <span class="text-[0.625rem] text-dimmed">No harnesses</span>
                {/if}
              </span>
            {/if}
          </button>
        {/each}
        {#if !visibleOvens.length}<p class="px-2.5 py-2 text-xs text-dimmed">
            No matching Ovens.
          </p>{/if}
        {#if error}<p class="px-2.5 py-2 text-xs text-danger" role="alert">{error}</p>{/if}
      </PickerMenuShell>
    </div>
  {/if}
</div>
