<script lang="ts">
  import { tick } from 'svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'

  interface Props {
    text: string
    fallback?: string
    class?: string
    ariaLabel: string
    readOnly?: boolean
    onChange: (value: string) => void
    onAnnotateMermaid?: (code: string, event: MouseEvent) => void
  }

  let {
    text,
    fallback = 'Not defined.',
    class: className = '',
    ariaLabel,
    readOnly = false,
    onChange,
    onAnnotateMermaid
  }: Props = $props()

  let editing = $state(false)
  let draft = ''
  let editor = $state<HTMLElement | null>(null)

  function attachEditor(node: HTMLElement): () => void {
    editor = node
    return () => {
      if (editor === node) editor = null
    }
  }

  async function startEditing(): Promise<void> {
    if (editing || readOnly) return
    draft = text
    editing = true
    await tick()
    if (!editor) return
    // The browser owns the active contenteditable subtree so reactive updates
    // cannot replace its text node and reset the selection on every keystroke.
    editor.textContent = draft
    editor.focus()

    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  function updateDraft(event: Event): void {
    draft =
      event.currentTarget instanceof HTMLElement ? (event.currentTarget.textContent ?? '') : draft
  }

  function finishEditing(): void {
    if (!editing) return
    editing = false
    const next = draft.trim()
    if (next !== text) onChange(next)
  }

  function cancelEditing(): void {
    draft = text
    editing = false
  }

  function preserveDoubleClickForEditing(event: MouseEvent): void {
    if (event.detail > 1) event.stopPropagation()
  }
</script>

{#if editing}
  <div
    {@attach attachEditor}
    class={className}
    contenteditable="plaintext-only"
    role="textbox"
    aria-label={ariaLabel}
    tabindex="0"
    oninput={updateDraft}
    onblur={finishEditing}
    onkeydown={(event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelEditing()
      }
    }}
  ></div>
{:else if readOnly}
  <div class={className} role="document" aria-label={ariaLabel}>
    <MarkdownView text={text || fallback} {onAnnotateMermaid} />
  </div>
{:else}
  <div
    class="{className} cursor-text"
    role="textbox"
    aria-label={ariaLabel}
    tabindex="0"
    onmouseup={preserveDoubleClickForEditing}
    ondblclick={startEditing}
    onkeydown={(event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        void startEditing()
      }
    }}
  >
    <MarkdownView text={text || fallback} {onAnnotateMermaid} />
  </div>
{/if}
