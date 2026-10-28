<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type MarkdownView from './MarkdownView.svelte'

  /**
   * `MarkdownView` behind a dynamic import.
   *
   * The markdown pipeline is the single heaviest eager dependency the renderer
   * has: every surface that can show text pulls it in, so it lands in the
   * initial closure and the first paint waits for a parser that has nothing to
   * parse yet. Importing this wrapper instead keeps the parser in its own chunk,
   * loaded the first time a surface actually renders markdown. Props are
   * forwarded one for one, so it is a drop-in replacement.
   */
  let props: ComponentProps<typeof MarkdownView> = $props()
</script>

{#await import('./MarkdownView.svelte') then { default: MarkdownView }}
  <MarkdownView {...props} />
{/await}
