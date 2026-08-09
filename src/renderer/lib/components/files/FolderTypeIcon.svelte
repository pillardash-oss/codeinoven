<script lang="ts">
  import { Folder, FolderOpen } from '@lucide/svelte'
  import { getFolderTypeIconDataUri } from './file-type-icons'

  interface Props {
    name: string
    open?: boolean
    size?: number
    class?: string
  }

  let { name, open = false, size = 13, class: className = '' }: Props = $props()

  let dataUri = $state<string | null>(null)

  $effect(() => {
    const requestedName = name
    const requestedOpen = open
    let current = true
    dataUri = null
    void getFolderTypeIconDataUri(requestedName, requestedOpen).then((resolved) => {
      if (current && name === requestedName && open === requestedOpen) dataUri = resolved
    })
    return () => {
      current = false
    }
  })
</script>

{#if dataUri}
  <img src={dataUri} alt="" width={size} height={size} class="shrink-0 {className}" />
{:else if open}
  <FolderOpen {size} class="shrink-0 text-muted {className}" />
{:else}
  <Folder {size} class="shrink-0 text-muted {className}" />
{/if}
