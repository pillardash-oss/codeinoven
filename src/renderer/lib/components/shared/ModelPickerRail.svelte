<script lang="ts">
  import { Layers, LayoutGrid, Star } from '@lucide/svelte'
  import RailHighlight from '../layout/RailHighlight.svelte'
  import ModelPickerHarnessIcon from './ModelPickerHarnessIcon.svelte'
  import type { PickerHarnessOption, PickerRailView } from './model-picker-helpers'

  interface Props {
    view: PickerRailView
    showFavorites: boolean
    showProfiles: boolean
    harnessOptions: readonly PickerHarnessOption[]
    showHarnesses: boolean
    onSelect: (view: PickerRailView) => void
  }

  let { view, showFavorites, showProfiles, harnessOptions, showHarnesses, onSelect }: Props =
    $props()

  function isActive(kind: PickerRailView['kind'], harnessId?: string): boolean {
    if (view.kind !== kind) return false
    if (kind === 'harness') return view.kind === 'harness' && view.harnessId === harnessId
    return true
  }

  function revisionKey(): string {
    const harnessPart = view.kind === 'harness' ? `harness:${view.harnessId}` : view.kind
    return `${harnessPart}|${showFavorites}|${showProfiles}|${harnessOptions.map((option) => option.id).join(',')}`
  }

  function buttonClass(active: boolean, disabled = false): string {
    return `relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg outline-none transition-colors duration-150 focus-visible:outline-none ${
      active ? 'text-foreground' : 'text-muted hover:bg-elevated hover:text-foreground'
    } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`
  }
</script>

<!--
  Icon-only rail for the model picker. Same height as the picker popover: the
  parent lays this beside the list column in one flex row, so this stretches
  while only its harness section scrolls. Active state mirrors the app view rail
  (shared elevated surface + brightened glyph + `aria-current`).
-->
<nav
  class="relative flex min-h-0 w-10 shrink-0 flex-col items-center gap-0.5 self-stretch border-r border-border py-2"
  aria-label="Model picker sections"
>
  <RailHighlight revision={revisionKey()} currentValue="true" accentSide="right" />

  <button
    type="button"
    class={buttonClass(isActive('all'))}
    aria-label="Show all models"
    title="Show all models"
    aria-current={isActive('all') ? 'true' : undefined}
    onclick={() => onSelect({ kind: 'all' })}
  >
    <LayoutGrid size={16} strokeWidth={1.8} />
  </button>

  {#if showFavorites}
    <button
      type="button"
      class={buttonClass(isActive('favorites'))}
      aria-label="Show favorite models only"
      title="Show favorite models only"
      aria-current={isActive('favorites') ? 'true' : undefined}
      onclick={() => onSelect({ kind: 'favorites' })}
    >
      <Star size={16} strokeWidth={1.8} />
    </button>
  {/if}

  {#if showProfiles}
    <button
      type="button"
      class={buttonClass(isActive('profiles'))}
      aria-label="Show model profiles"
      title="Show model profiles"
      aria-current={isActive('profiles') ? 'true' : undefined}
      onclick={() => onSelect({ kind: 'profiles' })}
    >
      <Layers size={16} strokeWidth={1.8} />
    </button>
  {/if}

  {#if showHarnesses}
    <div class="mx-1 my-1 w-6 shrink-0 border-t border-border"></div>
    <div
      class="flex max-h-[8.25rem] min-h-0 shrink flex-col items-center gap-0.5 overflow-y-auto"
      role="group"
      aria-label="Show one harness"
    >
      {#each harnessOptions as option (option.id)}
        {@const active = isActive('harness', option.id)}
        {@const disabled = option.unavailable === true}
        <button
          type="button"
          class={buttonClass(active, disabled)}
          aria-label={disabled
            ? `${option.name} is unavailable here`
            : `Show only ${option.name} models`}
          title={disabled
            ? (option.reason ?? `${option.name} is not installed on this Oven`)
            : `Show only ${option.name} models`}
          aria-current={active ? 'true' : undefined}
          {disabled}
          onclick={() => onSelect({ kind: 'harness', harnessId: option.id })}
        >
          <ModelPickerHarnessIcon harnessId={option.id} size={16} />
        </button>
      {/each}
    </div>
  {/if}
</nav>
