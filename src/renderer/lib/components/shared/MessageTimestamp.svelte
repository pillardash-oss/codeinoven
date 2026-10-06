<script lang="ts">
  import { formatDateTime, formatMessageTimestamp } from '$shared/date-time-format'

  interface Props {
    /** Epoch milliseconds of the moment the message was sent or completed. */
    at: number
    /** Row separator the surrounding metadata row already uses, e.g. `· `. */
    prefix?: string
    /** Sizing and colour utilities owned by the call site. */
    class?: string
  }

  let { at, prefix = '', class: className = '' }: Props = $props()

  /** True when the message carries a timestamp this row can render at all. */
  const hasStamp = $derived(Number.isFinite(at))
  /** `8:05 AM` today, `Sep 22, 8:05 AM` on any other day, so a multi-day thread
   *  never hides when a message was sent or received. */
  const stamp = $derived(hasStamp ? formatMessageTimestamp(at) : '')
  /** The same moment as an absolute date and time, always there on hover. */
  const absolute = $derived(hasStamp ? formatDateTime(at) : '')
  const machine = $derived(hasStamp ? new Date(at).toISOString() : '')
</script>

<time datetime={machine} title={absolute} class={className}>{prefix}{stamp}</time>
