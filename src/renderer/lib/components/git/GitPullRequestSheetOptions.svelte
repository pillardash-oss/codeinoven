<script lang="ts">
  import Switch from '../ui/Switch.svelte'

  interface Props {
    head: string
    hasPendingCommitChanges: boolean
    headIsCurrent: boolean
    pushLocalCommits: boolean
    commitPendingFiles: boolean
    draft: boolean
  }

  let {
    head,
    hasPendingCommitChanges,
    headIsCurrent,
    pushLocalCommits = $bindable(),
    commitPendingFiles = $bindable(),
    draft = $bindable()
  }: Props = $props()
</script>

<div class="space-y-3 rounded-lg border border-border bg-surface p-2.5">
  <div class="flex items-center justify-between gap-2">
    <div class="min-w-0">
      <span class="text-[0.625rem] text-muted">Push local commits</span>
      <p class="text-[0.5625rem] leading-relaxed text-dimmed">
        Push unpublished commits on
        <span class="font-mono text-foreground">{head}</span> before creating the pull request.
      </p>
    </div>
    <Switch bind:checked={pushLocalCommits} aria-label="Push local commits" />
  </div>
  <div class="flex items-center justify-between gap-2">
    <div class="min-w-0">
      <span class="text-[0.625rem] text-muted">Commit staged and untracked files</span>
      <p class="text-[0.5625rem] leading-relaxed text-dimmed">
        {hasPendingCommitChanges
          ? headIsCurrent
            ? 'Create an uncategorized commit dated at submission time.'
            : `Check out ${head} before committing files to it.`
          : 'No staged or untracked files right now   nothing would be committed.'}
      </p>
    </div>
    <Switch bind:checked={commitPendingFiles} aria-label="Commit staged and untracked files" />
  </div>
  <div class="flex items-center justify-between gap-2">
    <div class="min-w-0">
      <span class="text-[0.625rem] text-muted">Create as draft</span>
      <p class="text-[0.5625rem] leading-relaxed text-dimmed">
        Drafts can't be merged until they're marked ready.
      </p>
    </div>
    <Switch bind:checked={draft} aria-label="Create as draft" />
  </div>
</div>
