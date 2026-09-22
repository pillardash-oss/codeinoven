<script lang="ts">
  interface Props {
    class?: string
  }

  let { class: className = '' }: Props = $props()
</script>

<!--
  One badge for every surface that renders a marketplace entry, so an installed
  skill looks the same in the marketplace list, the bookmarks list, and the
  skill's own detail header.
-->
<span
  class="rounded-md border border-success/30 bg-success/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-success {className}"
>
  Installed
</span>
