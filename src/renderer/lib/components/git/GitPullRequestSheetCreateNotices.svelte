<script lang="ts">
  import { Info, TriangleAlert } from '@lucide/svelte'

  interface Props {
    head: string
    base: string
    createError: string
    createErrorIsNoCommits: boolean
  }

  let { head, base, createError, createErrorIsNoCommits }: Props = $props()
</script>

{#if createError && createErrorIsNoCommits}
  <div class="rounded-lg border border-border bg-elevated px-3 py-2.5" role="status">
    <div class="flex items-start gap-2">
      <Info size={14} class="mt-0.5 shrink-0 text-dimmed" />
      <div class="min-w-0">
        <p class="text-[0.625rem] font-semibold text-foreground">Nothing to merge</p>
        <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-dimmed">
          <span class="font-medium text-foreground">{head}</span> is already up to date with
          <span class="font-medium text-foreground">{base}</span> there are no commits left to open a
          pull request for. It was likely merged elsewhere while this panel was open.
        </p>
      </div>
    </div>
  </div>
{:else if createError}
  <div class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2.5" role="alert">
    <div class="flex items-start gap-2">
      <TriangleAlert size={14} class="mt-0.5 shrink-0 text-danger" />
      <div class="min-w-0">
        <p class="text-[0.625rem] font-semibold text-danger">Pull request was not created</p>
        <p
          class="mt-0.5 whitespace-pre-wrap break-words text-[0.5625rem] leading-relaxed text-danger"
        >
          {createError}
        </p>
        <p class="mt-1 text-[0.5625rem] leading-relaxed text-dimmed">
          Fix the Git error, then choose Create pull request to try again.
        </p>
      </div>
    </div>
  </div>
{/if}
