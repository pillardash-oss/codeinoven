<script lang="ts">
  import type { DisplaySourceDescriptor, DisplaySourceKind } from '$shared/ipc/display'
  import { displayPanel } from '$lib/stores/display-panel.svelte'

  /**
   * The target picker.
   *
   * Every kind is listed whether or not it has anything to offer, because the
   * reason a list is empty is the useful information: no adb on the machine, no
   * simulator booted, or screen recording switched off. A kind still being
   * discovered says so instead of showing an empty list.
   */

  interface Props {
    onSelect: (source: DisplaySourceDescriptor) => void
    /** Present only when there is already a tab to go back to. */
    onClose?: () => void
  }

  let { onSelect, onClose }: Props = $props()

  /** What an empty list means for each kind, in the user's terms. */
  function emptyCopy(kind: DisplaySourceKind): string {
    if (kind === 'android') return 'No Android target is connected.'
    if (kind === 'ios') return 'No simulator is booted.'
    if (kind === 'desktop-screen') return 'No screen is available to mirror.'
    return 'No window is available to mirror.'
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
    <p class="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold text-foreground">
      Choose a display target
    </p>
    {#if onClose}
      <button
        type="button"
        class="shrink-0 px-2 py-0.5 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Back to the preview"
        onclick={onClose}
      >
        Back
      </button>
    {/if}
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#each displayPanel.sections as section (section.kind)}
      {@const sources = section.listing?.sources ?? []}
      <section class="border-b border-border last:border-b-0" aria-label={section.label}>
        <div class="flex items-center gap-2 px-2 pt-2 pb-1">
          <p class="min-w-0 flex-1 truncate text-[0.625rem] font-semibold text-muted uppercase">
            {section.label}
          </p>
          {#if section.loading}
            <span class="text-[0.625rem] text-dimmed" role="status">Looking</span>
          {:else if sources.length > 0}
            <span class="text-[0.625rem] text-dimmed">{sources.length}</span>
          {/if}
        </div>

        {#if section.loading && sources.length === 0}
          <p class="px-2 pb-2 text-[0.625rem] text-dimmed">Looking for targets…</p>
        {:else if section.listing?.problem}
          <p class="px-2 pb-2 text-[0.625rem] leading-relaxed text-warning">
            {section.listing.problem}
          </p>
        {:else if sources.length === 0}
          <p class="px-2 pb-2 text-[0.625rem] text-dimmed">{emptyCopy(section.kind)}</p>
        {:else}
          <ul class="pb-1">
            {#each sources as source (source.sourceId)}
              <li>
                <button
                  type="button"
                  class="flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors hover:bg-elevated"
                  title={`Preview ${source.label}`}
                  onclick={() => onSelect(source)}
                >
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate text-[0.6875rem] text-foreground">{source.label}</span>
                    {#if source.detail}
                      <span class="truncate text-[0.625rem] text-dimmed">{source.detail}</span>
                    {/if}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
</div>
