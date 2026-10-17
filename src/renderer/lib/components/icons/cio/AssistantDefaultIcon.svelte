<script lang="ts">
  import type { SVGAttributes } from 'svelte/elements'
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'

  /**
   * The assistant's assistant mark, as a component a list can render directly.
   *
   * Surfaces that hold a component rather than markup (the assistant empty
   * state, the New assistant control) need the assistant inside mark of the
   * assistant family on its own, so this binds `mark` instead of repeating the
   * prop at every call site.
   */
  interface Props extends Omit<SVGAttributes<SVGSVGElement>, 'size'> {
    size?: number | string
  }

  let { size = 24, class: className = '', ...rest }: Props = $props()
</script>

<AssistantIcon mark="assistant" {size} class={className} {...rest} />
