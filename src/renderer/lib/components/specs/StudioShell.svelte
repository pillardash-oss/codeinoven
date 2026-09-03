<script module lang="ts">
  export interface StudioShellSectionBadge {
    count: number
    tone: 'info' | 'danger'
    label: string
  }

  export interface StudioShellSection<SectionId extends string = string> {
    id: SectionId
    title: string
    badges?: StudioShellSectionBadge[]
  }
</script>

<script lang="ts" generics="SectionId extends string, Annotation extends { id: string; quote?: string; body: string }">
  import { tick } from 'svelte'
  import { X } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import StudioSidebarResizeHandle from './StudioSidebarResizeHandle.svelte'

  interface Props {
    ariaLabel: string
    scrollerLabel: string
    sidebarTitle: string
    sidebarLabel: string
    /** Sections anchor to elements with id `${sectionAnchorPrefix}-${sectionId}`. */
    sectionAnchorPrefix: string
    sections: StudioShellSection<SectionId>[]
    selectedSection: SectionId
    sectionsOpen: boolean
    scroller: HTMLElement | null
    shellElement?: HTMLElement | null
    openAnnotationCount: number
    annotationsTitle: string
    annotationsEmptyLabel: string
    sectionAnnotations: (sectionId: SectionId) => Annotation[]
    onOpenAnnotation: (annotation: Annotation) => void
    error?: string
    navigation: Snippet
    center: Snippet
    actions?: Snippet
    headerExtra?: Snippet
    sidebarExtra?: Snippet
    sidebarFooter?: Snippet
    markers?: Snippet
    children: Snippet
    onScrollerMouseUp?: (event: MouseEvent) => void
    onSectionKeydown?: (event: KeyboardEvent) => void
  }

  let {
    ariaLabel,
    scrollerLabel,
    sidebarTitle,
    sidebarLabel,
    sectionAnchorPrefix,
    sections,
    selectedSection = $bindable(),
    sectionsOpen = $bindable(false),
    scroller = $bindable(null),
    shellElement = $bindable(null),
    openAnnotationCount,
    annotationsTitle,
    annotationsEmptyLabel,
    sectionAnnotations,
    onOpenAnnotation,
    error,
    navigation,
    center,
    actions,
    headerExtra,
    sidebarExtra,
    sidebarFooter,
    markers,
    children,
    onScrollerMouseUp,
    onSectionKeydown
  }: Props = $props()

  async function scrollToSection(sectionId: SectionId): Promise<void> {
    selectedSection = sectionId
    sectionsOpen = false
    await tick()
    const target = document.getElementById(`${sectionAnchorPrefix}-${sectionId}`)
    if (!target || !scroller) return
    const scrollerTop = scroller.getBoundingClientRect().top
    const targetTop = target.getBoundingClientRect().top
    scroller.scrollTo({
      top: scroller.scrollTop + targetTop - scrollerTop - 20,
      behavior: 'smooth'
    })
  }

  export { scrollToSection }
</script>

<section bind:this={shellElement} class="flex h-full min-h-0 flex-col bg-app" aria-label={ariaLabel}>
  <header class="studio-header-container shrink-0 border-b bg-surface">
    <div
      class="flex flex-col gap-2 px-2 py-2 md:grid md:min-h-12 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:gap-3 md:px-3 md:py-0"
    >
      <div class="flex min-w-0 items-center gap-2">
        {@render navigation()}
      </div>

      <div class="flex items-center gap-2 text-[11px] text-muted max-md:flex-wrap md:justify-center">
        {@render center()}
      </div>

      {#if actions}
        <div class="flex items-center gap-1.5 max-md:*:h-10 max-md:*:flex-1 md:justify-end">
          {@render actions()}
        </div>
      {/if}
    </div>

    {#if headerExtra}
      {@render headerExtra()}
    {/if}

    {#if error}
      <p class="border-t bg-danger/10 px-4 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}
  </header>

  <div
    class="flex min-h-0 flex-1 flex-col overflow-hidden md:grid md:grid-cols-[13rem_minmax(0,1fr)]"
  >
    {#if sectionsOpen}
      <div
        class="fixed inset-0 z-40 bg-black/50 md:hidden"
        role="presentation"
        onclick={() => (sectionsOpen = false)}
      ></div>
    {/if}
    <aside
      class="relative flex min-h-0 flex-col border-r bg-surface max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-50 max-md:max-h-[80dvh] max-md:rounded-t-2xl max-md:border-r-0 max-md:border-t max-md:pb-[env(safe-area-inset-bottom)] max-md:shadow-2xl {sectionsOpen
        ? ''
        : 'max-md:hidden'}"
      aria-label={sidebarLabel}
    >
      <StudioSidebarResizeHandle {sidebarLabel} />
      <div class="flex h-12 shrink-0 items-center justify-between border-b px-3 md:hidden">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">
          {sidebarTitle}
        </p>
        <button
          class="flex h-9 w-9 items-center justify-center rounded-lg text-muted"
          aria-label="Close sections"
          title="Close sections"
          onclick={() => (sectionsOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="flex min-h-0 flex-1 flex-col overscroll-contain">
        <div
          class="shrink-0 space-y-0.5 p-2"
          role="tablist"
          tabindex={onSectionKeydown ? 0 : undefined}
          aria-orientation="vertical"
          onkeydown={onSectionKeydown}
        >
          {#each sections as section (section.id)}
            <button
              class="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors max-md:py-3 {selectedSection ===
              section.id
                ? 'bg-elevated font-semibold text-foreground'
                : 'text-muted hover:bg-elevated/60 hover:text-foreground'}"
              role="tab"
              aria-selected={selectedSection === section.id}
              tabindex={onSectionKeydown ? (selectedSection === section.id ? 0 : -1) : undefined}
              title={`Scroll to ${section.title}`}
              onclick={() => void scrollToSection(section.id)}
            >
              <span>{section.title}</span>
              <span class="flex items-center gap-1">
                {#each section.badges ?? [] as badge (badge.label)}
                  <span
                    class="rounded-full px-1.5 text-[10px] {badge.tone === 'danger'
                      ? 'bg-danger/10 text-danger'
                      : 'bg-info/10 text-info'}"
                    title={badge.label}
                    aria-label={badge.label}
                  >
                    {badge.count}
                  </span>
                {/each}
              </span>
            </button>
          {/each}
        </div>

        {#if sidebarExtra}
          {@render sidebarExtra()}
        {/if}

        <div class="flex min-h-0 flex-1 flex-col border-t p-3">
          <div class="flex shrink-0 items-center justify-between">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">
              {annotationsTitle}
            </p>
            <span class="text-[10px] tabular-nums text-dimmed">{openAnnotationCount}</span>
          </div>
          <div class="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {#each sectionAnnotations(selectedSection) as annotation (annotation.id)}
              <button
                class="block w-full rounded-lg border bg-elevated px-2.5 py-2 text-left hover:bg-overlay"
                title="Open annotation"
                onclick={() => onOpenAnnotation(annotation)}
              >
                {#if annotation.quote}
                  <span class="block truncate text-[10px] text-dimmed">“{annotation.quote}”</span>
                {/if}
                <span class="mt-0.5 line-clamp-4 block text-xs leading-relaxed"
                  >{annotation.body}</span
                >
              </button>
            {:else}
              <p
                class="rounded-lg border border-dashed px-2.5 py-3 text-center text-[11px] text-dimmed"
              >
                {annotationsEmptyLabel}
              </p>
            {/each}
          </div>
        </div>
      </div>

      {#if sidebarFooter}
        <div class="flex shrink-0 items-center gap-1 border-t p-2">
          {@render sidebarFooter()}
        </div>
      {/if}
    </aside>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <main
      bind:this={scroller}
      class="relative min-h-0 overflow-y-auto scroll-smooth bg-app"
      aria-label={scrollerLabel}
      onmouseup={onScrollerMouseUp}
    >
      {#if markers}
        {@render markers()}
      {/if}
      {@render children()}
    </main>
  </div>
</section>

<style>
  /* Size container so header children (nav, version bar, actions) can compact
     via container queries when the right-hand coordinator panel squeezes the
     studio — the same mechanism AppHeader uses for its toolbar. */
  .studio-header-container {
    container: studio-header / inline-size;
  }
</style>
