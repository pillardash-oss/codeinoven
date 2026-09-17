<script lang="ts">
  interface Props {
    /** Copy to show inside the panel body. */
    message: string
    /** `danger` renders failure copy, `dimmed` renders loading copy. */
    tone?: 'dimmed' | 'danger'
    /** True for failure copy, so assistive tech announces it. */
    alert?: boolean
  }

  let { message, tone = 'dimmed', alert = false }: Props = $props()
</script>

<div class="flex h-full items-center justify-center px-8 text-center">
  <p
    class="max-w-64 text-xs leading-relaxed {tone === 'danger' ? 'text-danger' : 'text-dimmed'}"
    role={alert ? 'alert' : undefined}
  >
    {message}
  </p>
</div>
