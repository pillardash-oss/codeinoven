<script lang="ts">
  import type { SVGAttributes } from 'svelte/elements'
  import AssistantIcon from './AssistantIcon.svelte'

  /**
   * The assistant's knowledge mark, as a component a list can render directly.
   *
   * Knowledge authoring is one concept across the assistant, so every surface that
   * offers it draws this: the rail's knowledge toggle, the assistant row's menu item,
   * the panel's own action. It is the same inside mark as the knowledge task rows
   * wear, so opening the knowledge from any of them lands on the same mark.
   */
  interface Props extends Omit<SVGAttributes<SVGSVGElement>, 'size'> {
    size?: number | string
  }

  let { size = 24, class: className = '', ...rest }: Props = $props()
</script>

<AssistantIcon mark="knowledge" {size} class={className} {...rest} />
