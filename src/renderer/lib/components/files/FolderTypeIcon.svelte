<script lang="ts">
  import { Folder, FolderOpen } from '@lucide/svelte'
  import { getFolderTypeIconDataUri } from './file-type-icons'
  import { getCioMarkMarkup, isCioFolderName } from './cio-folder-icons'

  interface Props {
    name: string
    open?: boolean
    size?: number
    class?: string
  }

  let { name, open = false, size = 13, class: className = '' }: Props = $props()

  /** The `.cio` scratch folder wears the CodeInOven mark itself, inlined so the
   *  mark's ink follows the row's text colour instead of a baked theme colour.
   *  Collapsed and expanded `.cio` folders look the same. */
  let cioMarkup = $derived(isCioFolderName(name) ? getCioMarkMarkup(size) : null)

  let dataUri = $state<string | null>(null)

  $effect(() => {
    const requestedName = name
    const requestedOpen = open
    let current = true
    dataUri = null
    if (isCioFolderName(requestedName)) return
    void getFolderTypeIconDataUri(requestedName, requestedOpen).then((resolved) => {
      if (current && name === requestedName && open === requestedOpen) dataUri = resolved
    })
    return () => {
      current = false
    }
  })
</script>

{#if cioMarkup}
  <span class="inline-flex shrink-0 items-center justify-center {className}">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- the mark is bundled from the repo's own master artwork -->
    {@html cioMarkup}
  </span>
{:else if dataUri}
  <img src={dataUri} alt="" width={size} height={size} class="shrink-0 {className}" />
{:else if open}
  <FolderOpen {size} class="shrink-0 text-muted {className}" />
{:else}
  <Folder {size} class="shrink-0 text-muted {className}" />
{/if}
