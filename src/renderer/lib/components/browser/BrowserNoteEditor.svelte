<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Check, Globe } from '@lucide/svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import {
    MAX_BROWSER_TAB_NOTE_LENGTH,
    type GlobalBrowserTab
  } from '$lib/stores/global-browser-types'

  interface Props {
    tab: GlobalBrowserTab
  }

  let { tab }: Props = $props()

  /**
   * The note editor for one tab.
   *
   * It is mounted inside a `{#key tab.id}` block, so switching tabs builds a new
   * editor and the note always starts from the tab it names; that is what keeps
   * the caret from being reset mid-typing by the store's own echo of what was
   * just typed.
   *
   * Saving is debounced: the store writes the whole snapshot to storage, and a
   * keystroke-per-write would serialize the strip a hundred times a sentence.
   */

  // The keyed mount is the sync point, so capturing the initial value here is
  // exactly the intent rather than a missed subscription.
  // svelte-ignore state_referenced_locally
  let draft = $state(tab.note)
  /** The last value written through, so the "Saved" chip answers the debounce
   *  rather than the keystroke. */
  // svelte-ignore state_referenced_locally
  let savedNote = $state(tab.note)
  let timer: number | null = null

  const dirty = $derived(draft !== savedNote)

  function flush(): void {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    if (draft === savedNote) return
    globalBrowser.setNote(tab.id, draft)
    savedNote = draft
  }

  function onInput(value: string): void {
    draft = value
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      globalBrowser.setNote(tab.id, draft)
      savedNote = draft
    }, 400)
  }

  onDestroy(flush)
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3">
  <div class="flex min-w-0 items-center gap-2">
    <span class="flex h-4 w-4 shrink-0 items-center justify-center">
      {#if tab.favicon}
        <img src={tab.favicon} alt="" class="h-4 w-4 rounded-sm object-contain" />
      {:else}
        <Globe size={13} class="text-dimmed" />
      {/if}
    </span>
    <span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={tab.title}>
      {tab.title}
    </span>
    {#if !dirty && savedNote.trim() !== ''}
      <span class="flex shrink-0 items-center gap-1 text-[0.625rem] text-dimmed">
        <Check size={11} />
        Saved
      </span>
    {/if}
  </div>

  <textarea
    class="min-h-0 w-full flex-1 resize-none rounded-lg border bg-elevated px-2.5 py-2 text-xs leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
    placeholder="Notes for this tab. Context the agent can read, reminders, credentials locations…"
    aria-label={`Note for ${tab.title}`}
    maxlength={MAX_BROWSER_TAB_NOTE_LENGTH}
    value={draft}
    oninput={(event: Event) => {
      if (event.currentTarget instanceof HTMLTextAreaElement) onInput(event.currentTarget.value)
    }}
    onblur={flush}></textarea>

  <p class="text-[0.625rem] leading-relaxed text-dimmed">
    The note stays with this tab across hibernation, group moves and restarts.
  </p>
</div>
