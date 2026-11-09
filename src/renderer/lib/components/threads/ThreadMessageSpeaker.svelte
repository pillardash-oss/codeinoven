<script lang="ts">
  import {
    AssistantDefaultIcon,
    assistantAccentColor,
    getAssistantIcon
  } from '$lib/assistant-icons'
  import type { MessageAuthor } from '$shared/types'

  /**
   * One speaker line above a reply in a group thread.
   *
   * A group thread holds several assistants, so a reply that does not say who
   * spoke is unreadable: the reader gets an answer with no author. This line is
   * the smallest thing that answers "who": the speaker's own mark at 16px, its
   * name, and a thin accent rule in the colour that speaker wears in the
   * assistant panel.
   *
   * It deliberately draws nothing else. No timestamp, no model badge, no
   * controls: the turn's metadata footer already reports those under the same
   * reply, and a speaker line that repeated them would put the transcript's
   * machinery on every message of a conversation.
   */
  interface Props {
    /** The speaker's name, printed beside its mark. */
    name: string
    /**
     * The speaker's resolved mark: a data URL, either the assistant's own SVG
     * icon tinted with its accent or its stored image icon, or null when it has
     * neither and the default assistant mark is drawn instead.
     */
    icon?: string | null
    /**
     * The speaker as its message recorded it. A message carries a snapshot,
     * because the assistant may be renamed, re-iconed or deleted long after it
     * spoke, so this fills in the mark and the accent when the caller has no
     * resolved icon of its own to hand over.
     */
    author?: MessageAuthor
    /** The accent the rule is drawn in; falls back to the snapshot's own colour. */
    color?: string
    class?: string
  }

  let { name, icon = null, author, color, class: className = '' }: Props = $props()

  /** The mark to draw: the caller's resolved icon, then the snapshot's own icon
   *  fields, then null so the default assistant mark stands in. An assistant
   *  always has a mark, never a bare glyph and never its name. */
  const iconUrl = $derived(icon ?? (author ? getAssistantIcon(author) : null))

  /** The speaker's accent, which the rule inset on its left edge wears. */
  const accent = $derived(color ?? (author ? assistantAccentColor(author) : null))
</script>

<!-- Square corners, rem sizing, app tokens only: the line is a caption to the
     reply under it, not a card of its own. -->
<div
  class="flex min-w-0 items-center gap-1.5 border-l-2 pl-1.5 text-[0.6875rem] {className}"
  style="border-color: {accent ?? 'var(--color-border)'}"
>
  <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
    {#if iconUrl}
      <img src={iconUrl} alt="" class="size-4 object-contain" draggable="false" />
    {:else}
      <AssistantDefaultIcon size={16} style="color: {accent ?? 'var(--color-muted)'}" />
    {/if}
  </span>
  <span class="truncate font-medium text-foreground">{name}</span>
</div>
