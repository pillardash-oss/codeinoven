<script lang="ts">
  import { onMount } from 'svelte'
  import { ClipboardPaste, Copy, ExternalLink, Link, Scissors, TextSelect } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'

  type MenuKind = 'text' | 'editable'

  interface TextMenuTarget {
    kind: MenuKind
    x: number
    y: number
    text: string
    linkHref: string | null
    /** Editable element for Cut / Paste / Select All actions. */
    editable: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
  }

  let target = $state<TextMenuTarget | null>(null)
  let menuEl: HTMLDivElement | null = $state(null)
  let menuWidth = $state(0)
  let menuHeight = $state(0)

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

  function safeExternalUrl(href: string): string | null {
    try {
      const url = new URL(href, window.location.href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      return url.toString()
    } catch {
      return null
    }
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

    const editable = asEditableField(element)
    if (editable) {
      const text =
        editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement
          ? editableSelection(editable)
          : selectionText()
      return { kind: 'editable', x: event.clientX, y: event.clientY, text, linkHref: null, editable }
    }

    // Citation links have their own dedicated context menu.
    const anchor = element.closest('a')
    if (anchor instanceof HTMLAnchorElement && anchor.dataset.citationPath) {
      return null
    }

    const text = selectionText()
    const linkHref = anchor ? safeExternalUrl(anchor.getAttribute('href') ?? '') : null

    // Only take over when there is something selected or a link was hit;
    // otherwise the native menu is more useful (e.g. spellcheck, inspect).
    if (!text && !linkHref) return null

    return { kind: 'text', x: event.clientX, y: event.clientY, text, linkHref, editable: null }
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
    if (event.key === 'Escape') close()
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
    bind:this={menuEl}
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
          Open in Default Browser
        </button>
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
