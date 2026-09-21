<script lang="ts">
  import { Check, Flag, Loader2, Tag, User } from '@lucide/svelte'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import { gitState } from '$lib/stores/git.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import type {
    PullRequestLabel,
    PullRequestMilestone,
    PullRequestSummary,
    RepositoryMentionUser
  } from '$shared/types'
  import { mentionCandidates, participantMentionUsers } from './pr-mentions'
  import { prLabelStyle, type PrMetadataMode } from './pr-view'

  /**
   * The label, assignee, and milestone pickers for one pull request.
   *
   * One dialog rather than three, because the three are the same question: pick
   * from a repository catalog, then save. They share the search field, the loading
   * and error surfaces, the save action, and the footer, so the only thing that
   * differs is which list is drawn and which write runs.
   *
   * The dialog is mounted only while a subject is set, so it never has to keep a
   * stale pull request in view. Nothing here writes until Save, so a picker opened by
   * mistake costs nothing and a half-made choice is never half-applied.
   */
  interface Props {
    pr: PullRequestSummary
    mode: PrMetadataMode
    projectId: string
    owner: string
    repo: string
    onClose: () => void
  }

  let { pr, mode, projectId, owner, repo, onClose }: Props = $props()

  /**
   * Drafts, seeded from what the pull request carries now.
   *
   * Held as an edit over the pull request rather than as a copy of it, so the
   * picker opens on the current state, follows the row if the cached pull request
   * is corrected while it is open, and only stops following once the user has
   * actually chosen something.
   */
  let editedLabels = $state<string[] | null>(null)
  let editedAssignees = $state<string[] | null>(null)
  let milestoneEdited = $state(false)
  let milestoneNumber = $state<number | null>(null)

  const draftLabels = $derived(editedLabels ?? (pr.labels ?? []).map((label) => label.name))
  const draftAssignees = $derived(
    editedAssignees ?? (pr.assignees ?? []).map((entry) => entry.login)
  )
  const draftMilestone = $derived(
    milestoneEdited ? milestoneNumber : (pr.milestone?.number ?? null)
  )

  /** Select one milestone, or clear it, which is the one edit with no partial state. */
  function chooseMilestone(number: number | null): void {
    milestoneEdited = true
    milestoneNumber = number
  }

  let query = $state('')
  let error = $state<string | null>(null)

  let labels = $state<PullRequestLabel[]>([])
  let milestones = $state<PullRequestMilestone[]>([])
  let accounts = $state<RepositoryMentionUser[]>([])

  /**
   * How many account rows the picker draws. Far above the composer popover's
   * limit: a dialog has the height to scroll a directory, and an assignment the
   * user cannot see is an assignment they cannot make.
   */
  const ASSIGNEE_ROW_LIMIT = 200

  const busy = $derived(gitState.isBusy('pr-metadata'))
  const loading = $derived(gitState.isBusy('pr-catalog'))

  const title = $derived(
    mode === 'labels'
      ? `Labels for #${pr.number}`
      : mode === 'assignees'
        ? `Assign #${pr.number}`
        : `Milestone for #${pr.number}`
  )

  /**
   * The catalog read, once per mount.
   *
   * Each read degrades to an empty list on failure (see the store), so a picker can
   * always still be used to review and remove what the pull request already carries.
   */
  async function load(): Promise<void> {
    if (mode === 'labels') {
      labels = await gitState.repositoryLabels(projectId, owner, repo)
      return
    }
    if (mode === 'milestone') {
      milestones = await gitState.repositoryMilestones(projectId, owner, repo)
      return
    }
    accounts = await gitState.mentionUsersFor(projectId, owner, repo)
  }

  void load()

  const normalizedQuery = $derived(query.trim().toLowerCase())

  /**
   * Label rows: what the pull request carries first, then the rest of the catalog.
   *
   * Carried-first is what makes an unlisted label removable: a repository can
   * rename or delete a label that an old pull request still wears, and a picker that
   * only drew the catalog would hide the one chip the user came to take off.
   */
  const labelRows = $derived.by((): PullRequestLabel[] => {
    const carried = pr.labels ?? []
    const seen = new Set(carried.map((label) => label.name.toLowerCase()))
    const rest = labels.filter((label) => !seen.has(label.name.toLowerCase()))
    return [...carried, ...rest].filter(
      (label) => !normalizedQuery || label.name.toLowerCase().includes(normalizedQuery)
    )
  })

  /**
   * Account rows: the people already on the pull request first, then the repository
   * directory, which is exactly the ordering the composer's mention popover uses.
   */
  const accountRows = $derived.by((): RepositoryMentionUser[] => {
    const participants = participantMentionUsers([
      pr.authorLogin,
      ...(pr.assignees ?? []).map((entry) => entry.login)
    ])
    return mentionCandidates(participants, accounts, query, ASSIGNEE_ROW_LIMIT)
  })

  const milestoneRows = $derived(
    milestones.filter(
      (milestone) =>
        !normalizedQuery ||
        milestone.title.toLowerCase().includes(normalizedQuery) ||
        (milestone.description ?? '').toLowerCase().includes(normalizedQuery)
    )
  )

  function toggleLabel(name: string): void {
    editedLabels = draftLabels.includes(name)
      ? draftLabels.filter((entry) => entry !== name)
      : [...draftLabels, name]
  }

  function toggleAssignee(login: string): void {
    editedAssignees = draftAssignees.includes(login)
      ? draftAssignees.filter((entry) => entry !== login)
      : [...draftAssignees, login]
  }

  /** Whether the draft differs from what the provider currently reports. */
  const changed = $derived.by((): boolean => {
    if (mode === 'labels') {
      const current = (pr.labels ?? []).map((label) => label.name).sort()
      return [...draftLabels].sort().join('\u0000') !== current.join('\u0000')
    }
    if (mode === 'assignees') {
      const current = (pr.assignees ?? []).map((entry) => entry.login.toLowerCase()).sort()
      return (
        [...draftAssignees]
          .map((login) => login.toLowerCase())
          .sort()
          .join('\u0000') !== current.join('\u0000')
      )
    }
    return draftMilestone !== (pr.milestone?.number ?? null)
  })

  async function save(): Promise<void> {
    if (!changed || busy) return
    error = null
    const outcome =
      mode === 'labels'
        ? await gitState.setPullRequestLabels(projectId, owner, repo, pr.number, draftLabels)
        : mode === 'assignees'
          ? await gitState.setPullRequestAssignees(
              projectId,
              owner,
              repo,
              pr.number,
              draftAssignees
            )
          : await gitState.setPullRequestMilestone(
              projectId,
              owner,
              repo,
              pr.number,
              draftMilestone
            )
    if (outcome.status === 'failed') {
      error = outcome.message
      return
    }
    // The row behind this dialog was already corrected from the provider's own
    // answer, so there is nothing left to report: closing shows the result.
    onClose()
  }

  const searchPlaceholder = $derived(
    mode === 'labels'
      ? 'Filter labels'
      : mode === 'assignees'
        ? 'Filter accounts'
        : 'Filter milestones'
  )
</script>

{#snippet optionRow(
  label: string,
  hint: string,
  checked: boolean,
  onToggle: () => void,
  swatch: string | null
)}
  <button
    type="button"
    class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors {checked
      ? 'bg-primary/10'
      : 'hover:bg-elevated'}"
    aria-pressed={checked}
    title={checked ? `Remove ${label}` : `Apply ${label}`}
    onclick={onToggle}
  >
    {#if swatch}
      <span class="h-3 w-3 shrink-0 rounded-full" style={prLabelStyle(swatch)} aria-hidden="true"
      ></span>
    {:else}
      <User size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
    {/if}
    <span class="min-w-0 flex-1">
      <span class="block truncate font-mono text-[0.6875rem] text-foreground">{label}</span>
      {#if hint}
        <span class="block truncate text-[0.625rem] text-dimmed">{hint}</span>
      {/if}
    </span>
    {#if checked}
      <Check size={13} class="shrink-0 text-primary" />
    {/if}
  </button>
{/snippet}

<Modal open {title} {onClose}>
  <div class="space-y-3">
    <input
      class="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
      placeholder={searchPlaceholder}
      aria-label={searchPlaceholder}
      bind:value={query}
    />

    <div class="max-h-72 min-h-24 overflow-y-auto rounded-lg border border-border p-1">
      {#if loading && labelRows.length === 0 && accountRows.length === 0 && milestoneRows.length === 0}
        <p class="flex items-center justify-center gap-2 py-6 text-[0.6875rem] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading…
        </p>
      {:else if mode === 'labels'}
        {#if labelRows.length === 0}
          <p class="px-2 py-6 text-center text-[0.6875rem] text-dimmed">
            {normalizedQuery
              ? `No label matches "${query.trim()}"`
              : 'This repository has no labels yet.'}
          </p>
        {:else}
          {#each labelRows as label (label.name)}
            {@render optionRow(
              label.name,
              label.description ?? '',
              draftLabels.includes(label.name),
              () => toggleLabel(label.name),
              label.color
            )}
          {/each}
        {/if}
      {:else if mode === 'assignees'}
        {#if accountRows.length === 0}
          <p class="px-2 py-6 text-center text-[0.6875rem] text-dimmed">
            {normalizedQuery
              ? `No account matches "${query.trim()}"`
              : 'No assignable accounts in this repository.'}
          </p>
        {:else}
          {#each accountRows as account (account.login.toLowerCase())}
            {@render optionRow(
              `@${githubDisplayLogin(account.login)}`,
              account.bot ? 'App account' : (account.name ?? 'Repository account'),
              draftAssignees.includes(account.login),
              () => toggleAssignee(account.login),
              null
            )}
          {/each}
        {/if}
      {:else}
        <!--
          A milestone is one choice, so the clear row leads: the common edit is
          taking a pull request out of a milestone, and it has to be as cheap as
          putting it in one.
        -->
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors {draftMilestone ===
          null
            ? 'bg-primary/10'
            : 'hover:bg-elevated'}"
          aria-pressed={draftMilestone === null}
          title="Clear the milestone"
          onclick={() => chooseMilestone(null)}
        >
          <Flag size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
          <span class="min-w-0 flex-1 text-[0.6875rem] text-foreground">No milestone</span>
          {#if draftMilestone === null}
            <Check size={13} class="shrink-0 text-primary" />
          {/if}
        </button>
        <div class="my-1 h-px bg-border"></div>
        {#if milestoneRows.length === 0}
          <p class="px-2 py-4 text-center text-[0.6875rem] text-dimmed">
            {normalizedQuery
              ? `No milestone matches "${query.trim()}"`
              : 'This repository has no open milestones.'}
          </p>
        {:else}
          {#each milestoneRows as milestone (milestone.number)}
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors {draftMilestone ===
              milestone.number
                ? 'bg-primary/10'
                : 'hover:bg-elevated'}"
              aria-pressed={draftMilestone === milestone.number}
              title={`Attach ${milestone.title}`}
              onclick={() => chooseMilestone(milestone.number)}
            >
              <Tag size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[0.6875rem] text-foreground">
                  {milestone.title}
                </span>
                <span class="block truncate text-[0.625rem] text-dimmed">
                  #{milestone.number}
                  {#if milestone.dueOn}
                    · due {milestone.dueOn.slice(0, 10)}
                  {/if}
                </span>
              </span>
              {#if draftMilestone === milestone.number}
                <Check size={13} class="shrink-0 text-primary" />
              {/if}
            </button>
          {/each}
        {/if}
      {/if}
    </div>

    {#if error}
      <p class="text-[0.6875rem] leading-relaxed text-danger" role="alert">{error}</p>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      data-modal-dismiss
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!changed || busy}
      onclick={() => void save()}
    >
      {#if busy}
        <Loader2 size={14} class="animate-spin" />
      {/if}
      Save
    </button>
  {/snippet}
</Modal>
