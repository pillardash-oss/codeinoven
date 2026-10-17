<script lang="ts">
  import CioBraces from '$lib/components/icons/cio/CioBraces.svelte'
  import CioFile from '$lib/components/icons/cio/CioFile.svelte'
  import CioFileCode from '$lib/components/icons/cio/CioFileCode.svelte'
  import CioFileText from '$lib/components/icons/cio/CioFileText.svelte'
  import CioTag from '$lib/components/icons/cio/CioTag.svelte'
  import { getFileTypeIconDataUri } from './file-type-icons'

  interface Props {
    path: string
    size?: number
    class?: string
  }

  let { path, size = 13, class: className = '' }: Props = $props()

  let dataUri = $state<string | null>(null)

  $effect(() => {
    const requestedPath = path
    let current = true
    dataUri = null
    void getFileTypeIconDataUri(requestedPath).then((resolved) => {
      if (current && path === requestedPath) dataUri = resolved
    })
    return () => {
      current = false
    }
  })

  let extension = $derived(path.split('.').at(-1)?.toLocaleLowerCase() ?? '')
  let kind = $derived.by(() => {
    if (['json', 'jsonc'].includes(extension)) return 'json'
    if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'svelte', 'vue'].includes(extension)) return 'code'
    if (['html', 'htm', 'css', 'scss', 'sass', 'less', 'php'].includes(extension)) return 'markup'
    if (
      ['go', 'rs', 'py', 'rb', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs'].includes(extension)
    ) {
      return 'systems'
    }
    if (['yml', 'yaml', 'toml', 'ini', 'env', 'properties'].includes(extension)) return 'config'
    if (['md', 'mdx', 'txt', 'log'].includes(extension)) return 'text'
    return 'file'
  })
</script>

{#if dataUri}
  <img src={dataUri} alt="" width={size} height={size} class="shrink-0 {className}" />
{:else if kind === 'json'}
  <CioFileCode {size} class="shrink-0 text-accent {className}" />
{:else if kind === 'code'}
  <CioFileCode {size} class="shrink-0 text-info {className}" />
{:else if kind === 'markup'}
  <CioBraces {size} class="shrink-0 text-danger {className}" />
{:else if kind === 'systems'}
  <CioTag {size} class="shrink-0 text-success {className}" />
{:else if kind === 'config'}
  <CioBraces {size} class="shrink-0 text-primary {className}" />
{:else if kind === 'text'}
  <CioFileText {size} class="shrink-0 text-muted {className}" />
{:else}
  <CioFile {size} class="shrink-0 text-dimmed {className}" />
{/if}
