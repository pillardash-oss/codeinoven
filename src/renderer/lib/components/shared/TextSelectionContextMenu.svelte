<script lang="ts">
  import { onMount } from 'svelte'
  import { Copy, ExternalLink, Link } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'

  interface TextMenuTarget {
    x: number
    y: number
    text: string
    linkHref: string | null
  }

  let target = $state<TextMenuTarget | null>(null)
  let menuEl: HTMLDivElement | null = $state(null)
  let menuWidth = $state(0)
  let menuHeight = $state(0)

  const itemClass =
    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none hover:bg-elevated focus-visible:bg-elevated'

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

  /**
   * Decide whether this right-click should open the text-selection menu.
   * Returns the menu target, or null to let the existing context menu
   * behavior (native menu, citation menus, etc.) proceed untouched.
   */
  function resolveTarget(event: MouseEvent): TextMenuTarget | null {
    const element = event.target instanceof Element ? event.target : null
    if (!element) return null

    // Leave editable fields to the native Electron context menu
    // (copy/paste/select-all there, not just copy).
    if (element.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) {
      return null
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

    return { x: event.clientX, y: event.clientY, text, linkHref }
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

  async function copy(value: string, label: string): Promise<void> {
    try {
      await copyText(value)
    } catch {
      toast.error(`Failed to copy ${label}`)
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
    // stop them when a text selection takes priority.
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
    {#if target.text}
      <button type="button" class={itemClass} role="menuitem" onclick={() => copy(target!.text, 'text')}>
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
  </div>
{/if}
