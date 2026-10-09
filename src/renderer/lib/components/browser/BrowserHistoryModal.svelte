<script lang="ts">
  import { Trash2 } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { browserHistory } from '$lib/stores/browser-history.svelte'
  import { openInGlobalBrowserTabOnScreen } from '$lib/open-in-browser'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import BrowserHistoryList from './BrowserHistoryList.svelte'

  /**
   * The full-screen browsing-history manager, opened from Settings -> Browser.
   *
   * The rail panel is where a user reads their history while browsing; this is
   * where they edit it. It lists every durable visit the app holds, across the
   * global browser and every named profile box, so a single row can be removed
   * without clearing the whole history. It is the reading counterpart of the
   * settings tab's "Clear browsing history", which acts on the same set.
   *
   * Rows still open, unlike the settings clear buttons: reaching a page is what a
   * history is for, so a row opens it in the app-wide browser and brings that view
   * forward, which also closes this surface with the settings page.
   */

  interface Props {
    open: boolean
    onClose: () => void
  }

  let { open, onClose }: Props = $props()

  /** Every durable visit, one row per address, newest first. */
  const entries = $derived(browserHistory.durableEntries())

  /** The entry the user asked to forget, held while the confirmation is up. */
  let forgettingUrl = $state<string | null>(null)
  /** Whether the user asked to empty the whole history, held for confirmation. */
  let confirmingClear = $state(false)

  /** Open a row's page in the app-wide browser and leave this surface. */
  function openPage(url: string): void {
    openInGlobalBrowserTabOnScreen(url)
    onClose()
  }

  function forget(): void {
    const url = forgettingUrl
    forgettingUrl = null
    if (url) browserHistory.forgetEverywhere(url)
  }

  async function clearAll(): Promise<void> {
    confirmingClear = false
    await browserHistory.clear()
    toast.success('Browsing history cleared.')
  }
</script>

<Modal
  {open}
  title="Browser history"
  description="Every page kept in your browsing history"
  {onClose}
  placement="fullscreen"
  panelClass="bg-app"
  contentClass="overflow-hidden"
>
  <BrowserHistoryList
    {entries}
    onOpen={openPage}
    emptyDescription="Pages you visit in the app-wide browser, and in its profile boxes, are kept here."
  >
    {#snippet rowActions(entry)}
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-overlay hover:text-danger"
        aria-label={`Forget ${entry.title}`}
        title="Forget this page"
        onclick={() => (forgettingUrl = entry.url)}
      >
        <Trash2 size={12} />
      </button>
    {/snippet}
  </BrowserHistoryList>

  {#snippet footer()}
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold text-danger hover:bg-danger/10"
      title="Remove every page from your browsing history"
      aria-label="Clear all browsing history"
      onclick={() => (confirmingClear = true)}
    >
      <Trash2 size={13} />
      Clear all history
    </button>
  {/snippet}
</Modal>

<ConfirmDialog
  open={forgettingUrl !== null}
  title="Forget this page?"
  confirmLabel="Forget page"
  variant="danger"
  onConfirm={forget}
  onCancel={() => (forgettingUrl = null)}
>
  <p>The page leaves your browsing history, in every browser profile. The rest is kept.</p>
</ConfirmDialog>

<ConfirmDialog
  open={confirmingClear}
  title="Clear all browsing history?"
  confirmLabel="Clear history"
  variant="danger"
  onConfirm={clearAll}
  onCancel={() => (confirmingClear = false)}
>
  <p>
    Every page you have visited is forgotten, across the app-wide browser and its profile boxes.
    This cannot be undone. Your bookmarks are not affected.
  </p>
</ConfirmDialog>
