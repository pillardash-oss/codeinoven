<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type FileDiffView from './FileDiffView.svelte'
  import { loadFileDiffView } from './file-diff-chunk'

  /**
   * `FileDiffView` behind a dynamic import, so the diff renderer stays out of the
   * initial closure and is fetched the first time a panel actually shows a diff.
   *
   * Props are forwarded one for one, so it is a drop-in replacement for the
   * component it defers. Nothing is drawn while the chunk is in flight: it is a
   * local fetch that resolves in the same frame as the panel that requested it,
   * and every call site only renders this once its own diff data has arrived.
   */
  let props: ComponentProps<typeof FileDiffView> = $props()
</script>

{#await loadFileDiffView() then { default: FileDiffViewComponent }}
  <FileDiffViewComponent {...props} />
{/await}
