<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type MarkdownView from './MarkdownView.svelte'
  import { loadMarkdownView } from './markdown-chunk'

  /**
   * `MarkdownView` behind a dynamic import.
   *
   * The markdown pipeline is the single heaviest eager dependency the renderer
   * has: every surface that can show text pulls it in, so it lands in the
   * initial closure and the first paint waits for a parser that has nothing to
   * parse yet. Importing this wrapper instead keeps the parser in its own chunk,
   * loaded the first time a surface actually renders markdown. Props are
   * forwarded one for one, so it is a drop-in replacement.
   *
   * The chunk crossing must never cost the reader the text itself. A transcript
   * paints its rows before their bodies resolve, so a body that rendered nothing
   * until the chunk arrived showed the reader a conversation of cards, chips and
   * footers with every prompt and answer missing: the "my messages are gone"
   * state, on a cold renderer or one under memory pressure. The pending branch
   * therefore draws the source as the plain text it already is. It is replaced by
   * the rendered markdown a task later once the warm from
   * `whenConversationPainted` has the chunk, and it stays readable rather than
   * blank if that fetch ever fails.
   */
  let props: ComponentProps<typeof MarkdownView> = $props()
</script>

{#await loadMarkdownView()}
  <div class={['markdown-body min-w-0 max-w-full', props.class]}>
    <!-- Plain, unparsed source. The same text the renderer will format, so the
         reader can already read, select and copy it. -->
    <p class="whitespace-pre-wrap break-words">{props.text}</p>
  </div>
{:then { default: MarkdownView }}
  <MarkdownView {...props} />
{/await}
