<script lang="ts">
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import CioAudioLines from '@pdslng/cio-icon/CioAudioLines.svelte'
  import CioImage from '@pdslng/cio-icon/CioImage.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import type { VideoEditorController } from '$lib/stores/video-editor.svelte'
  import { videoTimecode } from '$shared/video/timeline'
  let { editor, expanded = false }: { editor: VideoEditorController; expanded?: boolean } = $props()
  let query = $state('')
  const assets = $derived(
    editor.edit?.assets.filter((asset) => asset.name.toLowerCase().includes(query.toLowerCase())) ??
      []
  )
</script>

<div
  class={['flex min-h-0 flex-col gap-1.5 p-2', expanded && 'h-full']}
  data-drop-region="video-editor"
  role="group"
  aria-label="Composition assets"
  ondragover={(event) => event.preventDefault()}
  ondrop={(event) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer?.files.length)
      void editor.dropFiles(Array.from(event.dataTransfer.files))
  }}
>
  <div class="flex items-center gap-2">
    <input
      class="h-7 min-w-0 flex-1 border border-border bg-elevated px-2 text-xs outline-none focus:border-primary"
      aria-label="Find an asset"
      placeholder="Find an asset"
      bind:value={query}
    />
    <button
      type="button"
      class="flex h-7 shrink-0 items-center gap-1.5 border border-border px-2 text-xs hover:bg-elevated disabled:opacity-40"
      title="Import video, music, sound effects or stickers into assets"
      aria-label="Import media into assets"
      disabled={editor.importing || editor.saving}
      onclick={() => void editor.importFiles()}
      ><CioDownload size={12} />{editor.importing ? 'Importing…' : 'Import'}</button
    >
  </div>
  <div class={['min-h-0 space-y-px overflow-y-auto', expanded ? 'flex-1' : 'max-h-36']}>
    {#each assets as asset (asset.id)}
      {@const Icon =
        asset.kind === 'video' ? CioClapper : asset.kind === 'audio' ? CioAudioLines : CioImage}
      <div class="flex items-center gap-1.5 border-b border-border/50 py-1">
        <button
          type="button"
          class="flex min-w-0 flex-1 cursor-grab items-center gap-2 text-left active:cursor-grabbing"
          draggable
          title={`Drag ${asset.name} onto a track · ${asset.source}`}
          aria-label={`Drag ${asset.name} onto the timeline`}
          ondragstart={(event) => {
            event.dataTransfer?.setData('application/x-cio-video-asset', asset.id)
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
          }}
          ondblclick={() => editor.addAsset(asset.id)}
        >
          <Icon size={14} class="shrink-0 text-muted" /><span
            class="min-w-0 flex-1 truncate text-xs">{asset.name}</span
          ><span class="shrink-0 text-[0.625rem] text-dimmed tabular-nums"
            >{asset.kind === 'image' ? 'Sticker' : videoTimecode(asset.duration)}</span
          >
        </button>
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center text-muted hover:bg-elevated hover:text-foreground"
          title={`Add ${asset.name} at the playhead`}
          aria-label={`Add ${asset.name} at the playhead`}
          onclick={() => editor.addAsset(asset.id)}><CioPlus size={12} /></button
        >
      </div>
    {:else}
      <p class="py-3 text-xs text-muted">
        Drop video, audio or sticker files here, or import them.
      </p>
    {/each}
  </div>
  <span class="text-[0.5625rem] text-dimmed"
    >Imported resources stay in this composition’s assets/ folder.</span
  >
</div>
