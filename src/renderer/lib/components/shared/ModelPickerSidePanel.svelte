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
</script>

{#if profiles || filter}
  <div class="border-b px-2.5 py-1.5">
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
          class="z-90 flex max-h-80 w-72 flex-col overflow-hidden rounded-xl border bg-surface shadow-lg"
          role="dialog"
          aria-label={panelLabel}
          tabindex={-1}
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
            <!-- Only divided from the profiles when there are profiles above it:
                 a lone harness section would otherwise draw a second line right
                 under the panel's own border. -->
            <div class="shrink-0 px-2.5 py-2 {profiles ? 'border-t' : ''}">
              <div
                class="px-1 pb-1.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
              >
                Filter models by harness
              </div>
              <div
                class="flex max-h-24 flex-wrap gap-1 overflow-y-auto"
                role="group"
                aria-label="Filter models by harness"
              >
                <button
                  type="button"
                  class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {!filter.active
                    ? 'border-primary bg-primary text-on-primary'
                    : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
                  aria-pressed={!filter.active}
                  title="Show every harness"
                  onclick={filter.onClear}
                >
                  <ListFilter size={11} class="shrink-0" />
                  All
                </button>
                {#each filter.options as option (option.id)}
                  <button
                    type="button"
                    class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {filter.selected.has(
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>
{/if}
