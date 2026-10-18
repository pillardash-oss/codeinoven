<script lang="ts">
  import CioSubagent from '@pillardash-oss/cio-icon/CioSubagent.svelte'
  import { DropdownMenu } from 'bits-ui'
  import { formatDurationSeconds } from '$lib/format/duration'
  import {
    subagentModelLabel,
    subagentTaskDetail,
    subagentTaskLabel
  } from '$lib/subagent-presentation'
  import type { SubagentPart } from '$lib/working-trace-parts'
  import SubagentModeBadge from './SubagentModeBadge.svelte'
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
</script>

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
    <CioSubagent size={10} />
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
      <CioSubagent size={10} />
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
          <CioSubagent size={12} class="shrink-0 text-muted" />
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
                  class="max-w-24 shrink-0 truncate text-[0.625rem] text-dimmed"
                  title={part.activity.modelId ?? workerModel}
                >
                  {workerModel}
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
