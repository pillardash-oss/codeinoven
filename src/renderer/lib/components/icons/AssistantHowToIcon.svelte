<script lang="ts">
  import type { SVGAttributes } from 'svelte/elements'
  import AssistantIcon from './AssistantIcon.svelte'

  /**
   * The assistant's how-to mark, as a component a list can render directly.
   *
   * How-to authoring is one concept across the assistant, so every surface that
   * offers it draws this: the rail's How to toggle, the routine row's menu item,
   * the panel's own action. It is the same inside mark as the how-to task rows
   * wear, so opening the how-to from any of them lands on the same mark.
   */
  interface Props extends Omit<SVGAttributes<SVGSVGElement>, 'size'> {
    size?: number | string
  }

  let { size = 24, class: className = '', ...rest }: Props = $props()
</script>

<AssistantIcon mark="how-to" {size} class={className} {...rest} />
