<script lang="ts">
  /**
   * GitHub's `Bot` badge for an app account.
   *
   * App accounts carry a `[bot]` suffix on their login, and every surface that
   * names one trims that suffix (`githubDisplayLogin`) because it says the same
   * thing twice in a word. This badge is what carries the fact instead. Without
   * it, a bot's name is indistinguishable from a colleague's, which matters most
   * in a comment thread, where a reader decides how much to trust a paragraph.
   *
   * One component rather than a copy per row: the conversation header, a listing
   * row and the reader's own header all draw it, and a badge that reads `Bot` in
   * one surface and something else in another is exactly the drift this prevents.
   */
</script>

<span
  class="shrink-0 rounded-full border border-border px-1.5 text-[0.5625rem] font-medium text-muted"
  title="This account is an App, not a person"
>
  Bot
</span>
