<script lang="ts">
  import {
    AlertTriangle,
    ChevronDown,
    Download,
    FolderOpen,
    LoaderCircle,
    Pin,
    Plus,
    Puzzle,
    Store,
    Trash2
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { Component } from 'svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { GLOBAL_BROWSER_CONTEXT, globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
  import {
    browserExtensions,
    browserExtensionInjectionLabel
  } from '$lib/stores/browser-extensions.svelte'
  import {
    installStoreExtensionOffer,
    storeExtensionOffer,
    storeOfferInstallVerb
  } from '$lib/stores/browser-extension-store-offer'
  import type { BrowserExtension } from '$shared/ipc-contract'
  import { WEBSTORE_HOME_URL } from '$shared/browser/browser-webstore'
  import { MAX_PINNED_EXTENSIONS } from '$shared/browser/browser-extension-pins'
  import BrowserExtensionInstallProgress from './BrowserExtensionInstallProgress.svelte'
  import BrowserBoxChips from './BrowserBoxChips.svelte'
  import EnumSelect from '$lib/components/ui/EnumSelect.svelte'
  import { browserAppearanceAccent, browserAppearanceIconUrl } from './browser-group-appearance'
  import {
    DEFAULT_BOX_ID,
    DEFAULT_BOX_NAME,
    boxIdForJar,
    defaultBrowserBox,
    extensionJarForBox,
    jarIdForBox
  } from '$lib/stores/global-browser-types'

  /**
   * The browser extensions panel, docked in the browser's right rail.
   *
   * An extension belongs to the browser profile rather than to a page, so this
   * panel is present with the strip empty, exactly like boxes, downloads and the
   * library panels. A row says what the extension is, where it runs and whether
   * it is loaded, and it folds open in place for the rest: the boxes it runs in,
   * its compatibility notes and uninstalling. A fold rather than a dialog,
   * because these are the row's own settings and the list stays in view while
   * they are read. Installing is the header's own menu for the same reason: two
   * doors are a list, and a dialog that only lists them would hide the panel the
   * install lands in.
   */

  /** The extension whose settings are folded open on its row, or null. */
  let expandedId = $state<string | null>(null)
  /** The extension the uninstall confirmation is for, or null. */
  let uninstallTarget = $state<BrowserExtension | null>(null)
  let uninstalling = $state(false)
  let draggingId = $state<string | null>(null)

  const extensions = $derived(browserExtensions.extensions)

  /**
   * The offer the store page on screen makes, when it is one this profile does
   * not have yet.
   *
   * The rail's indicator promises exactly this, so the panel answers it above
   * the list: the user clicked through to install what they were looking at,
   * not to fill in a form. Once installed the offer is gone, because there is
   * nothing left to install and the row is already in the list below.
   */
  const installableStoreOffer = $derived.by(() => {
    const offer = storeExtensionOffer()
    return offer && !offer.installed ? offer : null
  })

  /** What this offer's install is doing, or null when it has none in flight. Only
   *  this extension's own install makes its row busy: installing something else
   *  leaves this one a door, because a click here queues rather than waits. */
  const offerInstallVerb = $derived(
    installableStoreOffer ? storeOfferInstallVerb(installableStoreOffer) : null
  )

  /** The value the picker uses for every extension rather than one box's. */
  const ALL_BOXES_SELECTION = 'all'

  /**
   * The box the panel is scoped to, or the all-boxes value.
   *
   * The installed inventory starts with every box. A selected box filters the
   * list, while an install still belongs to the page's current box by default.
   */
  let selection = $state(ALL_BOXES_SELECTION)
  /** The box in view, or null while the all view is up. */
  const scopedBox = $derived(
    selection === ALL_BOXES_SELECTION ? null : (globalBrowser.boxById(selection) ?? null)
  )
  /** Where an install lands: the box in view, or the page on screen's box while the
   *  all view is up, since a box still has to own the extension. */
  const installBox = $derived(
    scopedBox ?? globalBrowser.boxById(globalBrowser.activeTabBoxId) ?? defaultBrowserBox()
  )
  const boxOptions = $derived([
    {
      id: ALL_BOXES_SELECTION,
      label: 'All boxes',
      hint: 'Every installed extension, with the boxes each one runs in on its row.'
    },
    ...globalBrowser.boxes.map((box) => ({
      id: box.id,
      label: box.name,
      accent: browserAppearanceAccent(box),
      iconUrl: browserAppearanceIconUrl(box, globalBrowser.boxIconUrl(box.id))
    }))
  ])
  /** The extensions this panel lists: all of them, or the ones this box runs. */
  const shown = $derived(
    scopedBox
      ? extensions.filter((extension) => extension.boxes.includes(extensionJarForBox(scopedBox.id)))
      : extensions
  )
  /** Whether each row has to say which boxes it runs in, which is only useful when
   *  more than one box is on screen. */
  const showChips = $derived(scopedBox === null)

  function dropExtension(targetId: string): void {
    const sourceId = draggingId
    draggingId = null
    if (!sourceId || sourceId === targetId) return
    const reorderedShown = [...shown]
    const sourceIndex = reorderedShown.findIndex((extension) => extension.id === sourceId)
    const targetIndex = reorderedShown.findIndex((extension) => extension.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const [source] = reorderedShown.splice(sourceIndex, 1)
    if (!source) return
    reorderedShown.splice(targetIndex, 0, source)
    const orderedShownIds = reorderedShown.map((extension) => extension.id)
    let shownIndex = 0
    const orderedIds = browserExtensions.extensions.map((extension) =>
      shown.some((visible) => visible.id === extension.id)
        ? (orderedShownIds[shownIndex++] ?? extension.id)
        : extension.id
    )
    void browserExtensions.reorder(orderedIds)
  }

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

  /**
   * What one row's pin control says and whether it can be used.
   *
   * A pin is a place in the browser view's header whose only job is opening the
   * extension's popup, so an extension that declares none has nothing to pin, and
   * the header holds `MAX_PINNED_EXTENSIONS` of them. The cap is stated in the
   * control's own words rather than left to a refusal, which is what the user
   * reads first.
   */
  function pinAction(extension: BrowserExtension): { disabled: boolean; title: string } {
    if (extension.pinned) return { disabled: false, title: `Unpin ${extension.name}` }
    if (extension.popupPath === null) {
      return { disabled: true, title: `${extension.name} declares no popup to open` }
    }
    if (browserExtensions.pinnedCount >= MAX_PINNED_EXTENSIONS) {
      return {
        disabled: false,
        title: `${MAX_PINNED_EXTENSIONS} extensions are already pinned. Unpin one to make room for ${extension.name}.`
      }
    }
    return { disabled: false, title: `Pin ${extension.name} to the header` }
  }

  /**
   * What one row's identity can do about the extension's own popup, and its words.
   *
   * An extension's popup opens on the tab in front of the user: a popup belongs to
   * that tab's jar, and only an extension the box of that tab runs can raise one.
   * So the identity is a door exactly while it can act and a label carrying the
   * reason when it cannot, rather than a control that refuses a click. A row whose
   * extension declares no popup at all stays plain.
   */
  function popupAction(extension: BrowserExtension): {
    open: boolean
    title: string
    refusal: string
  } {
    if (extension.popupPath === null) return { open: false, title: '', refusal: '' }
    const tab = globalBrowser.activeTab
    if (!tab) {
      return {
        open: false,
        title: '',
        refusal: `Open a browser tab first: ${extension.name} pops up on the tab on screen.`
      }
    }
    const jar = extensionJarForBox(globalBrowser.activeTabBoxId)
    if (!extension.enabled || !extension.boxes.includes(jar)) {
      return {
        open: false,
        title: '',
        refusal: `${extension.name} is not loaded in ${boxName(globalBrowser.activeTabBoxId)}. Turn it on for that box to give its popup a home.`
      }
    }
    return {
      open: true,
      title:
        browserPopupWindows.extensionPopupFor(extension.id, tab.id) === null
          ? `Open the ${extension.name} popup`
          : `Show the ${extension.name} popup`,
      refusal: ''
    }
  }

  /**
   * Open one extension's own popup on the tab in front of the user, or bring back
   * the one it already has open.
   *
   * The popup is a popup window like any other: main hosts it, the rail's strip
   * carries its tab, and the popup panel draws it. Reaching for the extension
   * again is not a request for a second copy, so an open popup is selected again
   * rather than reopened, and the rail switches to it either way, which is what
   * puts the extension's tab in front and fills the panel with its page.
   */
  async function openExtensionPopup(extension: BrowserExtension): Promise<void> {
    const tab = globalBrowser.activeTab
    if (!tab) return
    const open = browserPopupWindows.extensionPopupFor(extension.id, tab.id)
    if (open !== null) {
      browserPopupWindows.select(open)
      globalBrowser.showPopupsSidebar()
      return
    }
    const popupId = await browserPopupWindows.openExtension(
      {
        projectId: GLOBAL_BROWSER_CONTEXT.projectId,
        threadId: GLOBAL_BROWSER_CONTEXT.threadId,
        tabId: tab.id,
        boxId: tab.boxId
      },
      extension.id
    )
    if (popupId !== null) globalBrowser.showPopupsSidebar()
  }

  /** The jars a user can choose: the context's own jar (the empty id), then each
   *  box. A jar the extension names but that no longer exists is kept out of this
   *  list, which is why updating the boxes replaces the whole list rather than
   *  merging into it. */
  function jarChoices(): {
    id: string
    name: string
    accent: string
    iconUrl: string | null
  }[] {
    const choices: { id: string; name: string }[] = [
      { id: '', name: globalBrowser.boxById(DEFAULT_BOX_ID)?.name ?? DEFAULT_BOX_NAME },
      ...globalBrowser.boxes
        .filter((box) => box.id !== DEFAULT_BOX_ID)
        .map((box) => ({ id: box.id, name: box.name }))
    ]
    // The mark and accent each row wears are the box's own, resolved the way the
    // boxes panel resolves them, so a list of boxes never reads as bare names.
    return choices.map((choice) => {
      const box = globalBrowser.boxById(boxIdForJar(choice.id))
      return {
        ...choice,
        accent: box ? browserAppearanceAccent(box) : '',
        iconUrl: box ? browserAppearanceIconUrl(box, globalBrowser.boxIconUrl(box.id)) : null
      }
    })
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

  /** Open the store in the box this panel is on, which is where the install for
   *  any extension's page happens: the menu leaves first, so the tab behind it
   *  and the rail are what the user sees next. */
  function browseStore(): void {
    globalBrowser.open(WEBSTORE_HOME_URL, null, jarIdForBox(installBox.id))
    globalBrowser.showExtensionsSidebar()
  }

  /**
   * Install from an unpacked folder, where choosing the folder is the install.
   *
   * The install lands in the box the panel is on, captured before the folder
   * picker opens so the extension does not follow a box the user switched to
   * while it was up. The new row is left folded open, because that is where its
   * version, popup and compatibility notes live and the menu that started it is
   * gone by the time the files have been read.
   */
  async function installFromFolder(): Promise<void> {
    const box = installBox
    const folder = await browserExtensions.pickFolder()
    if (!folder) return
    const installed = await browserExtensions.install({
      source: 'folder',
      value: folder,
      boxes: [extensionJarForBox(box.id)]
    })
    if (installed) expandedId = installed.id
  }

  /**
   * The two ways in, as the header menu's rows.
   *
   * One list rather than two hand-written items, because both rows are the same
   * shape: an icon, a name and one line saying what the door does. Neither asks
   * for an extension id, since an id is a developer's handle rather than
   * something a user knows, and the store's own "Add to Chrome" button is
   * Chrome's inline-install API. So the store row is a door: it opens the store,
   * and an extension's page is where the install happens from the browser chrome.
   */
  const installDoors: {
    id: string
    icon: Component
    label: string
    hint: string
    run: () => void
  }[] = [
    {
      id: 'store',
      icon: Store,
      label: 'Chrome Web Store',
      hint: "Open the store, then install from the extension's page with the button beside the address.",
      run: browseStore
    },
    {
      id: 'folder',
      icon: FolderOpen,
      label: 'Local folder',
      hint: 'Pick an unpacked extension folder on this computer.',
      run: () => void installFromFolder()
    }
  ]

  async function uninstall(): Promise<void> {
    const target = uninstallTarget
    if (!target) return
    uninstalling = true
    try {
      await browserExtensions.uninstall(target.id)
      if (expandedId === target.id) expandedId = null
      uninstallTarget = null
    } finally {
      uninstalling = false
    }
  }
</script>

{#snippet extensionIdentity(extension: BrowserExtension)}
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
      {sourceLabel(extension)}{#if !showChips}
        · {describeBoxes(extension)}{/if}
    </span>
  </span>
{/snippet}

<div class="flex h-full min-h-0 flex-col">
  <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
    <p class="text-xs font-medium text-muted">
      {extensions.length}
      {extensions.length === 1 ? 'installed extension' : 'installed extensions'}
    </p>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class={[
          'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
          installableStoreOffer
            ? 'text-muted hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground'
            : 'bg-primary text-on-primary hover:bg-primary-hover data-[state=open]:bg-primary-hover'
        ]}
        title="Install an extension"
        aria-label="Install an extension"
      >
        <Plus size={13} />
        Install extension
        <ChevronDown size={12} class="shrink-0" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          class="z-60 w-64 rounded-xl border border-border bg-surface p-1 shadow-lg"
        >
          {#each installDoors as door (door.id)}
            {@const DoorIcon = door.icon}
            <DropdownMenu.Item
              class="flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
              textValue={door.label}
              onSelect={door.run}
            >
              <DoorIcon size={14} class="mt-0.5 shrink-0 text-muted" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium text-foreground">{door.label}</span>
                <span class="mt-0.5 block text-[0.625rem] leading-relaxed text-dimmed">
                  {door.hint}
                </span>
              </span>
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>

  <!-- The scope comes before everything it scopes: the box picker is the panel's
       own control, so it sits directly under the header and the page's offer,
       the install in flight and the list all read below it. -->
  <div class="shrink-0 border-b border-border px-3 py-2">
    <EnumSelect
      options={boxOptions}
      value={selection}
      onChange={(id) => (selection = id)}
      placeholder="Choose a box"
      ariaLabel="Box whose extensions are listed"
      title="Box whose extensions are listed"
    />
  </div>

  {#if installableStoreOffer}
    <div class="shrink-0 border-b border-border px-3 py-2">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-lg bg-primary px-2.5 py-2 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        disabled={installableStoreOffer.install !== null}
        title={`${offerInstallVerb ?? 'Install'} ${installableStoreOffer.name ?? 'this extension'} in ${installableStoreOffer.boxName}`}
        aria-label={`${offerInstallVerb ?? 'Install'} ${installableStoreOffer.name ?? 'this extension'} in ${installableStoreOffer.boxName}`}
        onclick={() => void installStoreExtensionOffer()}
      >
        <Puzzle size={13} class="shrink-0" />
        <span class="min-w-0 truncate"
          >{offerInstallVerb ?? 'Install'}
          {installableStoreOffer.name ?? 'this extension'}</span
        >
      </button>
      <p class="mt-1.5 text-[0.625rem] leading-relaxed text-dimmed">
        The extension on the store page you are on. It lands in {installableStoreOffer.boxName}.
      </p>
    </div>
  {/if}

  {#if browserExtensions.installs.length > 0}
    <!-- Installs overlap, so this lists every one of them: the two running and
         whatever is waiting behind them. An install can also start from the
         browser chrome on a store page, where this panel's menu was never opened,
         so this is the only place either of them is reported. -->
    <div class="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
      {#each browserExtensions.installs as install (install.installId)}
        <BrowserExtensionInstallProgress {install} />
      {/each}
    </div>
  {/if}

  {#if shown.length === 0}
    <EmptyState
      icon={Puzzle}
      title={scopedBox ? `Nothing in ${scopedBox.name} yet` : 'No extensions yet'}
      description={scopedBox
        ? 'Install one and it lands in this box. Other boxes can be turned on later from its settings.'
        : 'An extension runs inside the boxes you choose, keeps its own storage in each, and is only loaded while a tab is open in one of them.'}
    />
  {:else}
    <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
      {#each shown as extension (extension.id)}
        {@const pin = pinAction(extension)}
        {@const popup = popupAction(extension)}
        {@const updating = browserExtensions.isUpdating(extension.id)}
        <li
          draggable
          ondragstart={(event) => {
            draggingId = extension.id
            event.dataTransfer?.setData('text/plain', extension.id)
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
          }}
          ondragover={(event) => event.preventDefault()}
          ondrop={(event) => {
            event.preventDefault()
            dropExtension(extension.id)
          }}
          ondragend={() => (draggingId = null)}
          class:opacity-50={draggingId === extension.id}
        >
          <div
            class="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-elevated"
          >
            {#if popup.open}
              <!-- The identity is the door: one click on the extension opens its own
                   popup in the rail, the same gesture a browser's icon takes. -->
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                title={popup.title}
                aria-label={popup.title}
                onclick={() => void openExtensionPopup(extension)}
              >
                {@render extensionIdentity(extension)}
              </button>
            {:else}
              <span
                class="flex min-w-0 flex-1 items-center gap-2"
                title={popup.refusal || undefined}
              >
                {@render extensionIdentity(extension)}
              </span>
            {/if}
            {#if showChips}
              <BrowserBoxChips jars={extension.boxes} />
            {/if}
            {#if extension.updateAvailableVersion || updating}
              {@const updateTitle = extension.updateAvailableVersion
                ? `Update ${extension.name} to version ${extension.updateAvailableVersion}`
                : `Updating ${extension.name}`}
              <button
                type="button"
                class="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-wait disabled:opacity-60"
                disabled={updating}
                title={updating ? `Updating ${extension.name}` : updateTitle}
                aria-label={updating ? `Updating ${extension.name}` : updateTitle}
                onclick={() => void browserExtensions.updateFromWebStore(extension.id)}
              >
                {#if updating}
                  <LoaderCircle size={12} class="animate-spin" />
                  Updating
                {:else}
                  <Download size={12} />
                  Update
                {/if}
              </button>
            {/if}
            <Switch
              checked={extension.enabled}
              disabled={updating}
              title={updating
                ? `Updating ${extension.name}`
                : extension.enabled
                  ? `Disable ${extension.name}`
                  : `Enable ${extension.name}`}
              aria-label={updating
                ? `Updating ${extension.name}`
                : extension.enabled
                  ? `Disable ${extension.name}`
                  : `Enable ${extension.name}`}
              onchange={(next) => void browserExtensions.setEnabled(extension.id, next)}
            />
            <button
              type="button"
              class={[
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-overlay hover:text-foreground focus-visible:opacity-100',
                pin.disabled
                  ? 'cursor-not-allowed text-muted opacity-40'
                  : extension.pinned
                    ? 'text-foreground'
                    : 'text-muted opacity-0 group-hover:opacity-100'
              ]}
              disabled={pin.disabled || updating}
              title={updating ? `Updating ${extension.name}` : pin.title}
              aria-label={updating ? `Updating ${extension.name}` : pin.title}
              onclick={() => void browserExtensions.setPinned(extension.id, !extension.pinned)}
            >
              <Pin size={13} />
            </button>
            <button
              type="button"
              class={[
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100',
                expandedId === extension.id ? 'opacity-100' : 'opacity-0'
              ]}
              title={expandedId === extension.id
                ? `Hide ${extension.name} settings`
                : `Settings for ${extension.name}`}
              aria-label={expandedId === extension.id
                ? `Hide ${extension.name} settings`
                : `Settings for ${extension.name}`}
              aria-expanded={expandedId === extension.id}
              aria-controls="extension-settings-{extension.id}"
              onclick={() => (expandedId = expandedId === extension.id ? null : extension.id)}
            >
              <ChevronDown size={13} class={expandedId === extension.id ? 'rotate-180' : ''} />
            </button>
          </div>

          {#if expandedId === extension.id}
            <div
              id="extension-settings-{extension.id}"
              class="mb-1 space-y-2.5 rounded-lg border px-3 py-2.5"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-xs text-foreground">
                    {extension.enabled ? 'Enabled' : 'Disabled'}
                  </p>
                  <p class="mt-0.5 text-[0.625rem] leading-relaxed text-dimmed">
                    A disabled extension is installed but loaded nowhere.
                  </p>
                </div>
                <Switch
                  checked={extension.enabled}
                  disabled={updating}
                  title={updating
                    ? `Updating ${extension.name}`
                    : extension.enabled
                      ? `Disable ${extension.name}`
                      : `Enable ${extension.name}`}
                  aria-label={updating
                    ? `Updating ${extension.name}`
                    : extension.enabled
                      ? `Disable ${extension.name}`
                      : `Enable ${extension.name}`}
                  onchange={(next) => void browserExtensions.setEnabled(extension.id, next)}
                />
              </div>

              <div class="space-y-1.5">
                <p class="text-xs text-foreground">Run in</p>
                <p class="text-[0.625rem] leading-relaxed text-dimmed">
                  Only the boxes you turn on load it, and each keeps its own storage. A box you make
                  later stays off until you turn it on here.
                </p>
                <div class="space-y-0.5 rounded-lg border p-1">
                  {#each jarChoices() as jar (jar.id)}
                    <div class="flex items-center justify-between gap-3 px-2 py-1">
                      <span class="flex min-w-0 items-center gap-2">
                        {#if jar.iconUrl}
                          <img
                            src={jar.iconUrl}
                            alt=""
                            class="h-3.5 w-3.5 shrink-0 rounded-sm object-contain"
                          />
                        {:else}
                          <span
                            class="h-2 w-2 shrink-0 rounded-full"
                            style:background-color={jar.accent}
                          ></span>
                        {/if}
                        <span class="truncate text-[0.6875rem]" style="color: {jar.accent}">
                          {jar.name}
                        </span>
                      </span>
                      <Switch
                        checked={runsInBox(extension, jar.id)}
                        disabled={updating}
                        title={`Run in ${jar.name}`}
                        aria-label={`Run in ${jar.name}`}
                        onchange={(next) => toggleBox(extension, jar.id, next)}
                      />
                    </div>
                  {/each}
                </div>
              </div>

              <p class="text-[0.625rem] leading-relaxed text-dimmed">
                Version {extension.version} · {extension.popupPath ? 'Has a popup' : 'No popup'}
              </p>

              <p
                class="rounded-lg border bg-elevated/50 px-2.5 py-2 text-[0.625rem] leading-relaxed text-dimmed"
              >
                {browserExtensionInjectionLabel(extension.injected)}
              </p>

              {#if extension.missingCapabilities.length > 0}
                <div class="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2">
                  <div class="flex items-center gap-1.5">
                    <AlertTriangle size={12} class="shrink-0 text-warning" />
                    <p class="text-[0.6875rem] font-medium text-foreground">
                      {extension.missingCapabilities.length === 1
                        ? 'One capability is unavailable'
                        : `${extension.missingCapabilities.length} capabilities are unavailable`}
                    </p>
                  </div>
                  <ul class="mt-1 space-y-0.5 pl-4 text-[0.625rem] leading-relaxed text-muted">
                    {#each extension.missingCapabilities as capability (capability)}
                      <li class="list-disc">{capability}</li>
                    {/each}
                  </ul>
                </div>
              {/if}

              {#if extension.warnings.length > 0}
                <div class="rounded-lg border bg-elevated/50 px-2.5 py-2">
                  <p class="text-[0.6875rem] font-medium text-foreground">Warnings</p>
                  <ul class="mt-1 space-y-0.5 pl-4 text-[0.625rem] leading-relaxed text-muted">
                    {#each extension.warnings as warning (warning)}
                      <li class="list-disc">{warning}</li>
                    {/each}
                  </ul>
                </div>
              {/if}

              <button
                type="button"
                class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.6875rem] text-danger transition-colors hover:bg-danger/10"
                disabled={updating}
                title={updating ? `Updating ${extension.name}` : `Uninstall ${extension.name}`}
                aria-label={updating ? `Updating ${extension.name}` : `Uninstall ${extension.name}`}
                onclick={() => (uninstallTarget = extension)}
              >
                <Trash2 size={13} />
                Uninstall
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <p
      class="shrink-0 border-t border-border px-3 py-1.5 text-[0.625rem] leading-relaxed text-dimmed"
    >
      An extension is loaded into each box you enable it in, and only while a tab is open in that
      box, in any browser. Turn it off to unload it everywhere without uninstalling.
    </p>
  {/if}
</div>

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
