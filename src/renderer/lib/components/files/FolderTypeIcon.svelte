<script lang="ts">
  import { Folder, FolderOpen } from '@lucide/svelte'
  import { getFolderTypeIconDataUri } from './file-type-icons'
  import { CIO_ICON_DATA_URI, isCioFolderName } from './cio-folder-icons'

  interface Props {
    name: string
    open?: boolean
    size?: number
    class?: string
  }

  let { name, open = false, size = 13, class: className = '' }: Props = $props()

  let dataUri = $state<string | null>(null)

  /** The `.cio` scratch folder wears the CodeInOven app icon itself. Collapsed
   *  and expanded `.cio` folders look the same: it is not a folder glyph. */
  let cioIcon = $derived(isCioFolderName(name) ? CIO_ICON_DATA_URI : null)

  /** Either the synchronous `.cio` app icon or the resolved icon-library URI. */
  let iconUri = $derived(cioIcon ?? dataUri)

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

{#if iconUri}
  <img src={iconUri} alt="" width={size} height={size} class="shrink-0 {className}" />
{:else if open}
  <FolderOpen {size} class="shrink-0 text-muted {className}" />
{:else}
  <Folder {size} class="shrink-0 text-muted {className}" />
{/if}
