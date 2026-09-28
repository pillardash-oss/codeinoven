<script lang="ts">
  import { Globe } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { resolveBrowserAddress } from '$shared/browser-search-engines'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { GLOBAL_BROWSER_CONTEXT, globalBrowser } from '$lib/stores/global-browser.svelte'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  /**
   * The address spotlight.
   *
   * The browser's address bar lives in the left sidebar, so Cmd/Ctrl+L summons
   * this instead of moving focus across the window: a small top-anchored panel
   * with one field, pre-filled with the page on screen and ready to be replaced.
   * It is the same shape as the app's other spotlights, which is what makes the
   * chord feel like the rest of the workstation rather than a browser bolt-on.
   */

  // Read once at construction: the panel is mounted fresh each time it opens, so
  // the page it started from is the page it should offer.
  const tab = globalBrowser.activeTab
  const initialValue = tab?.url ?? ''

  let value = $state(initialValue)
  let error = $state('')
  /** The one field, focused and selected the moment the panel is up. Bound here
   *  rather than left to the shared "first text field" rule so the address is
   *  selected too, which is what Cmd/Ctrl+L promises: the key hands over the
   *  address to replace, not just a caret at one end of it. */
  let addressInput = $state<HTMLInputElement | null>(null)

  function submit(): void {
    const resolution = resolveBrowserAddress(value, appConfigState.browserSearchEngine)
    if (!resolution) {
      error = 'Enter a search or an address'
      return
    }
    if (tab) {
      void invoke(
        'browser:navigate',
        tab.id,
        GLOBAL_BROWSER_CONTEXT.projectId,
        GLOBAL_BROWSER_CONTEXT.threadId,
        resolution.url
      ).catch(() => {})
    } else {
      globalBrowser.createTab(resolution.url)
    }
    onClose()
  }
</script>

<Modal
  open
  title="Open an address"
  description="Type the address to open in the global browser."
  placement="palette"
  size="lg"
  chrome={false}
  {onClose}
  contentClass="p-1.5"
  claimInitialFocus={() => {
    if (!addressInput) return false
    addressInput.focus()
    addressInput.select()
    return true
  }}
>
  <div class="flex items-center gap-2 rounded-lg bg-elevated px-3">
    <Globe size={15} class="shrink-0 text-dimmed" />
    <input
      bind:this={addressInput}
      type="text"
      class="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-dimmed"
      placeholder="Search or enter an address"
      aria-label="Address to open"
      aria-invalid={error !== ''}
      spellcheck="false"
      autocomplete="off"
      bind:value
      onkeydown={(event: KeyboardEvent) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        submit()
      }}
    />
    {#if error}
      <span class="shrink-0 pr-1 text-[0.6875rem] text-danger">{error}</span>
    {:else}
      <span class="shrink-0 pr-1 text-[0.6875rem] text-dimmed">Enter to open</span>
    {/if}
  </div>
</Modal>
