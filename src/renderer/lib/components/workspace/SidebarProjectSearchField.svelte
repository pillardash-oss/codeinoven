<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    /** The id the strip's trigger points at with `aria-controls`. */
    id: string
    query: string
    onQueryChange: (value: string) => void
    onClose: () => void
    placeholder: string
    ariaLabel: string
    loading?: boolean
  }

  let {
    id,
    query,
    onQueryChange,
    onClose,
    placeholder,
    ariaLabel,
    loading = false
  }: Props = $props()

  // The trigger in the project strip opens this field, so the field takes the
  // focus as soon as it exists: the user's next keystroke belongs in it.
  const focusField: Attachment<HTMLInputElement> = (element) => {
    element.focus()
  }
</script>

<!--
  The project's own search field, drawn in the list it searches.

  It used to be a floating panel beside the strip's icon: 20rem wide, opened to
  the side of a narrow sidebar, it landed on top of the thread titles the user
  was trying to read. Here it takes its own line under the project it belongs
  to, above the results it replaces, and covers nothing.
-->
<div class="flex w-full items-center gap-1.5 border-b bg-elevated px-2 py-1.5">
  <CioSearch size={12} class="shrink-0 text-dimmed" />
  <input
    {id}
    {@attach focusField}
    type="text"
    class="h-6 min-w-0 flex-1 bg-app px-1.5 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed"
    {placeholder}
    aria-label={ariaLabel}
    onkeydown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }}
    value={query}
    oninput={(e: Event) => onQueryChange((e.currentTarget as HTMLInputElement).value)}
  />
  {#if loading}
    <span
      class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed"
      role="status"
      aria-label="Searching"
    >
      <CioSpinner size={12} class="animate-spin" />
    </span>
  {/if}
  <button
    type="button"
    class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
    aria-label="Dismiss search"
    title="Dismiss search"
    onclick={onClose}
  >
    <CioClose size={12} />
  </button>
</div>
