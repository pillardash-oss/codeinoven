<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioServer from '@pdslng/cio-icon/CioServer.svelte'
  import { DropdownMenu } from 'bits-ui'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { ovenMarkUrl } from '$lib/stores/ovens.svelte'
  import { LOCAL_OVEN_ID, type Oven, type OvenState } from '$shared/ovens'

  /**
   * The machine a confirmed agent handoff runs on.
   *
   * A portaled menu rather than the composer's inline Oven picker: this field
   * lives in a scrolling modal body, and an inline popover would be clipped by
   * the panel instead of drawn over it.
   */
  interface Props {
    value: string
    onSelect: (ovenId: string) => void
  }

  let { value, onSelect }: Props = $props()

  let registry = $state.raw<OvenState | null>(null)
  let current = $derived(registry?.ovens.find((oven) => oven.id === value) ?? null)
  /** Local always leads; remote Ovens keep the registry's order. */
  let choices = $derived<Oven[]>(registry?.ovens ?? [])

  onMount(async () => {
    try {
      registry = await invoke('oven:state')
    } catch {
      // A registry that cannot be read leaves the current choice in place; the
      // dialog still names it from its own value.
    }
  })
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex w-full min-w-0 items-center gap-2 border bg-elevated px-3 py-2 text-left transition-colors hover:bg-overlay"
    title="Choose the Oven the agent runs on"
    aria-label="Choose the Oven the agent runs on"
  >
    {#if value === LOCAL_OVEN_ID}
      <CioDisplay size={13} class="shrink-0" />
    {:else if current && ovenMarkUrl(current)}
      <img class="h-3.5 w-3.5 shrink-0 object-contain" alt="" src={ovenMarkUrl(current)} />
    {:else}
      <CioServer size={13} class="shrink-0 text-muted" />
    {/if}
    <span class="min-w-0 flex-1 truncate text-xs text-foreground">
      {value === LOCAL_OVEN_ID ? 'Local' : (current?.name ?? 'Oven unavailable')}
    </span>
    <span class="shrink-0 text-[0.625rem] text-dimmed"
      >{value === LOCAL_OVEN_ID ? 'This computer' : 'Remote'}</span
    >
    <CioChevronDown size={11} class="shrink-0 text-dimmed" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      class="z-90 max-h-72 w-[var(--bits-floating-anchor-width)] overflow-y-auto border bg-surface p-1 shadow-lg"
    >
      {#each choices as oven (oven.id)}
        <DropdownMenu.Item
          class="flex cursor-pointer items-center gap-2 px-2.5 py-2 text-xs text-foreground outline-none data-highlighted:bg-elevated"
          title={`Use ${oven.name}`}
          onSelect={() => onSelect(oven.id)}
        >
          {#if oven.id === LOCAL_OVEN_ID}
            <CioDisplay size={12} class="shrink-0" />
          {:else if ovenMarkUrl(oven)}
            <img class="h-3.5 w-3.5 shrink-0" alt="" src={ovenMarkUrl(oven)} />
          {:else}
            <CioServer size={12} class="shrink-0 text-muted" />
          {/if}
          <span class="min-w-0 flex-1 truncate">{oven.name}</span>
          {#if oven.id === value}<span class="shrink-0 text-[0.625rem] text-primary">Selected</span
            >{/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
