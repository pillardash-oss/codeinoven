<script lang="ts">
  import { Dialog } from 'bits-ui'
  import { Maximize2, Minimize2, Plus, X } from '@lucide/svelte'
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
        <div class="titlebar-no-drag flex w-4/5 min-w-0 shrink-0 overflow-x-auto">
          <div class="ml-auto flex min-w-max items-center gap-1">
            {#each tabs as tab (tab.id)}
              <button
                type="button"
                class="group flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors {tab.id ===
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
