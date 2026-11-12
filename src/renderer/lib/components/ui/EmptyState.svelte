<script lang="ts">
  import type { Component, Snippet } from 'svelte'

  interface Props {
    /** Optional leading icon component (lucide icon). */
    icon?: Component
    /**
     * Optional art in place of the icon tile.
     *
     * A surface that has something more specific to say than "nothing here" draws
     * it itself: the assistant panel shows the open seat a teammate would take,
     * so the empty column reads as a list with room in it rather than a warning.
     */
    visual?: Snippet
    /** Short heading for the empty state. */
    title: string
    /** Optional explanation of why the surface is empty. */
    description?: string
    /** Optional single concrete next action rendered below the copy. */
    action?: Snippet
    class?: string
  }

  let { icon: Icon, visual, title, description, action, class: className = '' }: Props = $props()
</script>

<div
  class="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 py-8 text-center {className}"
>
  {#if visual}
    {@render visual()}
  {:else if Icon}
    <div class="flex h-10 w-10 items-center justify-center bg-elevated">
      <Icon size={18} class="text-dimmed" />
    </div>
  {/if}
  <p class="text-[0.6875rem] font-semibold text-foreground">{title}</p>
  {#if description}
    <p class="max-w-[36ch] text-[0.625rem] leading-relaxed text-muted">{description}</p>
  {/if}
  {#if action}
    <div class="mt-1">{@render action()}</div>
  {/if}
</div>
