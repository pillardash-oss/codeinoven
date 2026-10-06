<script lang="ts">
  import { Loader2 } from '@lucide/svelte'
  import { browserTabTitleForUrl } from '$lib/stores/global-browser-types'

  /**
   * What a Peek Window shows until its page has painted.
   *
   * A peek's page is a native view, and a native view cannot be painted over: a
   * DOM loading state on top of it would simply be behind it. So the surface holds
   * the page off screen until it is ready and shows this in the rectangle the page
   * will take, which is also why this is reused as the content of the shell that
   * flies when a peek is closed before its page ever arrived.
   */

  interface Props {
    /** The address being loaded, which names the site in the loading line. */
    url: string
  }

  const { url }: Props = $props()

  const host = $derived(browserTabTitleForUrl(url))
</script>

<div
  class="flex h-full min-h-0 w-full items-center justify-center px-6 py-10"
  data-region="browser-peek-loading"
>
  <div class="flex flex-col items-center gap-2.5">
    <Loader2 size={18} class="animate-spin text-muted motion-reduce:animate-none" />
    <p class="text-sm text-muted">Loading {host}…</p>
  </div>
</div>
