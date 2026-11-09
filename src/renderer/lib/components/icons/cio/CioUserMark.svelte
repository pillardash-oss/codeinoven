<script lang="ts">
  /**
   * The user's own mark in a group thread: a square monogram carrying the first
   * letter of the name they asked to be called.
   *
   * It is drawn rather than photographed: there is no picture of the user in the
   * app, and a group thread needs a mark on the left of their messages that sits
   * at the same 16px as the assistants' marks beside it, so the conversation
   * reads as one list of speakers rather than two kinds of row. The letter comes
   * from their name, so it needs no font of its own and no image to load.
   *
   * Every corner is square, as everywhere else in the app, and the ink is a
   * token so the mark follows the palette in both themes.
   */
  interface Props {
    /** The name the monogram is built from. */
    name: string
    class?: string
  }

  let { name, class: className = '' }: Props = $props()

  /**
   * The one letter the mark carries. A name is trimmed before it is read, so a
   * leading space never produces an empty mark, and an empty name falls back to
   * a question mark rather than drawing nothing at all.
   */
  const initial = $derived(name.trim().slice(0, 1).toLocaleUpperCase() || '?')
</script>

<!-- The name is always printed beside this, so the mark itself is decoration and
     a screen reader must skip it instead of reading the letter twice. -->
<span
  class="flex size-4 shrink-0 items-center justify-center border border-border bg-elevated text-[0.5625rem] leading-none font-semibold text-foreground {className}"
  aria-hidden="true">{initial}</span
>
