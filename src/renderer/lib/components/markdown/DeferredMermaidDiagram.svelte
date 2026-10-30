<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type MermaidDiagram from './MermaidDiagram.svelte'
  import CodeBlock from './CodeBlock.svelte'
  import { loadMermaidDiagram } from './markdown-chunk'

  /**
   * A Mermaid diagram behind its own chunk.
   *
   * Rendering a diagram means a worker, a pan-and-zoom surface and a toolbar,
   * none of which the message around it needs. A diagram is rare in a
   * conversation and its source is already readable text, so the fence draws as
   * the code it is written as until the renderer arrives, then becomes the
   * diagram. Nothing is lost if the chunk is slow: the reader sees the graph's
   * source instead of a blank block.
   */
  let props: ComponentProps<typeof MermaidDiagram> = $props()
</script>

{#await loadMermaidDiagram()}
  <CodeBlock code={props.code} lang="mermaid" />
{:then { default: MermaidDiagram }}
  <MermaidDiagram {...props} />
{/await}
