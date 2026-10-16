<script lang="ts">
  import CioCheck from '$lib/components/icons/cio/CioCheck.svelte'
  import CioPerson from '$lib/components/icons/cio/CioPerson.svelte'
  import CioSpinner from '$lib/components/icons/cio/CioSpinner.svelte'
  import CioTag from '$lib/components/icons/cio/CioTag.svelte'
  import { Flag } from '@lucide/svelte'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import { gitState } from '$lib/stores/git.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import type { PullRequestLabel, PullRequestMilestone, RepositoryMentionUser } from '$shared/types'
  import { mentionCandidates, participantMentionUsers } from './pr-mentions'
  import { prLabelStyle, type PrMetadataMode } from './pr-view'

  /** What a save answered: the write landed, or why it did not. */
  export type MetadataSaveOutcome =
    { status: 'saved' } | { status: 'completed' } | { status: 'failed'; message: string }

  /**
   * The label, assignee, and milestone pickers for one GitHub subject.
   *
   * One dialog rather than three, because the three are the same question: pick
   * from a repository catalog, then save. They share the search field, the loading
   * and error surfaces, the save action, and the footer, so the only thing that
   * differs is which list is drawn and which write runs.
   *
   * The subject is structural (`number` plus what it currently carries) rather than
   * a pull request, because an issue is edited by exactly the same controls; the
   * caller supplies the write, so this component knows nothing about which
   * collection the subject lives in.
   *
   * Nothing here writes until Save, so a picker opened by mistake costs nothing and
   * a half-made choice is never half-applied.
   */
  interface Props {
    number: number
    mode: PrMetadataMode
    projectId: string
    owner: string
    repo: string
    /** What the subject carries now, so the picker opens on the current state. */
    current: {
      labels?: PullRequestLabel[]
      assignees?: RepositoryMentionUser[]
      milestone?: PullRequestMilestone | null
    }
    /**
     * The subject's author, when it has one. Offered first among the assignee
     * candidates, the way the composer's mention popover ranks the people already
     * on the subject ahead of the repository directory.
     */
    authorLogin?: string | null
    /** Whether the caller's write is in flight, so the Save button reports it. */
    busy: boolean
    onClose: () => void
    onSave: (selection: {
      labels: string[]
      assignees: string[]
      milestone: number | null
    }) => Promise<MetadataSaveOutcome>
  }

  let {
    number,
    mode,
    projectId,
    owner,
    repo,
    current,
    authorLogin = null,
    busy,
    onClose,
    onSave
  }: Props = $props()

  /**
   * Drafts, seeded from what the subject carries now.
   *
   * Held as an edit over the subject rather than as a copy of it, so the picker
   * opens on the current state, follows the row if the cached subject is corrected
   * while it is open, and only stops following once the user has chosen something.
   */
  let editedLabels = $state<string[] | null>(null)
  let editedAssignees = $state<string[] | null>(null)
  let milestoneEdited = $state(false)
  let milestoneNumber = $state<number | null>(null)

  const draftLabels = $derived(editedLabels ?? (current.labels ?? []).map((label) => label.name))
  const draftAssignees = $derived(
    editedAssignees ?? (current.assignees ?? []).map((entry) => entry.login)
  )
  const draftMilestone = $derived(
    milestoneEdited ? milestoneNumber : (current.milestone?.number ?? null)
  )

  /** Select one milestone, or clear it, which is the one edit with no partial state. */
  function chooseMilestone(next: number | null): void {
    milestoneEdited = true
    milestoneNumber = next
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

  const loading = $derived(gitState.isBusy('pr-catalog'))

  const title = $derived(
    mode === 'labels'
      ? `Labels for #${number}`
      : mode === 'assignees'
        ? `Assign #${number}`
        : `Milestone for #${number}`
  )

  /**
   * The catalog read, once per mount.
   *
   * Each read degrades to an empty list on failure (see the store), so a picker can
   * always still be used to review and remove what the subject already carries.
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
   * Label rows: what the subject carries first, then the rest of the catalog.
   *
   * Carried-first is what makes an unlisted label removable: a repository can
   * rename or delete a label an old subject still wears, and a picker that only
   * drew the catalog would hide the one chip the user came to take off.
   */
  const labelRows = $derived.by((): PullRequestLabel[] => {
    const carried = current.labels ?? []
    const seen = new Set(carried.map((label) => label.name.toLowerCase()))
    const rest = labels.filter((label) => !seen.has(label.name.toLowerCase()))
    return [...carried, ...rest].filter(
      (label) => !normalizedQuery || label.name.toLowerCase().includes(normalizedQuery)
    )
  })

  /**
   * Account rows: the people already on the subject first, then the repository
   * directory, which is exactly the ordering the composer's mention popover uses.
   */
  const accountRows = $derived.by((): RepositoryMentionUser[] => {
    const participants = participantMentionUsers([
      ...(authorLogin ? [authorLogin] : []),
      ...(current.assignees ?? []).map((entry) => entry.login)
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
      const currentNames = (current.labels ?? []).map((label) => label.name).sort()
      return [...draftLabels].sort().join('\u0000') !== currentNames.join('\u0000')
    }
    if (mode === 'assignees') {
      const currentLogins = (current.assignees ?? [])
        .map((entry) => entry.login.toLowerCase())
        .sort()
      return (
        [...draftAssignees]
          .map((login) => login.toLowerCase())
          .sort()
          .join('\u0000') !== currentLogins.join('\u0000')
      )
    }
    return draftMilestone !== (current.milestone?.number ?? null)
  })

  async function save(): Promise<void> {
    if (!changed || busy) return
    error = null
    const outcome = await onSave({
      labels: draftLabels,
      assignees: draftAssignees,
      milestone: draftMilestone
    })
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
    class="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left transition-colors {checked
      ? 'bg-primary/10'
      : 'hover:bg-elevated'}"
    aria-pressed={checked}
    title={checked ? `Remove ${label}` : `Apply ${label}`}
    onclick={onToggle}
  >
    {#if swatch}
      <span class="h-3 w-3 shrink-0" style={prLabelStyle(swatch)} aria-hidden="true"></span>
    {:else}
      <CioPerson size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
    {/if}
    <span class="min-w-0 flex-1">
      <span class="block truncate font-mono text-[0.6875rem] text-foreground">{label}</span>
      {#if hint}
        <span class="block truncate text-[0.625rem] text-dimmed">{hint}</span>
      {/if}
    </span>
    {#if checked}
      <CioCheck size={13} class="shrink-0 text-primary" />
    {/if}
  </button>
{/snippet}

<Modal open {title} {onClose}>
  <div class="space-y-3">
    <input
      class="h-8 w-full border border-border bg-elevated px-2.5 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
      placeholder={searchPlaceholder}
      aria-label={searchPlaceholder}
      bind:value={query}
    />

    <div class="max-h-72 min-h-24 overflow-y-auto border border-border p-1">
      {#if loading && labelRows.length === 0 && accountRows.length === 0 && milestoneRows.length === 0}
        <p class="flex items-center justify-center gap-2 py-6 text-[0.6875rem] text-dimmed">
          <CioSpinner size={13} class="animate-spin" />
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
          taking a subject out of a milestone, and it has to be as cheap as putting
          it in one.
        -->
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left transition-colors {draftMilestone ===
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
            <CioCheck size={13} class="shrink-0 text-primary" />
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
              class="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left transition-colors {draftMilestone ===
              milestone.number
                ? 'bg-primary/10'
                : 'hover:bg-elevated'}"
              aria-pressed={draftMilestone === milestone.number}
              title={`Attach ${milestone.title}`}
              onclick={() => chooseMilestone(milestone.number)}
            >
              <CioTag size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
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
                <CioCheck size={13} class="shrink-0 text-primary" />
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
      class="border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      data-modal-dismiss
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-2 bg-primary px-3 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!changed || busy}
      onclick={() => void save()}
    >
      {#if busy}
        <CioSpinner size={14} class="animate-spin" />
      {/if}
      Save
    </button>
  {/snippet}
</Modal>
