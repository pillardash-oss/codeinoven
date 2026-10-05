<script lang="ts">
  import { Popover } from 'bits-ui'
  import { ChevronRight, Layers, ListFilter } from '@lucide/svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { activeModelProfile } from '$shared/model-profiles'
  import ModelPickerHarnessIcon from './ModelPickerHarnessIcon.svelte'
  import ModelPickerProfiles from './ModelPickerProfiles.svelte'
  import type {
    ModelPickerProfilesGroup,
    PickerHarnessFilterControls
  } from './model-picker-helpers'

  /**
   * The picker's side panel: one row that opens a panel beside the model picker.
   *
   * Profiles used to be drawn as a band inside the popover, so every saved profile
   * made the picker taller and the model list shorter. The panel gives them their
   * own surface instead: the picker keeps exactly one row for them, and both the
   * profiles and the harness filter scroll inside the panel.
   *
   * The panel is portaled beside the popover rather than nested in its markup.
   * bits-ui registers every open layer and lets only the topmost one answer an
   * outside interaction, so pointing inside the panel never dismisses the picker
   * behind it, while a click on a model row closes the panel and still reaches the
   * row underneath.
   */
  interface Props {
    /** Harness filter the panel hosts; null when the catalog holds one harness. */
    filter?: PickerHarnessFilterControls | null
    /** Profiles the panel lists; unset on a picker that has no profiles surface. */
    profiles?: ModelPickerProfilesGroup | null
  }

  let { filter = null, profiles = null }: Props = $props()

  let open = $state(false)
  /**
   * The preset currently in force, which only the row's title names.
   *
   * The composer's own controls show the settings a profile applied, so this is
   * what says which preset produced them without opening the panel.
   */
  let activeProfile = $derived(
    profiles ? activeModelProfile(profiles.profiles, profiles.settings) : null
  )
  let panelLabel = $derived(profiles ? 'Model profiles and harnesses' : 'Model harness filter')
  /**
   * Row label. A picker that has profiles names both surfaces it holds, because
   * the row is the only thing that says the harness filter is in there; a picker
   * without profiles names the filter's own scope instead.
   */
  let rowLabel = $derived(profiles ? 'Profiles & harnesses' : (filter?.label ?? ''))
  /**
   * Which preset is in force, named in the row's title only.
   *
   * The row is one line in a 240px picker, so it cannot carry the label, the
   * preset, and the filter state at once without truncating one of them away.
   * The profile's own row in the panel is ticked instead, and pointing at this
   * row names the preset.
   */
  let rowTitle = $derived(
    profiles
      ? activeProfile
        ? `${panelLabel}: ${activeProfile.name} is in force`
        : panelLabel
      : `Filter models by harness (${filter?.label ?? 'all harnesses'})`
  )

  /**
   * Geometry of the picker popover this row lives in.
   *
   * `height` is the picker's box and `rowTop` is where this row sits inside it.
   * The panel needs both because it is anchored to the row, which is a search row
   * below the picker's own top edge.
   */
  interface PickerHostBox {
    height: number
    rowTop: number
  }

  let hostBox = $state<PickerHostBox | null>(null)

  /**
   * Where the panel's middle belongs, measured from the row it opens from.
   *
   * Both shifts are done here rather than through the popover's own alignment:
   * bits-ui only applies an alignment offset to a placement that carries an
   * alignment, and this panel is anchored to the row, so its own box has to be
   * moved from the row's line onto the picker's. Half the picker's height up from
   * its top is the picker's middle; subtracting the row's offset converts that to
   * a distance from the row. A panel shorter than the picker is therefore centred
   * in the picker's band, and one whose content reaches the cap spans it exactly.
   */
  let panelTop = $derived(hostBox ? hostBox.height / 2 - hostBox.rowTop : null)

  /**
   * Watch the picker the row is rendered into, reporting its box on every resize.
   *
   * The row is the popover's anchor, so the picker's element is its nearest
   * `[data-popover-content]` ancestor. Its height is watched because the model
   * list can shrink under an open panel (the harness filter lives in the panel
   * and narrows that list), and the panel has to follow it.
   */
  function watchPickerHost(row: HTMLElement): () => void {
    const picker = row.closest('[data-popover-content]')
    const trigger = row.querySelector('[data-popover-trigger]')
    if (!(picker instanceof HTMLElement) || !(trigger instanceof HTMLElement)) return () => {}

    const measure = (): void => {
      const pickerRect = picker.getBoundingClientRect()
      const rowRect = trigger.getBoundingClientRect()
      hostBox = { height: pickerRect.height, rowTop: rowRect.top - pickerRect.top }
    }

    const observer = new ResizeObserver(measure)
    observer.observe(picker)
    measure()
    return () => observer.disconnect()
  }
</script>

{#if profiles || filter}
  <div class="border-b px-2.5 py-1.5" {@attach watchPickerHost}>
    <Popover.Root bind:open>
      <Popover.Trigger
        class="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title={rowTitle}
        aria-label={rowTitle}
      >
        {#if profiles}
          <Layers size={11} class="shrink-0" />
        {:else}
          <ListFilter size={11} class="shrink-0" />
        {/if}
        <span class="min-w-0 flex-auto truncate">{rowLabel}</span>
        <span class="ml-auto flex shrink-0 items-center gap-1.5">
          {#if filter?.active}
            <!--
              The filter itself lives in the panel, so the picker keeps saying the
              model list is narrowed while it is. A glyph and a count rather than
              the filter's own label, which would push this row's text past the
              row's width in the app's font. The full sentence is on the title,
              and the panel shows the selection in full.
            -->
            <span
              class="flex items-center gap-1 rounded bg-raised px-1 py-px text-[0.5625rem] font-medium text-primary"
              title={`Model list narrowed to ${filter.label}`}
            >
              <ListFilter size={10} />
              {filter.selected.size}
            </span>
          {/if}
          <ChevronRight size={11} class="text-dimmed" />
        </span>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={12}
          collisionPadding={12}
          class="z-90 h-0 w-72"
        >
          <!--
            The panel hangs from the content's top edge instead of forming it.

            The content is the floating element's child, so giving it the panel's
            own height would make the floating wrapper cover the strip the panel
            leaves empty above itself whenever it is the shorter of the two
            surfaces. A zero-height content has no hit area of its own, and the
            panel centres itself in the picker's band purely in CSS: `top` puts
            its middle on the picker's middle, and the cap keeps it inside the
            band, so at full height it spans the picker exactly.
          -->
          <div
            class="absolute inset-x-0 flex flex-col overflow-hidden rounded-xl border bg-surface shadow-lg {hostBox
              ? ''
              : 'max-h-80'}"
            role="dialog"
            aria-label={panelLabel}
            tabindex={-1}
            style:top={panelTop === null ? '0' : `${panelTop}px`}
            style:translate={panelTop === null ? '0' : '0 -50%'}
            style:max-height={hostBox ? `${hostBox.height}px` : undefined}
            onkeydown={(event: KeyboardEvent) => {
              // Closes the panel, never the picker it belongs to: the picker's own
              // content is never an ancestor of this portal, so nothing else in the
              // composer sees the key.
              if (keymapState.matches('palette-close', event)) open = false
            }}
          >
            {#if profiles}
              <ModelPickerProfiles {...profiles} />
            {/if}

            {#if filter}
              {@render harnessFilterSection()}
            {/if}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>
{/if}

<!--
  The harness filter, drawn below the profiles list, or as the whole panel when a
  picker has no profiles surface.

  No heading: the row that opens the panel already names what the chips filter,
  and the chips themselves are sized to fit several per row, because choosing a
  harness is worth one line rather than three. The divider is drawn only when
  there are profile rows above, so a picker without profiles does not end up with
  a second line at the panel's own border.
-->
{#snippet harnessFilterSection()}
  {#if filter}
    <div class="shrink-0 px-2 py-1.5 {profiles ? 'border-t' : ''}">
      <div
        class="flex max-h-24 flex-wrap gap-1 overflow-y-auto"
        role="group"
        aria-label="Filter models by harness"
      >
        <button
          type="button"
          class="flex h-6 items-center gap-1 rounded-md border px-2 text-[0.625rem] font-medium transition-colors {!filter.active
            ? 'border-primary bg-primary text-on-primary'
            : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
          aria-pressed={!filter.active}
          title="Show every harness"
          onclick={filter.onClear}
        >
          <ListFilter size={10} class="shrink-0" />
          All
        </button>
        {#each filter.options as option (option.id)}
          <button
            type="button"
            class="flex h-6 items-center gap-1 rounded-md border px-2 text-[0.625rem] font-medium transition-colors {filter.selected.has(
              option.id
            )
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={filter.selected.has(option.id)}
            title={`Show only ${option.name} models`}
            onclick={() => filter.onToggle(option.id)}
          >
            <ModelPickerHarnessIcon harnessId={option.id} />
            <span class="truncate">{option.name}</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}
