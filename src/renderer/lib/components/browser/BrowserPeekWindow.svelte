<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { Maximize2, X } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { subscribe } from '$lib/ipc.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import BrowserWorkspace from './BrowserWorkspace.svelte'

  const tab = $derived(globalBrowser.peekTab)
  onMount(() =>
    subscribe('browser:panelShortcut', (tabId, action) => {
      if (tabId === globalBrowser.peekTab?.id && action === 'close-tab') globalBrowser.closePeek()
    })
  )
  onDestroy(() => globalBrowser.closePeek())
</script>

{#if tab}
  <Modal
    open
    title="Peek Window"
    chrome={false}
    blocksBrowserView={false}
    trapFocus={false}
    size="full"
    panelWidth="max-w-[85vw]"
    panelClass="h-[85vh] bg-app"
    onClose={() => globalBrowser.closePeek()}
  >
    <div class="flex shrink-0 items-center justify-end gap-1 border-b px-2 py-1">
      <button
        type="button"
        class="rounded-md p-2 text-text-muted hover:bg-hover hover:text-text"
        title="Expand Peek Window into a dedicated tab"
        aria-label="Expand Peek Window into a dedicated tab"
        data-modal-primary
        onclick={() => void globalBrowser.expandPeek()}><Maximize2 size={16} /></button
      >
      <button
        type="button"
        class="rounded-md p-2 text-text-muted hover:bg-hover hover:text-text"
        title="Close Peek Window"
        aria-label="Close Peek Window"
        onclick={() => globalBrowser.closePeek()}><X size={16} /></button
      >
    </div>
    {#key tab.id}
      <BrowserWorkspace {tab} surface="peek" />
    {/key}
  </Modal>
{/if}
