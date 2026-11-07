<script lang="ts">
  import type { ThreadStatus } from '#lib/api/types'
  import { showsSpine, statusSkin, toneColor } from '#lib/api/status'

  /**
   * The state mark a row carries: one glyph per state at 14px, in the tone the
   * palette gives that state, with the dashed spine that joins a continuing run
   * of work under it. Work that has ended draws the glyph alone.
   */
  interface Props {
    status: ThreadStatus
    /** Draw the spine even when the state has ended, or never for a flat row. */
    rail?: boolean
    size?: number
  }

  let { status, rail, size = 14 }: Props = $props()

  let skin = $derived(statusSkin(status))
  let spine = $derived(rail ?? showsSpine(status))
</script>

<span class="tmark" data-rail={spine ? 'spine' : 'none'} style:color={toneColor(skin.tone)}>
  <skin.icon {size} />
  <i></i>
</span>
