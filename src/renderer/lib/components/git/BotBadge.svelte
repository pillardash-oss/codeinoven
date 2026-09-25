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
   * The pill itself belongs to `IdentityBadge`, which draws the same shape for
   * the role a commenter has in the repository. This file is the `Bot` word and
   * what it means, so the three surfaces that draw it cannot drift apart.
   */
  import IdentityBadge from './IdentityBadge.svelte'
</script>

<IdentityBadge label="Bot" title="This account is an App, not a person" />
