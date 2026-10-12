<script lang="ts">
  import type { BrowserStatusOverlay } from '$shared/browser-overlay'

  interface Props {
    /** The link preview on display, exactly as the main process projected it. */
    status: BrowserStatusOverlay
  }

  let { status }: Props = $props()
</script>

<!--
  Where a hovered link leads, pinned to the page's bottom-left the way a native
  browser draws its status bubble. The overlay window starts at the application
  header's bottom edge, so `left`/`bottom` are the page's own corner measured in
  this document's coordinates.

  Paint-only on purpose: `pointer-events-none` keeps it out of the overlay's
  click-through decision, so the page under it stays live, and `aria-hidden`
  keeps a redundant announcement out of a screen reader, which already reads the
  link's own address.
-->
<div
  class="pointer-events-none absolute z-10 truncate rounded-md border bg-surface px-2 py-1 text-xs text-foreground shadow-md"
  style:left="{status.left}px"
  style:bottom="{status.bottom}px"
  style:max-width="calc(100% - {status.left}px - 0.5rem)"
  aria-hidden="true"
  data-overlay-status
>
  {status.url}
</div>
