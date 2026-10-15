<script lang="ts">
  import type { SVGAttributes } from 'svelte/elements'
  import AssistantIcon from './AssistantIcon.svelte'

  /**
   * The assistant's task mark, as a component a list can render directly.
   *
   * Every place that starts or names a task draws this, so creating a task reads
   * as the assistant's own action rather than a generic clock, and the header's
   * New task matches the task rows it creates.
   */
  interface Props extends Omit<SVGAttributes<SVGSVGElement>, 'size'> {
    size?: number | string
  }

  let { size = 24, class: className = '', ...rest }: Props = $props()
</script>

<AssistantIcon mark="task" {size} class={className} {...rest} />
