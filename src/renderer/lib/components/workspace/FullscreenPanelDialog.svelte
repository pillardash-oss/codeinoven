<script lang="ts">
  import { Dialog } from 'bits-ui'
  import { Minimize2, Plus, X } from '@lucide/svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    tabs: { id: string; title: string }[]
    activeTabId: string | null
    newLabel: string
    minimizeLabel: string
    icon: Snippet
    onNew: () => void
    onMinimize: () => void
    onSelect: (id: string) => void
    onCloseTab: (id: string) => void
    children: Snippet
  }

  let {
    tabs,
    activeTabId,
    newLabel,
    minimizeLabel,
    icon,
    onNew,
    onMinimize,
    onSelect,
    onCloseTab,
    children
  }: Props = $props()

  let stripElement = $state<HTMLDivElement>()

  // Keep the active tab visible: whenever the active tab changes, scroll it
  // into view inside the strip so a newly opened or newly focused tab is
  // never hidden beyond the strip's scroll edge.
  $effect(() => {
    if (!activeTabId || !stripElement) return
    const activeButton = stripElement.querySelector<HTMLButtonElement>('[data-active="true"]')
    activeButton?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  })
</script>

<Dialog.Root open={true} onOpenChange={(open) => !open && onMinimize()}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-app shadow-xl"
      onEscapeKeydown={(event) => event.preventDefault()}
    >
      <div
        class="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3"
        style={trafficLightInsetStyle()}
      >
        <div
          bind:this={stripElement}
          class="titlebar-no-drag flex min-w-0 flex-1 overflow-x-auto"
        >
          <div class="ml-auto flex min-w-max items-center gap-1">
            {#each tabs as tab (tab.id)}
              <button
                type="button"
                data-active={tab.id === activeTabId ? 'true' : undefined}
                class="group flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[0.6875rem] font-medium transition-colors {tab.id ===
                activeTabId
                  ? 'bg-elevated text-foreground'
                  : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
                aria-current={tab.id === activeTabId ? 'page' : undefined}
                title={tab.title}
                onclick={() => onSelect(tab.id)}
              >
                {@render icon()}
                <span class="max-w-40 truncate">{tab.title}</span>
              </button>
              <button
                type="button"
                class="mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-dimmed opacity-70 transition-colors hover:bg-raised hover:text-foreground group-hover:opacity-100"
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
                onclick={() => onCloseTab(tab.id)}
              >
                <X size={10} />
              </button>
            {/each}
          </div>
        </div>
        <button
          type="button"
          class="titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={newLabel}
          title={newLabel}
          onclick={onNew}
        >
          <Plus size={14} />
        </button>
        <Dialog.Close
          class="titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={minimizeLabel}
          title={minimizeLabel}
          onclick={onMinimize}
        >
          <Minimize2 size={14} />
        </Dialog.Close>
      </div>
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
