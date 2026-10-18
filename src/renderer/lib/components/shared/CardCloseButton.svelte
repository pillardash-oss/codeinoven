<script lang="ts">
  import CioClose from '@pillardash-oss/cio-icon/CioClose.svelte'
  /**
   * The close control a card head carries at its top right, before the fold.
   *
   * It ends the whole record, not the entry on screen, so the title says so:
   * a bare X on a card that walks through several questions reads as "skip this
   * one", and the action behind it throws every question away.
   */
  interface Props {
    /** Tooltip and accessible name. Required: an X never ships without one. */
    title: string
    disabled?: boolean
    onclick: () => void
  }

  let { title, disabled = false, onclick }: Props = $props()
</script>

<button
  type="button"
  class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-dimmed transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
  {disabled}
  {onclick}
  {title}
  aria-label={title}
>
  <CioClose size={13} />
</button>
