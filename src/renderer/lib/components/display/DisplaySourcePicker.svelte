<script lang="ts">
  import { onMount } from 'svelte'
  import { contextSidebarState, type DisplayContextTab } from '$lib/stores/context-sidebar.svelte'
  import { displayPanel } from '$lib/stores/display-panel.svelte'
  import type { DisplaySourceDescriptor } from '$shared/ipc/display'
  import DisplaySourceIcon from './DisplaySourceIcon.svelte'

  /**
   * The chooser a display tab starts as.
   *
   * Every kind is listed whether or not it has anything to offer, because the
   * reason a list is empty is the useful part: no adb on the machine, no simulator
   * booted, or screen recording switched off. Picking a target turns this tab into
   * the tab that mirrors it, so the picker is the tab's own home rather than a
   * modal in front of one.
   */

  interface Props {
    tab: DisplayContextTab
  }

  let { tab }: Props = $props()

  let refreshing = $state(false)

  const anyLoading = $derived(displayPanel.sections.some((section) => section.loading))

  onMount(() => {
    displayPanel.refreshAll()
  })

  function refresh(): void {
    refreshing = true
    displayPanel.refreshAll()
    // The spinners are per section; this only keeps the button from looking dead
    // for the moment before the first listing answers.
    setTimeout(() => (refreshing = false), 400)
  }

  function pick(source: DisplaySourceDescriptor): void {
    contextSidebarState.applyDisplayTarget(tab.projectId, tab.threadId, tab.id, {
      kind: source.kind,
      sourceId: source.sourceId,
      label: source.label
    })
  }

  /** What an empty list means for each kind, in the user's terms. */
  function emptyCopy(kind: DisplaySourceDescriptor['kind']): string {
    if (kind === 'android') return 'No Android target is connected.'
    if (kind === 'ios') return 'No simulator is booted.'
    if (kind === 'desktop-screen') return 'No screen is available.'
    return 'No window is available.'
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#each displayPanel.sections as section (section.kind)}
      {@const sources = section.listing?.sources ?? []}
      <section class="border-b border-border last:border-b-0" aria-label={section.label}>
        <div class="flex items-baseline gap-2 px-3 pt-2.5 pb-1">
          <p
            class="min-w-0 flex-1 truncate text-[0.5625rem] font-semibold tracking-[0.14em] text-dimmed uppercase"
          >
            {section.label}
          </p>
          {#if section.loading}
            <span class="text-[0.5625rem] text-dimmed" role="status">Looking</span>
          {:else if sources.length > 0}
            <span class="text-[0.5625rem] text-dimmed">{sources.length}</span>
          {/if}
        </div>

        {#if section.loading && sources.length === 0}
          <p class="px-3 pb-2.5 text-[0.625rem] text-dimmed">Looking for targets…</p>
        {:else if section.listing?.problem}
          <p class="px-3 pb-2.5 text-[0.625rem] leading-relaxed text-warning">
            {section.listing.problem}
          </p>
        {:else if sources.length === 0}
          <p class="px-3 pb-2.5 text-[0.625rem] text-dimmed">{emptyCopy(section.kind)}</p>
        {:else}
          <div class="pb-1.5">
            {#each sources as source (source.sourceId)}
              <button
                type="button"
                class="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-elevated"
                title={`Mirror ${source.label}`}
                onclick={() => pick(source)}
              >
                <span
                  class="flex h-8 w-8 shrink-0 items-center justify-center border border-border bg-app text-muted transition-colors group-hover:border-primary group-hover:text-foreground"
                >
                  <DisplaySourceIcon kind={source.kind} size={17} />
                </span>
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate text-[0.6875rem] font-medium text-foreground"
                    >{source.label}</span
                  >
                  {#if source.detail}
                    <span class="truncate text-[0.625rem] text-dimmed">{source.detail}</span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>

  <div class="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1.5">
    <p class="min-w-0 truncate text-[0.625rem] text-dimmed">
      {anyLoading ? 'Looking for targets…' : 'Targets that are already running'}
    </p>
    <button
      type="button"
      class="shrink-0 px-2 py-0.5 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-60"
      aria-label="List targets again"
      title="List targets again"
      disabled={anyLoading || refreshing}
      onclick={refresh}
    >
      Refresh
    </button>
  </div>
</div>
