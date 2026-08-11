<script lang="ts">
  import BrandIcon from './BrandIcon.svelte'

  interface Props {
    size?: number | string
    color?: string
    class?: string
    title?: string
  }

  let { size, color, class: className, title }: Props = $props()
</script>

<BrandIcon {size} {color} {title} class={className}>
  <path d="M12 0l12 20.785H0L12 0z" />
</BrandIcon>
