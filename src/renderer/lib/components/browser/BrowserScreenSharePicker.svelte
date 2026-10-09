<script lang="ts">
  import { AppWindow, Monitor } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'

  /**
   * The in-app screen-share picker.
   *
   * `navigator.mediaDevices.getDisplayMedia` needs one capture source, and on a
   * platform without a native picker the browser asks here for it. This lists the
   * screens and windows Chromium reported, with the thumbnails it drew, and the
   * choice travels back to main, which hands it to the page's `getDisplayMedia`.
   *
   * The page itself is a native view under this modal, so the Modal's own browser
   * suppression parks it while the user chooses, exactly as it does for the Peek
   * Window. Cancelling, or closing the modal, refuses the share.
   */

  const prompt = $derived(globalBrowser.screenSharePrompt)
  const open = $derived(prompt !== null)
  const screens = $derived(prompt?.sources.filter((source) => source.kind === 'screen') ?? [])
  const windows = $derived(prompt?.sources.filter((source) => source.kind === 'window') ?? [])

  /** Put the keyboard on the first source, so Enter shares it. */
  const claimInitialFocus = (panel: HTMLElement): boolean => {
    const tile = panel.querySelector<HTMLButtonElement>('[data-screen-source]')
    tile?.focus()
    return tile !== null
  }

  function choose(sourceId: string): void {
    void globalBrowser.resolveScreenShare(sourceId)
  }

  function cancel(): void {
    void globalBrowser.resolveScreenShare(null)
  }
</script>

<Modal
  {open}
  title="Share your screen"
  description="Choose a screen or window to share with this page"
  onClose={cancel}
  size="lg"
  {claimInitialFocus}
>
  {#if prompt}
    <div class="flex flex-col gap-5">
      {#if screens.length > 0}
        <section class="flex flex-col gap-2">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Screens</h3>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {#each screens as source (source.id)}
              <button
                type="button"
                data-screen-source
                class="group flex flex-col overflow-hidden rounded-lg border border-border bg-elevated text-left transition-colors hover:border-primary hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary"
                title={`Share ${source.name}`}
                aria-label={`Share ${source.name}`}
                onclick={() => choose(source.id)}
              >
                <span
                  class="flex aspect-video w-full items-center justify-center overflow-hidden bg-app"
                >
                  {#if source.thumbnailDataUrl}
                    <img
                      src={source.thumbnailDataUrl}
                      alt=""
                      class="h-full w-full object-contain"
                    />
                  {:else}
                    <Monitor size={28} class="text-dimmed" aria-hidden="true" />
                  {/if}
                </span>
                <span class="flex items-center gap-1.5 px-2 py-1.5">
                  <Monitor size={12} class="shrink-0 text-dimmed" aria-hidden="true" />
                  <span class="min-w-0 truncate text-xs text-foreground">{source.name}</span>
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if windows.length > 0}
        <section class="flex flex-col gap-2">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Windows</h3>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {#each windows as source (source.id)}
              <button
                type="button"
                data-screen-source
                class="group flex flex-col overflow-hidden rounded-lg border border-border bg-elevated text-left transition-colors hover:border-primary hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary"
                title={`Share ${source.name}`}
                aria-label={`Share ${source.name}`}
                onclick={() => choose(source.id)}
              >
                <span
                  class="flex aspect-video w-full items-center justify-center overflow-hidden bg-app"
                >
                  {#if source.thumbnailDataUrl}
                    <img
                      src={source.thumbnailDataUrl}
                      alt=""
                      class="h-full w-full object-contain"
                    />
                  {:else}
                    <AppWindow size={28} class="text-dimmed" aria-hidden="true" />
                  {/if}
                </span>
                <span class="flex items-center gap-1.5 px-2 py-1.5">
                  <AppWindow size={12} class="shrink-0 text-dimmed" aria-hidden="true" />
                  <span class="min-w-0 truncate text-xs text-foreground">{source.name}</span>
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="flex h-8 items-center rounded-lg border border-border px-4 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground"
      title="Do not share the screen"
      onclick={cancel}
    >
      Cancel
    </button>
  {/snippet}
</Modal>
