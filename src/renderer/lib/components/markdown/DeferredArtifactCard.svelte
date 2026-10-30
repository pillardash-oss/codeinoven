<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type ArtifactCard from './ArtifactCard.svelte'
  import CodeBlock from './CodeBlock.svelte'
  import { loadArtifactCard } from './markdown-chunk'

  /**
   * An artifact fence behind its own chunk.
   *
   * The card carries the element inspector, the annotation seams and the
   * full-screen preview: a large surface for a fence most messages never
   * contain. Until it arrives the fence is drawn as the code it is, which is
   * what a reader sees anyway when the artifact is not renderable.
   */
  let props: ComponentProps<typeof ArtifactCard> = $props()
</script>

{#await loadArtifactCard()}
  <CodeBlock code={props.code} />
{:then { default: ArtifactCard }}
  <ArtifactCard {...props} />
{/await}
