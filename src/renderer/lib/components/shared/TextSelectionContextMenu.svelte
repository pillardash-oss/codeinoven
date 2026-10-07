<script lang="ts">
  import { SUPPORT_EMAIL } from '$shared/brand'
  import { onMount } from 'svelte'
  import {
    ClipboardPaste,
    Copy,
    Eraser,
    ExternalLink,
    Globe,
    GlobeCode,
    Link,
    Scissors,
    TextSelect
  } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import {
    canOpenInCioBrowser,
    openInCioBrowser,
    openInGlobalBrowserTabOnScreen,
    openInGlobalCioBrowser
  } from '$lib/open-in-browser'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { terminalEntryForHost, type TerminalHostEntry } from '$lib/terminal/host-registry'
  import { buildPasteData } from '$lib/terminal/input-compat'
  import { selectWordAt } from '$lib/terminal/word-select'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'

  type MenuKind = 'text' | 'editable' | 'terminal'

  interface TextMenuTarget {
    kind: MenuKind
    x: number
    y: number
    text: string
    linkHref: string | null
    /** Editable element for Cut / Paste / Select All actions. */
    editable: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
    /** Live terminal for terminal Copy / Paste / Select All / Clear actions. */
    terminal: TerminalHostEntry | null
  }

  let target = $state<TextMenuTarget | null>(null)
  let menuEl: HTMLDivElement | null = null

  function captureMenu(element: HTMLDivElement): () => void {
    menuEl = element
    return () => {
      menuEl = null
    }
  }
  let menuWidth = $state(0)
  let menuHeight = $state(0)
  /** The thread browser takes a page only while a project thread is on screen to
   *  own the tab, so the thread item is offered exactly when it can work. The
   *  global browser needs no thread, so its item is always offered. */
  const cioBrowserAvailable = $derived(canOpenInCioBrowser())
  /**
   * Whether the reader is in the app-wide browser view itself.
   *
   * That view is where the global browser's own tab is on screen, so a link there
   * belongs to it: the thread browser would point at a project thread's tab the
   * reader is not using, and "open in the global browser" would name what is
   * already in front of them. The menu answers with the two destinations that
   * make sense there, a new tab and the tab on screen.
   */
  const browsingInApp = $derived(rendererRecovery.activeView === 'browser')

  const itemClass =
    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none hover:bg-elevated focus-visible:bg-elevated disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent'

  const positionStyle = $derived.by(() => {
    if (!target) return ''
    const width = menuWidth || 200
    const height = menuHeight || 100
    const left = Math.min(target.x, window.innerWidth - width - 8)
    const top = Math.min(target.y, window.innerHeight - height - 8)
    return `left: ${Math.max(8, left)}px; top: ${Math.max(8, top)}px;`
  })

  /**
   * Absolute web address as this app's menus mean it: something the default
   * browser can be handed.
   *
   * Relative and fragment-only hrefs are refused rather than resolved against
   * the app's own origin: the renderer has no web-facing address, so
   * `new URL('#fn-2', location.href)` would offer "Copy Link" for a footnote a
   * reader could never open.
   */
  function externalUrl(value: string): string | null {
    try {
      const url = new URL(value)
      if (
        url.protocol !== 'http:' &&
        url.protocol !== 'https:' &&
        !(url.protocol === 'mailto:' && url.pathname === SUPPORT_EMAIL)
      )
        return null
      return url.toString()
    } catch {
      return null
    }
  }

  /**
   * The external address an element stands for, when it is not a link.
   *
   * An "open on GitHub" control is a button: it has no `href` for a context menu
   * to read, so it declares the address it opens in a `data-external-url`
   * attribute instead, and right-clicking it offers exactly the items a real
   * link gets. Reading it from the closest ancestor lets a decorative icon sit
   * inside the declaring control without breaking the lookup.
   */
  function declaredExternalUrl(element: Element): string | null {
    const declaring = element.closest('[data-external-url]')
    if (!(declaring instanceof HTMLElement)) return null
    const value = declaring.dataset.externalUrl
    return value ? externalUrl(value) : null
  }

  /** The external address of an anchor, ignoring links that stay in the app. */
  function anchorExternalUrl(anchor: HTMLAnchorElement): string | null {
    return externalUrl(anchor.getAttribute('href') ?? '')
  }

  function selectionText(): string {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return ''
    return selection.toString()
  }

  function asEditableField(
    element: Element
  ): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element
    }
    if (element instanceof HTMLElement && element.isContentEditable) return element
    const closest = element.closest(
      'input, textarea, [contenteditable="true"], [contenteditable=""]'
    )
    if (closest instanceof HTMLInputElement || closest instanceof HTMLTextAreaElement) {
      return closest
    }
    return closest instanceof HTMLElement && closest.isContentEditable ? closest : null
  }

  function editableSelection(element: HTMLInputElement | HTMLTextAreaElement): string {
    const { selectionStart, selectionEnd } = element
    if (selectionStart === null || selectionEnd === null) return ''
    return element.value.slice(selectionStart, selectionEnd)
  }

  /**
   * Decide whether this right-click should open this menu. Returns the menu
   * target, or null to let other context menu behavior proceed untouched.
   */
  function resolveTarget(event: MouseEvent): TextMenuTarget | null {
    const element = event.target instanceof Element ? event.target : null
    if (!element) return null

    // Terminals own their selection on canvas (no DOM selection) and render
    // text via the GPU, so they must be resolved before the editable and text
    // heuristics below — both of which would decline and fall through to the
    // native menu, whose Copy item is blind to the terminal selection.
    const terminalHost = element.closest('.terminal-host')
    if (terminalHost instanceof HTMLElement) {
      const terminal = terminalEntryForHost(terminalHost)
      if (terminal) {
        let text = terminal.term.hasSelection() ? terminal.term.getSelection() : ''
        if (!text) text = selectWordAt(terminal.term, terminalHost, event.clientX, event.clientY)
        return {
          kind: 'terminal',
          x: event.clientX,
          y: event.clientY,
          text,
          linkHref: null,
          editable: null,
          terminal
        }
      }
    }

    const editable = asEditableField(element)
    if (editable) {
      const text =
        editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement
          ? editableSelection(editable)
          : selectionText()
      return {
        kind: 'editable',
        x: event.clientX,
        y: event.clientY,
        text,
        linkHref: null,
        editable,
        terminal: null
      }
    }

    // Citation links have their own dedicated context menu.
    const anchor = element.closest('a')
    if (anchor instanceof HTMLAnchorElement && anchor.dataset.citationPath) {
      return null
    }

    const text = selectionText()
    const linkHref = anchor ? anchorExternalUrl(anchor) : declaredExternalUrl(element)

    // Only take over when there is something selected or a link was hit;
    // otherwise the native menu is more useful (e.g. spellcheck, inspect).
    if (!text && !linkHref) return null

    return {
      kind: 'text',
      x: event.clientX,
      y: event.clientY,
      text,
      linkHref,
      editable: null,
      terminal: null
    }
  }

  function handleContextMenu(event: MouseEvent): void {
    const resolved = resolveTarget(event)
    if (!resolved) return
    event.preventDefault()
    event.stopPropagation()
    target = resolved
  }

  function close(): void {
    target = null
  }

  function dismiss(event: MouseEvent): void {
    if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) return
    close()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (keymapState.matches('palette-close', event)) close()
  }

  function refocusEditable(element: TextMenuTarget['editable']): void {
    element?.focus()
  }

  async function copy(value: string, label: string): Promise<void> {
    try {
      await copyText(value)
    } catch {
      toast.error(`Failed to copy ${label}`)
    }
    close()
  }

  async function cut(t: TextMenuTarget): Promise<void> {
    const element = t.editable
    if (!element || !t.text) {
      close()
      return
    }
    refocusEditable(element)
    try {
      await copyText(t.text)
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const start = element.selectionStart ?? 0
        const end = element.selectionEnd ?? 0
        element.setRangeText('', start, end, 'end')
        element.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        window.getSelection()?.deleteFromDocument()
      }
    } catch {
      toast.error('Failed to cut text')
    }
    close()
  }

  async function paste(t: TextMenuTarget): Promise<void> {
    const element = t.editable
    if (!element) {
      close()
      return
    }
    refocusEditable(element)
    try {
      const clipboardText = await invoke('clipboard:readText')
      if (clipboardText) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const start = element.selectionStart ?? element.value.length
          const end = element.selectionEnd ?? element.value.length
          element.setRangeText(clipboardText, start, end, 'end')
          element.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          document.execCommand('insertText', false, clipboardText)
        }
      }
    } catch {
      toast.error('Failed to paste text')
    }
    close()
  }

  function selectAll(t: TextMenuTarget): void {
    const element = t.editable
    if (!element) return
    refocusEditable(element)
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.select()
    } else {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    close()
  }

  async function openInBrowser(href: string): Promise<void> {
    try {
      await invoke('shell:openExternal', href)
    } catch {
      toast.error('Failed to open link in browser')
    }
    close()
  }

  /**
   * Load the link in the in-app browser instead of handing it to the system
   * one. The menu is dismissed first: the browser renders a native view
   * composited above every DOM surface, so a menu still on screen would be
   * painted underneath the page that replaces it.
   */
  function openLinkInCioBrowser(href: string): void {
    close()
    if (openInCioBrowser(href)) return
    toast.error('The CIO browser has no project thread to open this link in')
  }

  /**
   * Load the link in the app-wide global browser instead of a project's tab. The
   * menu is dismissed first for the same reason as above: the browser renders a
   * native view composited above every DOM surface.
   */
  function openLinkInGlobalCioBrowser(href: string): void {
    close()
    openInGlobalCioBrowser(href)
  }

  /**
   * Load the link in the browser tab already on screen, moving the page the user
   * is reading rather than opening a second one beside it. The menu is dismissed
   * first for the same reason as above: the page is a native view composited over
   * every DOM surface.
   */
  function openLinkInActiveBrowserTab(href: string): void {
    close()
    openInGlobalBrowserTabOnScreen(href)
  }

  async function pasteIntoTerminal(t: TextMenuTarget): Promise<void> {
    const terminal = t.terminal
    if (!terminal) {
      close()
      return
    }
    try {
      const clipboardText = await invoke('clipboard:readText')
      if (clipboardText) {
        terminal.write(buildPasteData(terminal.term, clipboardText))
      }
    } catch {
      toast.error('Failed to paste into terminal')
    }
    close()
  }

  function selectAllInTerminal(t: TextMenuTarget): void {
    t.terminal?.term.selectAll()
    close()
  }

  function clearTerminal(t: TextMenuTarget): void {
    t.terminal?.term.clear()
    close()
  }

  onMount(() => {
    // Capture phase so we run before bits-ui citation menu triggers and can
    // stop them when an editable field or text selection takes priority.
    window.addEventListener('contextmenu', handleContextMenu, true)
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', handleKeydown, true)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('contextmenu', handleContextMenu, true)
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', handleKeydown, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  })
</script>

{#if target}
  <div
    {@attach captureMenu}
    bind:clientWidth={menuWidth}
    bind:clientHeight={menuHeight}
    class="fixed z-50 min-w-44 rounded-lg border border-border bg-surface p-1 shadow-xl"
    style={positionStyle}
    role="menu"
  >
    {#if target.kind === 'editable'}
      <button
        type="button"
        class={itemClass}
        role="menuitem"
        disabled={!target.text}
        onclick={() => cut(target!)}
      >
        <Scissors class="size-3.5 shrink-0 text-text-muted" />
        Cut
      </button>
      <button
        type="button"
        class={itemClass}
        role="menuitem"
        disabled={!target.text}
        onclick={() => copy(target!.text, 'text')}
      >
        <Copy class="size-3.5 shrink-0 text-text-muted" />
        Copy
      </button>
      <button type="button" class={itemClass} role="menuitem" onclick={() => paste(target!)}>
        <ClipboardPaste class="size-3.5 shrink-0 text-text-muted" />
        Paste
      </button>
      <button type="button" class={itemClass} role="menuitem" onclick={() => selectAll(target!)}>
        <TextSelect class="size-3.5 shrink-0 text-text-muted" />
        Select All
      </button>
    {:else if target.kind === 'terminal'}
      <button
        type="button"
        class={itemClass}
        role="menuitem"
        disabled={!target.text}
        onclick={() => copy(target!.text, 'text')}
      >
        <Copy class="size-3.5 shrink-0 text-text-muted" />
        Copy
      </button>
      <button
        type="button"
        class={itemClass}
        role="menuitem"
        onclick={() => pasteIntoTerminal(target!)}
      >
        <ClipboardPaste class="size-3.5 shrink-0 text-text-muted" />
        Paste
      </button>
      <button
        type="button"
        class={itemClass}
        role="menuitem"
        onclick={() => selectAllInTerminal(target!)}
      >
        <TextSelect class="size-3.5 shrink-0 text-text-muted" />
        Select All
      </button>
      <button
        type="button"
        class={itemClass}
        role="menuitem"
        onclick={() => clearTerminal(target!)}
      >
        <Eraser class="size-3.5 shrink-0 text-text-muted" />
        Clear
      </button>
    {:else}
      {#if target.text}
        <button
          type="button"
          class={itemClass}
          role="menuitem"
          onclick={() => copy(target!.text, 'text')}
        >
          <Copy class="size-3.5 shrink-0 text-text-muted" />
          Copy
        </button>
      {/if}
      {#if target.linkHref}
        <button
          type="button"
          class={itemClass}
          role="menuitem"
          onclick={() => openInBrowser(target!.linkHref!)}
        >
          <ExternalLink class="size-3.5 shrink-0 text-text-muted" />
          {target.linkHref.startsWith('mailto:') ? 'Open in Email App' : 'Open in Default Browser'}
        </button>
        {#if !target.linkHref.startsWith('mailto:')}
          {#if browsingInApp}
            <button
              type="button"
              class={itemClass}
              role="menuitem"
              title="Open in a new tab of the app-wide browser"
              onclick={() => openLinkInGlobalCioBrowser(target!.linkHref!)}
            >
              <Globe class="size-3.5 shrink-0 text-text-muted" />
              Open in New Tab
            </button>
            <button
              type="button"
              class={itemClass}
              role="menuitem"
              title="Open in the browser tab already on screen"
              onclick={() => openLinkInActiveBrowserTab(target!.linkHref!)}
            >
              <GlobeCode class="size-3.5 shrink-0 text-text-muted" />
              Open in Current Tab
            </button>
          {:else}
            <button
              type="button"
              class={itemClass}
              role="menuitem"
              title="Open in the app-wide global browser"
              onclick={() => openLinkInGlobalCioBrowser(target!.linkHref!)}
            >
              <Globe class="size-3.5 shrink-0 text-text-muted" />
              Open in Global CIO Browser
            </button>
            {#if cioBrowserAvailable}
              <button
                type="button"
                class={itemClass}
                role="menuitem"
                title="Open in the CIO browser tab for this project"
                onclick={() => openLinkInCioBrowser(target!.linkHref!)}
              >
                <GlobeCode class="size-3.5 shrink-0 text-text-muted" />
                Open in Thread Browser
              </button>
            {/if}
          {/if}
        {/if}
        <button
          type="button"
          class={itemClass}
          role="menuitem"
          onclick={() => copy(target!.linkHref!, 'link')}
        >
          <Link class="size-3.5 shrink-0 text-text-muted" />
          Copy Link
        </button>
        {#if target.text}
          <button
            type="button"
            class={itemClass}
            role="menuitem"
            onclick={() => copy(target!.text, 'text')}
          >
            <Copy class="size-3.5 shrink-0 text-text-muted" />
            Copy Text
          </button>
        {/if}
      {/if}
    {/if}
  </div>
{/if}
