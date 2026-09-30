<script lang="ts">
  import { AlertTriangle, Check, FolderOpen, Store } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import {
    browserExtensions,
    browserExtensionInjectionLabel
  } from '$lib/stores/browser-extensions.svelte'
  import type { BrowserExtension } from '$shared/ipc-contract'
  import BrowserExtensionInstallProgress from './BrowserExtensionInstallProgress.svelte'

  /**
   * Install an extension, either by browsing the Chrome Web Store or from an
   * unpacked folder.
   *
   * There is no field for an extension id here on purpose. An id is a
   * developer's handle, not something a user knows, and the store's own "Add to
   * Chrome" button cannot work in this app because it is Chrome's inline-install
   * API. So the store path is a door rather than a form: this dialog opens the
   * store in a tab, and the install happens on the extension's own page from the
   * browser chrome, which is where the app can put a button the store cannot.
   * A folder install needs exactly one decision, so choosing the folder is the
   * install.
   */

  interface Props {
    open: boolean
    /** The jars the extension lands in, chosen by the panel that opened this. Never a
     *  choice inside the dialog: an install belongs in the box the user is looking at,
     *  and every other box is turned on afterwards from its settings. */
    boxes: readonly string[]
    /** The name of the box those jars belong to, so the form can say where the
     *  extension is about to go instead of leaving the user to guess. */
    boxName: string
    /** Leave the dialog and open the store, where any extension's page offers the
     *  install. The panel supplies this because it knows the box in view, and the
     *  store tab has to start in that same box. */
    onBrowseStore: () => void
    onClose: () => void
  }

  let { open, boxes, boxName, onBrowseStore, onClose }: Props = $props()

  /** The chosen unpacked folder, or an empty string before one is chosen. */
  let folderPath = $state('')
  /** The extension the last install produced, shown instead of the form. */
  let result = $state<BrowserExtension | null>(null)

  const installing = $derived(browserExtensions.installing)
  const progress = $derived(browserExtensions.progress)

  /** The folder's last path segment, which is what a user recognises it by. */
  const folderName = $derived(folderPath.split('/').filter(Boolean).at(-1) ?? folderPath)

  async function chooseFolder(): Promise<void> {
    if (installing) return
    const chosen = await browserExtensions.pickFolder()
    if (!chosen) return
    folderPath = chosen
    const installed = await browserExtensions.install({
      source: 'folder',
      value: chosen,
      boxes: [...boxes]
    })
    if (installed) result = installed
  }
</script>

<Modal
  {open}
  title="Install extension"
  description="Load an extension from the Chrome Web Store or from an unpacked folder on disk."
  {onClose}
  size="md"
  contentClass="space-y-4 overflow-y-auto p-6"
>
  {#if result}
    <div class="space-y-4">
      <div class="flex items-start gap-3">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-elevated">
          {#if result.iconDataUrl}
            <img src={result.iconDataUrl} alt="" class="h-5 w-5 rounded-sm object-contain" />
          {:else}
            <Check size={16} class="text-success" />
          {/if}
        </span>
        <div class="min-w-0">
          <p class="truncate text-sm font-medium text-foreground">{result.name}</p>
          <p class="text-[0.6875rem] text-dimmed">
            Version {result.version} · {result.source === 'webstore' ? 'Web Store' : 'Folder'}
            {result.enabled ? '· enabled' : '· disabled'}
          </p>
        </div>
      </div>

      <p
        class="rounded-lg border bg-elevated/50 px-3 py-2.5 text-[0.6875rem] leading-relaxed text-dimmed"
      >
        {browserExtensionInjectionLabel(result.injected)}
      </p>

      {#if result.missingCapabilities.length > 0}
        <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
          <div class="flex items-center gap-1.5">
            <AlertTriangle size={13} class="shrink-0 text-warning" />
            <p class="text-xs font-medium text-foreground">
              {result.missingCapabilities.length === 1
                ? 'One capability is unavailable'
                : `${result.missingCapabilities.length} capabilities are unavailable`}
            </p>
          </div>
          <ul class="mt-1.5 space-y-0.5 pl-5 text-[0.6875rem] leading-relaxed text-muted">
            {#each result.missingCapabilities as capability (capability)}
              <li class="list-disc">{capability}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if result.warnings.length > 0}
        <div class="rounded-lg border bg-elevated/50 px-3 py-2.5">
          <p class="text-xs font-medium text-foreground">Warnings</p>
          <ul class="mt-1.5 space-y-0.5 pl-5 text-[0.6875rem] leading-relaxed text-muted">
            {#each result.warnings as warning (warning)}
              <li class="list-disc">{warning}</li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {:else}
    <div class="space-y-2">
      <button
        type="button"
        data-modal-primary
        class="flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors hover:bg-elevated disabled:opacity-50"
        disabled={installing}
        title="Browse the Chrome Web Store"
        onclick={onBrowseStore}
      >
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-elevated">
          <Store size={16} class="text-muted" />
        </span>
        <span class="min-w-0">
          <span class="block text-sm font-medium text-foreground">Browse the Chrome Web Store</span>
          <span class="mt-0.5 block text-[0.6875rem] leading-relaxed text-dimmed">
            Open an extension's page and install it there, with the button beside the address.
          </span>
        </span>
      </button>

      <button
        type="button"
        class="flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors hover:bg-elevated disabled:opacity-50"
        disabled={installing}
        title="Install from a folder on this computer"
        onclick={() => void chooseFolder()}
      >
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-elevated">
          <FolderOpen size={16} class="text-muted" />
        </span>
        <span class="min-w-0">
          <span class="block text-sm font-medium text-foreground">Install from a folder</span>
          <span class="mt-0.5 block text-[0.6875rem] leading-relaxed text-dimmed">
            Pick an unpacked extension folder on this computer.
          </span>
        </span>
      </button>
    </div>

    <div class="rounded-lg border px-3 py-2.5">
      <p class="text-sm text-foreground">Installs into {boxName}</p>
      <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-dimmed">
        The box you are looking at. Give it other boxes from its settings once it is installed, and
        each keeps its own storage.
      </p>
    </div>

    {#if folderPath && installing}
      <p class="truncate text-[0.6875rem] text-dimmed" title={folderPath}>Reading {folderName}</p>
    {/if}

    {#if progress}
      <BrowserExtensionInstallProgress {progress} {installing} />
    {/if}
  {/if}

  {#snippet footer()}
    {#if result}
      <button
        type="button"
        data-modal-dismiss
        class="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
        title="Close"
        onclick={onClose}
      >
        Done
      </button>
    {:else}
      <button
        type="button"
        data-modal-dismiss
        class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
        title="Close without installing"
        onclick={onClose}
      >
        Cancel
      </button>
    {/if}
  {/snippet}
</Modal>
