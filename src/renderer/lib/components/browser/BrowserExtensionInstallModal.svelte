<script lang="ts">
  import { AlertTriangle, Check, FolderOpen, Loader2 } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import {
    browserExtensions,
    browserExtensionInjectionLabel
  } from '$lib/stores/browser-extensions.svelte'
  import type {
    BrowserExtension,
    BrowserExtensionProgress,
    BrowserExtensionSource
  } from '$shared/ipc-contract'

  /**
   * Install an extension, by Web Store id or URL or from an unpacked folder.
   *
   * The two sources are exclusive, so they are one segmented choice rather than
   * two fields the user has to reason about. An install that needs a fetch and an
   * unpack reports each step while it runs, and its result view shows exactly
   * what was loaded, including any capability the runtime could not give it:
   * the point of the surface is that a partly non-functional extension is
   * visible as such rather than silently accepted.
   */

  interface Props {
    open: boolean
    onClose: () => void
  }

  let { open, onClose }: Props = $props()

  /** The 32-character Chromium Web Store id. */
  const WEBSTORE_ID_PATTERN = /^[a-p]{32}$/

  /** What each install step is called on screen. */
  const PHASE_LABELS: Record<BrowserExtensionProgress['phase'], string> = {
    resolving: 'Resolving the extension',
    downloading: 'Downloading',
    unpacking: 'Unpacking',
    pinning: 'Pinning the extension id',
    compat: 'Applying compatibility',
    registering: 'Registering',
    done: 'Finishing up',
    failed: 'Install failed'
  }

  let source = $state<BrowserExtensionSource>('webstore')
  /** A Web Store id or a full Chrome Web Store URL. */
  let webstoreValue = $state('')
  /** The chosen unpacked folder, or an empty string before one is chosen. */
  let folderPath = $state('')
  /** The extension the last install produced, shown instead of the form. */
  let result = $state<BrowserExtension | null>(null)

  const installing = $derived(browserExtensions.installing)
  const progress = $derived(browserExtensions.progress)

  /** The id inside a Web Store id or URL, or null when the field is not one yet.
   *  A URL is accepted so the user can paste the address bar as-is. */
  function webstoreIdFrom(value: string): string | null {
    const trimmed = value.trim()
    if (WEBSTORE_ID_PATTERN.test(trimmed)) return trimmed
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    const fromQuery = url.searchParams.get('id')
    if (fromQuery && WEBSTORE_ID_PATTERN.test(fromQuery)) return fromQuery
    const lastSegment = url.pathname.split('/').filter(Boolean).at(-1)
    if (lastSegment && WEBSTORE_ID_PATTERN.test(lastSegment)) return lastSegment
    return null
  }

  const webstoreValid = $derived(webstoreIdFrom(webstoreValue) !== null)
  const canInstall = $derived(source === 'webstore' ? webstoreValid : folderPath.trim() !== '')

  const progressPercent = $derived(
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : 0
  )

  async function chooseFolder(): Promise<void> {
    const chosen = await browserExtensions.pickFolder()
    if (chosen) folderPath = chosen
  }

  async function install(): Promise<void> {
    if (!canInstall || installing) return
    const installed = await browserExtensions.install({
      source,
      value: source === 'webstore' ? webstoreValue.trim() : folderPath.trim()
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
    <div class="flex gap-1.5">
      <button
        type="button"
        class="h-8 flex-1 rounded-lg border px-3 text-xs font-medium transition-colors {source ===
        'webstore'
          ? 'border-primary bg-primary text-on-primary'
          : 'border-border bg-surface text-muted hover:bg-elevated hover:text-foreground'}"
        aria-pressed={source === 'webstore'}
        title="Install from the Chrome Web Store"
        onclick={() => (source = 'webstore')}
      >
        Web Store
      </button>
      <button
        type="button"
        class="h-8 flex-1 rounded-lg border px-3 text-xs font-medium transition-colors {source ===
        'folder'
          ? 'border-primary bg-primary text-on-primary'
          : 'border-border bg-surface text-muted hover:bg-elevated hover:text-foreground'}"
        aria-pressed={source === 'folder'}
        title="Install from an unpacked folder"
        onclick={() => (source = 'folder')}
      >
        Folder
      </button>
    </div>

    {#if source === 'webstore'}
      <label class="block">
        <span class="mb-1.5 block text-xs font-medium text-muted">Web Store id or URL</span>
        <input
          type="text"
          class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm text-foreground outline-none focus:border-primary"
          placeholder="Paste a Chrome Web Store address or its 32-character id"
          spellcheck="false"
          autocomplete="off"
          bind:value={webstoreValue}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void install()
            }
          }}
        />
        {#if webstoreValue.trim() !== '' && !webstoreValid}
          <span class="mt-1.5 block text-[0.6875rem] text-danger">
            That does not look like a Web Store id or URL.
          </span>
        {/if}
      </label>
    {:else}
      <div>
        <span class="mb-1.5 block text-xs font-medium text-muted">Unpacked folder</span>
        <div class="flex items-center gap-2">
          <p
            class="flex h-9 min-w-0 flex-1 items-center truncate rounded-lg border bg-elevated px-3 text-xs {folderPath
              ? 'text-foreground'
              : 'text-dimmed'}"
            title={folderPath || 'No folder chosen yet'}
          >
            {folderPath || 'No folder chosen yet'}
          </p>
          <button
            type="button"
            class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium text-foreground transition-colors hover:bg-overlay"
            title="Choose the folder that holds the extension's manifest"
            onclick={() => void chooseFolder()}
          >
            <FolderOpen size={13} />
            Choose folder…
          </button>
        </div>
      </div>
    {/if}

    {#if progress}
      <div class="rounded-lg border bg-elevated/50 px-3 py-2.5">
        <div class="flex items-center gap-2">
          {#if installing}
            <Loader2 size={13} class="shrink-0 animate-spin text-dimmed" />
          {/if}
          <p class="text-xs font-medium text-foreground">{PHASE_LABELS[progress.phase]}</p>
          {#if progress.totalBytes > 0}
            <p class="ml-auto text-[0.625rem] tabular-nums text-dimmed">{progressPercent}%</p>
          {/if}
        </div>
        {#if progress.detail}
          <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">{progress.detail}</p>
        {/if}
        {#if progress.totalBytes > 0}
          <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-overlay">
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-150"
              style="width: {progressPercent}%"
            ></div>
          </div>
        {/if}
      </div>
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
      <button
        type="button"
        data-modal-primary
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        disabled={!canInstall || installing}
        title="Install this extension"
        onclick={() => void install()}
      >
        <Check size={14} />
        Install
      </button>
    {/if}
  {/snippet}
</Modal>
