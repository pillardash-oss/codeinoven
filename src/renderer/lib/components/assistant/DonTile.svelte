<script lang="ts">
  import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
  import type { Assistant } from '$shared/types'

  /**
   * Don, pinned as a square at the top of the assistant list.
   *
   * Don is not a row like the others: it is the one thread every conversation can
   * reach without opening the assistant view, so it holds a slot of its own above
   * the list. The tile is never draggable, never carries a menu that could rename,
   * delete or repin it, and its square shape is the app's own rule for a control
   * that is a place rather than an item.
   */
  interface Props {
    assistant: Assistant | null
    /** Don's one thread, absent only while the bootstrap has not seeded it yet. */
    threadId: string | null
    selected: boolean
    iconUrl?: string | null
    /** Whether Don can run at all: it needs instructions and a model like any assistant. */
    ready: boolean
    onOpen: () => void
  }

  let { assistant, threadId, selected, iconUrl = null, ready, onOpen }: Props = $props()

  const name = $derived(assistant?.name?.trim() || 'Don')
  const icon = $derived(assistant ? getAssistantIcon(assistant, iconUrl) : null)
  const color = $derived(assistant?.color)
</script>

<div class="border-b border-border px-2 py-2.5">
  <button
    type="button"
    class="flex w-full flex-col items-center gap-1.5 px-2 py-2.5 transition-colors {selected
      ? 'bg-elevated'
      : 'hover:bg-elevated/60'}"
    style={color ? `border-left: 2px solid ${color}` : ''}
    title={ready
      ? `Open ${name}, your orchestrator`
      : `${name} needs a model before it can take work`}
    aria-label={ready
      ? `Open ${name}, your orchestrator`
      : `${name} needs a model before it can take work`}
    aria-current={selected ? 'page' : undefined}
    disabled={threadId === null}
    onclick={onOpen}
  >
    <span class="flex size-12 items-center justify-center border border-border bg-surface">
      {#if icon}
        <img src={icon} alt="" aria-hidden="true" class="size-8 object-contain" />
      {:else}
        <AssistantDefaultIcon class="size-8" />
      {/if}
    </span>
    <span class="flex items-center gap-1 text-[0.75rem] font-medium text-foreground">
      {name}
      {#if !ready}
        <span
          class="size-1.5 bg-warning"
          title={`${name} has no model yet`}
          aria-label={`${name} has no model yet`}
        ></span>
      {/if}
    </span>
    <span class="text-[0.6875rem] leading-tight text-muted">
      {ready ? 'Orchestrator' : 'Needs a model'}
    </span>
  </button>
</div>
