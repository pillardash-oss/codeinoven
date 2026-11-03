<script lang="ts">
  import { onMount } from 'svelte'
  import { contextSidebarState, type DisplayContextTab } from '$lib/stores/context-sidebar.svelte'
  import { displayPanel } from '$lib/stores/display-panel.svelte'
  import type { DisplaySourceDescriptor, DisplaySourceKind } from '$shared/ipc/display'
  import DisplaySourceIcon from './DisplaySourceIcon.svelte'

  /**
   * The chooser a display tab starts as.
   *
   * Every kind is listed whether or not it has anything to offer, because the
   * reason a list is empty is the useful part: no adb on the machine, no simulator
   * booted, or screen recording switched off. Picking a target turns this tab into
   * the tab that mirrors it, so the picker is the tab's own home rather than a
   * modal in front of one.
   *
   * The list is the cloud deployment panel's own list: a section header carrying
   * the kind's mark and its count, then one divided row per target with a name and
   * a supporting line. No second heading, no expanded label, nothing that repeats
   * the tab's own name.
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
    // The loading state is per section; this only keeps the control from looking
    // dead in the moment before the first listing answers.
    setTimeout(() => (refreshing = false), 400)
  }

  function pick(source: DisplaySourceDescriptor): void {
    contextSidebarState.applyDisplayTarget(tab.projectId, tab.threadId, tab.id, {
      kind: source.kind,
      sourceId: source.sourceId,
      label: source.label,
      ...(source.iconUrl ? { iconUrl: source.iconUrl } : {})
    })
  }

  /** What an empty list means for each kind, in the user's terms. */
  function emptyCopy(kind: DisplaySourceKind): string {
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
      <section class="border-b border-border" aria-label={section.label}>
        <div class="flex items-center gap-1.5 bg-surface px-3 py-1.5">
          <DisplaySourceIcon kind={section.kind} size={10} class="shrink-0 text-dimmed" />
          <h3 class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
            {section.label}
          </h3>
          {#if section.loading}
            <span class="ml-auto text-[0.5625rem] text-dimmed" role="status">Looking</span>
          {:else}
            <span class="ml-auto text-[0.5625rem] tabular-nums text-dimmed">{sources.length}</span>
          {/if}
        </div>

        {#if section.listing?.problem}
          <p
            class="border-t border-border px-3 py-1.5 text-[0.5625rem] leading-relaxed text-warning"
          >
            {section.listing.problem}
          </p>
        {:else if sources.length === 0}
          <p class="border-t border-border px-3 py-1.5 text-[0.5625rem] text-dimmed">
            {section.loading ? 'Looking for targets…' : emptyCopy(section.kind)}
          </p>
        {:else}
          <div class="divide-y divide-border">
            {#each sources as source (source.sourceId)}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-elevated"
                title="Mirror {source.label}"
                aria-label="Mirror {source.label}"
                onclick={() => pick(source)}
              >
                <!-- A window wears the icon of the application it belongs to, the
                     way the dock does for a running app. A screen keeps the kind's
                     own mark, because no application owns it. -->
                {#if source.iconUrl}
                  <img
                    src={source.iconUrl}
                    alt=""
                    class="h-4 w-4 shrink-0 object-contain"
                    aria-hidden="true"
                  />
                {:else}
                  <DisplaySourceIcon kind={source.kind} size={13} class="shrink-0 text-dimmed" />
                {/if}
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate text-[0.6875rem] font-medium text-foreground">
                    {source.label}
                  </span>
                  {#if source.detail}
                    <span class="truncate text-[0.5625rem] text-dimmed">{source.detail}</span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>

  <div class="flex shrink-0 items-center justify-end border-t border-border px-2 py-1">
    <button
      type="button"
      class="cursor-pointer px-2 py-0.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-60"
      aria-label="List targets again"
      title="List targets again"
      disabled={anyLoading || refreshing}
      onclick={refresh}
    >
      Refresh
    </button>
  </div>
</div>
