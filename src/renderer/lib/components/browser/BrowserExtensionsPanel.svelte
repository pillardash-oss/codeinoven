<script lang="ts">
  import { AlertTriangle, Plus, Puzzle, Settings2, Trash2 } from '@lucide/svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import {
    browserExtensions,
    browserExtensionInjectionLabel
  } from '$lib/stores/browser-extensions.svelte'
  import type { BrowserExtension } from '$shared/ipc-contract'
  import BrowserExtensionInstallModal from './BrowserExtensionInstallModal.svelte'

  /**
   * The browser extensions panel, docked in the browser's right rail.
   *
   * An extension belongs to the browser profile rather than to a page, so this
   * panel is present with the strip empty, exactly like boxes, downloads and the
   * library panels. A row says what the extension is, where it runs and whether
   * it is loaded; its settings open the detail view, where the boxes it runs in,
   * its compatibility notes and uninstalling all live.
   */

  let installOpen = $state(false)
  /** The extension whose detail view is open, or null. */
  let detailId = $state<string | null>(null)
  /** The extension the uninstall confirmation is for, or null. */
  let uninstallTarget = $state<BrowserExtension | null>(null)
  let uninstalling = $state(false)

  const extensions = $derived(browserExtensions.extensions)
  const count = $derived(browserExtensions.count)
  const detailExtension = $derived(
    detailId ? (extensions.find((extension) => extension.id === detailId) ?? null) : null
  )

  /** What the source column calls where the extension's files came from. */
  function sourceLabel(extension: BrowserExtension): string {
    return extension.source === 'webstore' ? 'Web Store' : 'Folder'
  }

  /** The name of the box a jar id names, so a row never shows a raw box id. */
  function boxName(boxId: string): string {
    return globalBrowser.boxes.find((box) => box.id === boxId)?.name ?? 'Missing box'
  }

  /** Where an extension runs, in the one line the row has room for. */
  function describeBoxes(extension: BrowserExtension): string {
    if (extension.boxes.length === 0) return 'Not loaded anywhere yet'
    return extension.boxes.map((id) => (id === '' ? 'No box' : boxName(id))).join(', ')
  }

  /** The one-line reason the warning triangle is on a row. */
  function issueSummary(extension: BrowserExtension): string {
    const parts: string[] = []
    if (extension.missingCapabilities.length > 0) {
      const n = extension.missingCapabilities.length
      parts.push(n === 1 ? '1 unavailable capability' : `${n} unavailable capabilities`)
    }
    if (extension.warnings.length > 0) {
      const n = extension.warnings.length
      parts.push(n === 1 ? '1 warning' : `${n} warnings`)
    }
    return parts.join(' · ')
  }

  /** The jars a user can choose: the context's own jar (the empty id), then each
   *  box. A jar the extension names but that no longer exists is kept out of this
   *  list, which is why updating the boxes replaces the whole list rather than
   *  merging into it. */
  function jarChoices(): { id: string; name: string }[] {
    return [
      { id: '', name: 'No box' },
      ...globalBrowser.boxes.map((box) => ({ id: box.id, name: box.name }))
    ]
  }

  /** Whether an extension is loaded into one jar. */
  function runsInBox(extension: BrowserExtension, boxId: string): boolean {
    return extension.boxes.includes(boxId)
  }

  /** Add or remove one jar from the list. The list is always explicit, so a box
   *  made later is never loaded into until the user turns it on here. */
  function toggleBox(extension: BrowserExtension, boxId: string, checked: boolean): void {
    const next = checked
      ? [...new Set([...extension.boxes, boxId])]
      : extension.boxes.filter((id) => id !== boxId)
    void browserExtensions.setBoxes(extension.id, next)
  }

  async function uninstall(): Promise<void> {
    const target = uninstallTarget
    if (!target) return
    uninstalling = true
    try {
      await browserExtensions.uninstall(target.id)
      if (detailId === target.id) detailId = null
      uninstallTarget = null
    } finally {
      uninstalling = false
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
    <p class="text-xs font-medium text-muted">
      {count}
      {count === 1 ? 'extension' : 'extensions'}
    </p>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
      title="Install an extension"
      aria-label="Install an extension"
      onclick={() => (installOpen = true)}
    >
      <Plus size={13} />
      Install extension
    </button>
  </div>

  {#if extensions.length === 0}
    <EmptyState
      icon={Puzzle}
      title="No extensions yet"
      description="An extension runs inside the boxes you choose, keeps its own storage in each, and is only loaded while a box has a tab open."
    />
  {:else}
    <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
      {#each extensions as extension (extension.id)}
        <li>
          <div
            class="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-elevated"
          >
            <span class="flex h-4 w-4 shrink-0 items-center justify-center">
              {#if extension.iconDataUrl}
                <img src={extension.iconDataUrl} alt="" class="h-4 w-4 rounded-sm object-contain" />
              {:else}
                <Puzzle size={13} class="text-dimmed" />
              {/if}
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate text-xs text-foreground">{extension.name}</span>
                <span class="shrink-0 text-[0.625rem] text-dimmed">v{extension.version}</span>
                {#if extension.missingCapabilities.length > 0 || extension.warnings.length > 0}
                  <span
                    class="shrink-0"
                    role="img"
                    title={issueSummary(extension)}
                    aria-label={issueSummary(extension)}
                  >
                    <AlertTriangle size={12} class="text-warning" />
                  </span>
                {/if}
              </span>
              <span class="truncate text-[0.625rem] text-dimmed">
                {sourceLabel(extension)} · {describeBoxes(extension)}
              </span>
            </span>
            <Switch
              checked={extension.enabled}
              title={extension.enabled ? `Disable ${extension.name}` : `Enable ${extension.name}`}
              aria-label={extension.enabled
                ? `Disable ${extension.name}`
                : `Enable ${extension.name}`}
              onchange={(next) => void browserExtensions.setEnabled(extension.id, next)}
            />
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100"
              title={`Settings for ${extension.name}`}
              aria-label={`Settings for ${extension.name}`}
              onclick={() => (detailId = extension.id)}
            >
              <Settings2 size={13} />
            </button>
          </div>
        </li>
      {/each}
    </ul>
    <p
      class="shrink-0 border-t border-border px-3 py-1.5 text-[0.625rem] leading-relaxed text-dimmed"
    >
      An extension is loaded into each box you enable it in, and only while a box has a tab open.
      Turn it off to unload it everywhere without uninstalling.
    </p>
  {/if}
</div>

{#if detailExtension}
  <Modal
    open
    title={detailExtension.name}
    description={`Settings for the ${detailExtension.name} extension.`}
    onClose={() => (detailId = null)}
    size="md"
    contentClass="space-y-4 overflow-y-auto p-6"
  >
    <div class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
      <div class="min-w-0">
        <p class="text-sm text-foreground">{detailExtension.enabled ? 'Enabled' : 'Disabled'}</p>
        <p class="mt-0.5 text-[0.6875rem] text-dimmed">
          A disabled extension is installed but loaded nowhere.
        </p>
      </div>
      <Switch
        checked={detailExtension.enabled}
        title={detailExtension.enabled
          ? `Disable ${detailExtension.name}`
          : `Enable ${detailExtension.name}`}
        aria-label={detailExtension.enabled
          ? `Disable ${detailExtension.name}`
          : `Enable ${detailExtension.name}`}
        onchange={(next) => void browserExtensions.setEnabled(detailExtension.id, next)}
      />
    </div>

    <div class="space-y-2">
      <div class="min-w-0">
        <p class="text-sm text-foreground">Run in</p>
        <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-dimmed">
          Only the jars you turn on load it, and each keeps its own storage. A jar left off costs no
          memory, and a box you make later stays off until you turn it on here.
        </p>
      </div>

      <div class="space-y-0.5 rounded-lg border p-1">
        {#each jarChoices() as jar (jar.id)}
          <div class="flex items-center justify-between gap-3 px-2 py-1.5">
            <p class="truncate text-xs text-foreground">{jar.name}</p>
            <Switch
              checked={runsInBox(detailExtension, jar.id)}
              title={`Run in ${jar.name}`}
              aria-label={`Run in ${jar.name}`}
              onchange={(next) => toggleBox(detailExtension, jar.id, next)}
            />
          </div>
        {/each}
      </div>
    </div>

    <div class="space-y-1">
      <p class="text-xs font-medium text-muted">Version {detailExtension.version}</p>
      <p class="text-[0.6875rem] text-dimmed">
        {sourceLabel(detailExtension)} · {detailExtension.popupPath ? 'Has a popup' : 'No popup'}
      </p>
    </div>

    <p
      class="rounded-lg border bg-elevated/50 px-3 py-2.5 text-[0.6875rem] leading-relaxed text-dimmed"
    >
      {browserExtensionInjectionLabel(detailExtension.injected)}
    </p>

    {#if detailExtension.missingCapabilities.length > 0}
      <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
        <div class="flex items-center gap-1.5">
          <AlertTriangle size={13} class="shrink-0 text-warning" />
          <p class="text-xs font-medium text-foreground">
            {detailExtension.missingCapabilities.length === 1
              ? 'One capability is unavailable'
              : `${detailExtension.missingCapabilities.length} capabilities are unavailable`}
          </p>
        </div>
        <ul class="mt-1.5 space-y-0.5 pl-5 text-[0.6875rem] leading-relaxed text-muted">
          {#each detailExtension.missingCapabilities as capability (capability)}
            <li class="list-disc">{capability}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if detailExtension.warnings.length > 0}
      <div class="rounded-lg border bg-elevated/50 px-3 py-2.5">
        <p class="text-xs font-medium text-foreground">Warnings</p>
        <ul class="mt-1.5 space-y-0.5 pl-5 text-[0.6875rem] leading-relaxed text-muted">
          {#each detailExtension.warnings as warning (warning)}
            <li class="list-disc">{warning}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#snippet footer()}
      <div class="flex w-full items-center gap-2">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10"
          title={`Uninstall ${detailExtension.name}`}
          aria-label={`Uninstall ${detailExtension.name}`}
          onclick={() => (uninstallTarget = detailExtension)}
        >
          <Trash2 size={14} />
          Uninstall
        </button>
        <button
          type="button"
          class="ml-auto rounded-lg border bg-elevated px-3 py-2 text-sm font-medium transition-colors hover:bg-overlay"
          title="Close settings"
          onclick={() => (detailId = null)}
        >
          Close
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

{#if uninstallTarget}
  <ConfirmDialog
    open
    variant="danger"
    title={`Uninstall ${uninstallTarget.name}?`}
    confirmLabel="Uninstall extension"
    busy={uninstalling}
    onCancel={() => (uninstallTarget = null)}
    onConfirm={uninstall}
  >
    <p>
      {uninstallTarget.name} is removed and stops loading in every box. Its own storage is deleted with
      it, and a reinstall starts from nothing.
    </p>
  </ConfirmDialog>
{/if}

{#if installOpen}
  <BrowserExtensionInstallModal open onClose={() => (installOpen = false)} />
{/if}
