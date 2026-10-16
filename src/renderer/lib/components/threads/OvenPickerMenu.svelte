<script lang="ts">
  import CioChevronDown from '$lib/components/icons/cio/CioChevronDown.svelte'
  import CioDisplay from '$lib/components/icons/cio/CioDisplay.svelte'
  import CioServer from '$lib/components/icons/cio/CioServer.svelte'
  import { onMount } from 'svelte'

  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { OvenProbe, OvenState } from '$shared/ovens'
  import { LOCAL_OVEN_ID, ovenHarnessIdForCommand } from '$shared/ovens'
  import PickerMenuShell from '../shared/PickerMenuShell.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { isTypeableKey } from '../shared/model-picker-helpers'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { getCustomSvgDataUrl } from '../../../../lib/custom-svg-tint'
  import { settingsUiState } from '$lib/stores/settings-ui.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'

  interface Props {
    /** Currently selected Oven id; `LOCAL_OVEN_ID` means this computer. */
    selectedId: string
    /** Currently selected workspace root on that Oven, when one is set. */
    selectedPath?: string
    busy?: boolean
    /** Button title, so each surface names its own action. */
    label: string
    /**
     * `chip` is the standalone badge with its own raised fill; `segment` is the
     * composer shoe's transparent segment, lit on hover. The shoe renders this
     * picker through `OvenControls`, which forwards the prop, so the variant is
     * declared here rather than sniffed out of context.
     */
    variant?: 'chip' | 'segment'
    /** Extra note rendered under the button when picking fails. */
    onSelect: (ovenId: string, ovenPath: string) => Promise<void> | void
  }
  let {
    selectedId,
    selectedPath,
    busy = false,
    label,
    onSelect,
    variant = 'chip'
  }: Props = $props()

  let ovens = $state.raw<OvenState | null>(null)
  let probes = $state<Record<string, OvenProbe>>({})
  let editor = $state(false)
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
  let current = $derived(ovens?.ovens.find((oven) => oven.id === selectedId))

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

  async function load(): Promise<void> {
    try {
      ovens = await invoke('oven:state')
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

  onMount(() => {
    void load()
  })

  /** Open the picker from a sibling control (the composer's Oven shoe). */
  export async function openPicker(): Promise<void> {
    if (busy || saving) return
    query = ''
    error = ''
    await load()
    editor = true
    void loadHarnessBadges(ovens?.ovens ?? [])
  }

  /**
   * Right-clicking the selected Oven opens Settings > Ovens on that Oven, so
   * the badge that names where a thread runs is also the way to edit it.
   * Local is not an editable Oven, so it only opens the page.
   */
  function openOvenSettings(event: MouseEvent): void {
    event.preventDefault()
    if (selectedId !== LOCAL_OVEN_ID) settingsUiState.focusOven(selectedId)
    workspaceState.navigateToSettings?.('ovens')
  }

  async function choose(ovenId: string): Promise<void> {
    saving = true
    error = ''
    try {
      const path = ovenId === selectedId ? (selectedPath ?? '') : ''
      await onSelect(ovenId, path)
      editor = false
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not select this Oven.'
    } finally {
      saving = false
    }
  }
</script>

<div
  class={variant === 'segment'
    ? 'relative flex min-w-0 shrink items-center'
    : 'relative flex items-center gap-1 text-xs text-muted'}
>
  <button
    type="button"
    class={variant === 'segment'
      ? 'group flex h-6 min-w-0 shrink items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50'
      : 'flex shrink-0 items-center gap-1 border border-border bg-raised px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-muted uppercase hover:bg-elevated disabled:opacity-50'}
    title={label}
    aria-haspopup="menu"
    aria-expanded={editor}
    disabled={busy || saving}
    onclick={() => void openPicker()}
    oncontextmenu={openOvenSettings}
  >
    {#if selectedId === LOCAL_OVEN_ID}
      <CioDisplay
        size={variant === 'segment' ? 12 : 10}
        class={variant === 'segment'
          ? 'shrink-0 text-dimmed transition-colors group-hover:text-foreground'
          : 'shrink-0'}
      />
    {:else if current}
      <img
        class={variant === 'segment'
          ? 'h-3 w-3 shrink-0 object-contain'
          : 'h-2.5 w-2.5 shrink-0 object-contain'}
        alt=""
        src={current.imageDataUrl ??
          (current.customSvg
            ? getCustomSvgDataUrl(current.customSvg, current.color)
            : getIconSvgDataUrl(current.icon, current.color))}
      />
    {:else}<CioServer
        size={variant === 'segment' ? 12 : 10}
        class={variant === 'segment'
          ? 'shrink-0 text-dimmed transition-colors group-hover:text-foreground'
          : 'shrink-0'}
      />{/if}<span class={variant === 'segment' ? 'oven-segment-label min-w-0 truncate' : undefined}
      >{current?.name ?? (selectedId !== LOCAL_OVEN_ID ? 'Oven unavailable' : 'Local')}</span
    >
    {#if variant === 'segment'}
      <span
        class="shrink-0 text-dimmed transition-transform duration-200 group-hover:text-foreground group-aria-expanded:rotate-180 group-aria-expanded:text-foreground"
      >
        <CioChevronDown size={11} />
      </span>
    {/if}
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
            aria-checked={oven.id === selectedId}
            data-oven-row={oven.id}
            onkeydown={(event) => rowKeydown(event, index)}
            class="mt-1 flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-elevated focus:bg-elevated focus:outline-none disabled:opacity-50"
            disabled={busy || saving}
            title={`Use ${oven.name}`}
            onclick={() => void choose(oven.id)}
          >
            {#if oven.id === LOCAL_OVEN_ID}
              <CioDisplay size={12} class="shrink-0" />
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
                      class="flex items-center bg-elevated p-0.5"
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
                    <span class="flex items-center bg-elevated p-0.5" title={entry.command}>
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
