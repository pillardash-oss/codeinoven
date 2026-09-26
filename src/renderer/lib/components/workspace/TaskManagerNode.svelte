<script lang="ts">
  import { ChevronDown, ChevronRight, Cpu, MemoryStick } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import Switch from '$lib/components/ui/Switch.svelte'

  interface Props {
    /** Visible node name. */
    label: string
    /** Icon rendered before the label. */
    icon?: Snippet
    /** Muted secondary text after the label (e.g. the project a thread belongs to). */
    hint?: string | null
    /** Trailing count of the runtimes nested under this node. */
    count?: number | null
    /** Pre-formatted aggregate memory, rendered as `RAM <value>`. */
    memoryLabel?: string | null
    /** Pre-formatted aggregate CPU, rendered as `CPU <value>`. */
    cpuLabel?: string | null
    /** Whether the child runs are visible. */
    expanded: boolean
    /** Folds or unfolds the node. */
    ontoggle: () => void
    /**
     * When provided, a select-everything switch renders in the header. Omit it
     * for a node whose children are not selectable processes (Services).
     */
    switchChecked?: boolean
    switchLabel?: string
    onswitch?: () => void
    class?: string
    children?: Snippet
  }

  let {
    label,
    icon,
    hint = null,
    count = null,
    memoryLabel = null,
    cpuLabel = null,
    expanded,
    ontoggle,
    switchChecked = false,
    switchLabel,
    onswitch,
    class: className = '',
    children
  }: Props = $props()
</script>

<!-- A foldable tree node: one header row with the fold control, an optional
icon, the label and its aggregates, then an indented child wrapper with a guide
rule. Shared by the app root, every owner group, and the Services branch so the
task manager tree has one node contract instead of three. -->
<div class="w-full {className}">
  <div class="flex items-center gap-3 px-5 py-2">
    <button
      type="button"
      class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-elevated"
      aria-expanded={expanded}
      title="{expanded ? 'Collapse' : 'Expand'} {label}"
      aria-label="{expanded ? 'Collapse' : 'Expand'} {label}"
      onclick={ontoggle}
    >
      {#if expanded}
        <ChevronDown size={14} class="shrink-0 text-dimmed" />
      {:else}
        <ChevronRight size={14} class="shrink-0 text-dimmed" />
      {/if}
      {#if icon}
        {@render icon()}
      {/if}
      <span class="min-w-0 truncate text-xs font-semibold text-foreground">{label}</span>
      {#if hint}
        <span class="min-w-0 truncate text-[0.625rem] text-dimmed">· {hint}</span>
      {/if}
      {#if count !== null}
        <span class="shrink-0 text-[0.625rem] text-dimmed tabular-nums">{count}</span>
      {/if}
    </button>
    <span class="flex shrink-0 items-center gap-3">
      {#if memoryLabel}
        <span
          class="inline-flex items-center gap-1 text-[0.625rem] text-muted tabular-nums"
          title="Memory used by everything under {label}"
        >
          <MemoryStick size={11} aria-hidden="true" />
          {memoryLabel}
        </span>
      {/if}
      {#if cpuLabel}
        <span
          class="inline-flex items-center gap-1 text-[0.625rem] text-muted tabular-nums"
          title="CPU used by everything under {label}"
        >
          <Cpu size={11} aria-hidden="true" />
          {cpuLabel}
        </span>
      {/if}
      {#if onswitch}
        <Switch
          checked={switchChecked}
          onchange={onswitch}
          title={switchLabel}
          aria-label={switchLabel}
        />
      {/if}
    </span>
  </div>
  {#if expanded && children}
    <div class="ml-5 border-l border-border/70">
      {@render children()}
    </div>
  {/if}
</div>
