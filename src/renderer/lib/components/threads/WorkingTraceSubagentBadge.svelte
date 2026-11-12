<script lang="ts">
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import { DropdownMenu } from 'bits-ui'
  import { formatDurationSeconds } from '$lib/format/duration'
  import {
    subagentModelLabel,
    subagentTaskDetail,
    subagentTaskLabel
  } from '$lib/subagent-presentation'
  import type { SubagentPart } from '$lib/working-trace-parts'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { subagentVendorMark } from './subagent-session-view-helpers'
  import SubagentModeBadge from './SubagentModeBadge.svelte'
  import SubagentModelMark from './SubagentModelMark.svelte'
  import SubagentStatusIcon from './SubagentStatusIcon.svelte'

  interface Props {
    /** Touch devices get the bottom sheet instead of the hover dropdown. */
    coarsePointer: boolean
    title: string
    label: string
    subagentCount: number
    activeSubagentCount: number
    parts: SubagentPart[]
    /** Live duration of one worker, owned by the parent's shared clock. */
    elapsedFor: (part: SubagentPart) => number
    onOpen: (part: SubagentPart) => void
    onOpenSheet: () => void
  }

  let {
    coarsePointer,
    title,
    label,
    subagentCount,
    activeSubagentCount,
    parts,
    elapsedFor,
    onOpen,
    onOpenSheet
  }: Props = $props()

  /**
   * The model mark this badge wears in place of the generic sub-agent glyph.
   *
   * The badge stands for a whole group, so it only takes a worker's mark when
   * every worker in it runs on the same model: showing one model's logo over
   * several different workers would name the wrong thing. Otherwise it keeps
   * the sub-agent mark.
   */
  const providers = $derived(providerCatalog.allCached())
  /** The worker the badge stands for, when every worker in it wears one mark. */
  const groupActivity = $derived.by(() => {
    const first = parts[0]
    if (!first) return null
    const keyOf = (part: SubagentPart): string => {
      const mark = subagentVendorMark(part.activity, providers)
      return `${part.activity.harnessId ?? ''}\u0000${mark?.id ?? ''}\u0000${mark?.name ?? ''}`
    }
    const key = keyOf(first)
    return parts.every((part) => keyOf(part) === key) ? first.activity : null
  })
</script>

{#snippet modelMark(size: number, className?: string)}
  {#if groupActivity}
    <SubagentModelMark activity={groupActivity} {size} class={className ?? ''} />
  {:else}
    <CioSubagent {size} class={className ?? ''} />
  {/if}
{/snippet}

{#if coarsePointer}
  <button
    type="button"
    class="flex items-center gap-1 border border-border bg-dimmed/10 px-1.5 py-1 text-[0.5625rem] font-semibold tracking-wide text-muted uppercase transition-colors active:bg-dimmed/20"
    aria-label={title}
    {title}
    onclick={(e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onOpenSheet()
    }}
  >
    {@render modelMark(10)}
    {label}
  </button>
{:else}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex items-center gap-1 border border-border bg-dimmed/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-muted uppercase transition-colors hover:bg-dimmed/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-border"
      aria-label={title}
      {title}
      onclick={(e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {@render modelMark(10)}
      {label}
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        class="z-50 w-96 overflow-hidden border bg-surface p-1 shadow-lg"
      >
        <div class="flex items-center gap-1.5 px-2.5 py-1.5">
          {@render modelMark(12)}
          <span class="text-[0.6875rem] font-semibold text-foreground">
            {subagentCount}
            {subagentCount === 1 ? 'sub-agent' : 'sub-agents'}
          </span>
          {#if activeSubagentCount > 0}
            <span class="text-[0.625rem] text-dimmed">· {activeSubagentCount} running</span>
          {/if}
        </div>
        <DropdownMenu.Separator class="mx-1 my-1 h-px bg-border" />
        <div class="max-h-60 overflow-y-auto p-0.5">
          {#each parts as part (part.id)}
            {@const taskLabel = subagentTaskLabel(part.activity)}
            {@const taskDetail = subagentTaskDetail(part.activity)}
            {@const workerModel = subagentModelLabel(part.activity, true)}
            {@const workerMark = subagentVendorMark(part.activity, providers)}
            <DropdownMenu.Item
              class="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left outline-none transition-colors hover:bg-elevated focus:bg-elevated"
              onSelect={() => onOpen(part)}
            >
              <SubagentStatusIcon status={part.activity.status} />
              <span
                class="max-w-32 shrink-0 truncate text-[0.6875rem] font-semibold text-foreground"
                title={taskLabel}
              >
                {taskLabel}
              </span>
              {#if taskDetail}
                <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted">
                  {taskDetail}
                </span>
              {:else}
                <span class="min-w-0 flex-1"></span>
              {/if}
              <SubagentModeBadge background={part.activity.background} />
              {#if workerModel}
                <span
                  class="flex max-w-24 shrink-0 items-center gap-1 text-[0.625rem] text-dimmed"
                  title={part.activity.modelId ?? workerModel}
                >
                  {#if workerMark}
                    <VendorIcon name={workerMark.name} id={workerMark.id} size={11} />
                  {/if}
                  <span class="truncate">{workerModel}</span>
                </span>
              {/if}
              {#if part.activity.time?.start}
                <span class="shrink-0 tabular-nums text-[0.625rem] text-dimmed">
                  {formatDurationSeconds(elapsedFor(part))}
                </span>
              {/if}
            </DropdownMenu.Item>
          {/each}
        </div>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/if}
