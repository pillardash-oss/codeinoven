<script lang="ts">
  import { FolderOpen } from '@lucide/svelte'
  import type { AgentArtifact } from '$shared/types'
  import type { FileBlobUrlManager } from '$lib/media-urls.svelte'

  interface Props {
    artifact: AgentArtifact
    imageUrls: FileBlobUrlManager
    onPreview: (artifact: AgentArtifact) => void
    onReveal: (artifact: AgentArtifact) => void
  }

  let { artifact, imageUrls, onPreview, onReveal }: Props = $props()
</script>

<article class="border-b border-border px-4 py-3 transition-colors hover:bg-elevated">
  <div class="flex items-start gap-3">
    <button
      type="button"
      class="group relative h-16 w-24 shrink-0 overflow-hidden rounded-lg border border-border bg-raised transition-shadow hover:shadow-md"
      title={`Preview ${artifact.filename}`}
      aria-label={`Preview ${artifact.filename}`}
      onclick={() => onPreview(artifact)}
    >
      <img
        src={imageUrls.getUrl(artifact.url)}
        alt={artifact.filename}
        class="h-full w-full object-cover"
        onerror={(event: Event) =>
          void imageUrls.bindImage(
            artifact.url,
            artifact.mime,
            event.currentTarget as HTMLImageElement
          )}
      />
      <span
        class="absolute inset-0 flex items-center justify-center bg-black/0 text-[0.625rem] font-medium text-white opacity-0 transition-all group-hover:bg-black/30 group-hover:opacity-100"
      >
        Preview
      </span>
    </button>
    <div class="min-w-0 flex-1">
      <p class="text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-dimmed">
        Generated image
      </p>
      <p class="mt-0.5 truncate text-xs font-medium text-foreground" title={artifact.path}>
        {artifact.filename}
      </p>
      <p class="mt-1 break-all text-[0.625rem] leading-relaxed text-dimmed" title={artifact.path}>
        {artifact.relativePath ?? artifact.path}
      </p>
    </div>
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed hover:bg-overlay hover:text-foreground"
      title={`Reveal ${artifact.filename} in its folder`}
      aria-label={`Reveal ${artifact.filename} in its folder`}
      onclick={() => onReveal(artifact)}
    >
      <FolderOpen size={14} />
    </button>
  </div>
</article>
