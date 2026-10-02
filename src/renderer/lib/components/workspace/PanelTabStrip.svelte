<script lang="ts">
  import { Plus, X } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import { browserTabIndicatorSlotClass } from '$lib/stores/browser-tab-status'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'

  interface PanelTab {
    id: string
    title: string
    indicatorCount?: number
  }

  interface Props {
    tabs: PanelTab[]
    activeTabId: string | null
    trailingLabel: string
    trailingIcon: Snippet
    onTrailingAction: () => void
    onSelect: (id: string) => void
    newLabel?: string
    icon?: Snippet
    tabIcon?: Snippet<[{ id: string; title: string }]>
    tabIndicator?: Snippet<[{ id: string; title: string }]>
    actions?: Snippet
    onNew?: () => void
    onCloseTab?: (id: string) => void
    onTabContextMenu?: (id: string, event: MouseEvent) => void
    titlebar?: boolean
  }

  let {
    tabs,
    activeTabId,
    trailingLabel,
    trailingIcon,
    onTrailingAction,
    onSelect,
    newLabel,
    icon,
    tabIcon,
    tabIndicator,
    actions,
    onNew,
    onCloseTab,
    onTabContextMenu,
    titlebar = false
  }: Props = $props()

  let stripElement = $state<HTMLDivElement>()

  $effect(() => {
    if (!activeTabId || !stripElement) return
    const activeButton = stripElement.querySelector<HTMLButtonElement>('[data-active="true"]')
    activeButton?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  })
</script>

<div
  class={titlebar
    ? 'titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3'
    : 'flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-2'}
  style={titlebar ? trafficLightInsetStyle() : undefined}
>
  <div
    bind:this={stripElement}
    class={titlebar
      ? 'titlebar-no-drag flex min-w-0 flex-1 overflow-x-auto'
      : 'flex min-w-0 flex-1 overflow-x-auto'}
  >
    <div class={titlebar ? 'ml-auto flex min-w-max items-center gap-1' : 'flex min-w-max items-center gap-1'}>
      {#each tabs as tab (tab.id)}
        {@const indicatorCount = tabIndicator ? (tab.indicatorCount ?? 0) : 0}
        <div class="relative flex shrink-0 items-center">
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
            oncontextmenu={(event) => {
              if (!onTabContextMenu) return
              event.preventDefault()
              onTabContextMenu(tab.id, event)
            }}
          >
            {#if indicatorCount > 0}
              <span
                class="shrink-0 {browserTabIndicatorSlotClass(indicatorCount)}"
                aria-hidden="true"
              ></span>
            {:else if tabIcon}
              {@render tabIcon({ id: tab.id, title: tab.title })}
            {:else if icon}
              {@render icon()}
            {/if}
            <span class="max-w-40 truncate">{tab.title}</span>
          </button>
          {#if onCloseTab}
            <button
              type="button"
              class="mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-dimmed opacity-70 transition-colors hover:bg-raised hover:text-foreground group-hover:opacity-100"
              aria-label={`Close ${tab.title}`}
              title={`Close ${tab.title}`}
              onclick={() => onCloseTab(tab.id)}
            >
              <X size={10} />
            </button>
          {/if}
          {#if indicatorCount > 0 && tabIndicator}
            <div
              class="absolute left-1.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5"
            >
              {@render tabIndicator({ id: tab.id, title: tab.title })}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  {#if actions}
    <div class={titlebar ? 'titlebar-no-drag flex shrink-0 items-center gap-1' : 'flex shrink-0 items-center gap-1'}>
      {@render actions()}
    </div>
  {/if}

  {#if onNew && newLabel}
    <button
      type="button"
      class={titlebar
        ? 'titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground'
        : 'flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground'}
      aria-label={newLabel}
      title={newLabel}
      onclick={onNew}
    >
      <Plus size={14} />
    </button>
  {/if}

  <button
    type="button"
    class={titlebar
      ? 'titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground'
      : 'flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground'}
    aria-label={trailingLabel}
    title={trailingLabel}
    onclick={onTrailingAction}
  >
    {@render trailingIcon()}
  </button>
</div>
