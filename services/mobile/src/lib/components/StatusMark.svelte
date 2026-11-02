<script lang="ts">
  import type { ThreadStatus } from '#lib/api/types'
  import { statusSkin, toneColor } from '#lib/api/status'

  /**
   * The state mark a row carries. One glyph per state, drawn at 14px, in the
   * tone the palette gives that state, with a text label beside it wherever a
   * row has room for one.
   */
  interface Props {
    status: ThreadStatus
    /** Draw the small trailing dot that marks a live run. */
    live?: boolean
    size?: number
  }

  let { status, live = false, size = 14 }: Props = $props()

  let skin = $derived(statusSkin(status))
</script>

<span class="tmark" data-rail={live ? '' : 'none'} style:color={toneColor(skin.tone)}>
  <skin.icon {size} />
  <i></i>
</span>
