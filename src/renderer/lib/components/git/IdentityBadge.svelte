<script lang="ts">
  /**
   * One label beside a login.
   *
   * Two facts about an account are worth a word in a conversation: that it is an
   * App rather than a person, and what its author is to this repository (the
   * account that opened the pull request, a member of the owning organization, a
   * collaborator, a contributor). GitHub draws both as the same outlined pill,
   * and this is that pill.
   *
   * One component rather than a copy per badge: a listing row, the reader's own
   * header and every conversation row draw it, and a pill that reads one way in
   * one surface and another way in the next is exactly the drift this prevents.
   */
  interface Props {
    /** The word itself, e.g. `Bot` or `Author`. */
    label: string
    /**
     * What the word means for this account. Required: an unexplained badge is
     * noise, and the words themselves are GitHub's vocabulary rather than a
     * reader's.
     */
    title: string
  }

  let { label, title }: Props = $props()
</script>

<span
  class="shrink-0 rounded-full border border-border px-1.5 text-[0.5625rem] font-medium text-muted"
  {title}
>
  {label}
</span>
