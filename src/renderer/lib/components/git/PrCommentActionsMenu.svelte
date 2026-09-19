<script lang="ts">
  /**
   * Per-comment actions, matching the set github.com offers on one of its own
   * comments.
   *
   * Two rules shape what appears. GitHub only lets an author edit or delete a
   * comment, so those rows exist only for the viewer's own; and blocking is
   * meaningless on yourself, which is why the viewer login decides whether the
   * row is drawn at all rather than disabling a row that could never work.
   *
   * The two abuse actions leave the app on purpose. The account's OAuth scope is
   * `repo`, and blocking an account needs `user`, so github.com is where those
   * have to happen; the rows stay here so the menu is complete and the user is
   * not left wondering where the action went.
   */
  import {
    Ban,
    ClipboardCopy,
    Flag,
    Link2,
    MessageSquareQuote,
    MessageSquarePlus,
    Pencil,
    Trash2
  } from '@lucide/svelte'
  import { DropdownMenu as Menu } from 'bits-ui'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import type { PrMinimizeReason } from '$shared/types'

  interface Props {
    /** Login that wrote the comment. */
    author: string
    /** The signed-in account, or null while it is unknown. */
    viewerLogin: string | null
    /** Whether Edit is offered: your own comment, and the body is editable. */
    canEdit: boolean
    /** Whether Delete is offered. A description has no delete, only an edit. */
    canDelete: boolean
    /**
     * Whether Hide is offered. GitHub minimises a comment by its GraphQL node id,
     * which a description does not expose here.
     */
    canHide: boolean
    busy?: boolean
    /**
     * Where the three rows that leave the app actually go. Declared rather than
     * built here because only the caller knows the comment they belong to, and a
     * row that opens a URL has to declare it for the shared right-click menu to
     * offer the same actions a link offers.
     */
    externalUrls: {
      /** The new-issue page, prefilled with this comment as a reference. */
      reference: string
      /** GitHub's abuse-report form. */
      report: string
      /** The blocked-accounts settings, where blocking an account lives. */
      block: string
    }
    onCopyLink: () => void
    onCopyMarkdown: () => void
    onQuote: () => void
    onReferenceInNewIssue: () => void
    onEdit: () => void
    onDelete: () => void
    onHide: (reason: PrMinimizeReason) => void
    onReport: () => void
    onBlock: () => void
  }

  let {
    author,
    viewerLogin,
    canEdit,
    canDelete,
    canHide,
    busy = false,
    externalUrls,
    onCopyLink,
    onCopyMarkdown,
    onQuote,
    onReferenceInNewIssue,
    onEdit,
    onDelete,
    onHide,
    onReport,
    onBlock
  }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40'

  /**
   * Hiding is always explained by a reason: GitHub's classifier decides how the
   * collapse reads to everyone else ("This comment was marked as off-topic"), so
   * the reason is a submenu rather than a silent default.
   */
  const hideReasons: Array<{ id: PrMinimizeReason; label: string; hint: string }> = [
    { id: 'OFF_TOPIC', label: 'Off-topic', hint: 'unrelated to the discussion' },
    { id: 'OUTDATED', label: 'Outdated', hint: 'superseded by later work' },
    { id: 'RESOLVED', label: 'Resolved', hint: 'already handled' },
    { id: 'SPAM', label: 'Spam', hint: 'unsolicited advertising' },
    { id: 'ABUSE', label: 'Abuse', hint: 'reported to GitHub' }
  ]

  /** Blocking yourself is not an action GitHub offers, and never should be. */
  const canBlock = $derived(viewerLogin !== null && viewerLogin !== author)
</script>

<Menu.Item class={itemClass} onSelect={onCopyLink} disabled={busy}>
  <Link2 size={12} class="shrink-0 text-dimmed" />
  Copy link
</Menu.Item>
<Menu.Item class={itemClass} onSelect={onCopyMarkdown} disabled={busy}>
  <ClipboardCopy size={12} class="shrink-0 text-dimmed" />
  Copy Markdown
</Menu.Item>
<Menu.Item class={itemClass} onSelect={onQuote} disabled={busy}>
  <MessageSquareQuote size={12} class="shrink-0 text-dimmed" />
  Quote reply
</Menu.Item>
<Menu.Item
  class={itemClass}
  data-external-url={externalUrls.reference}
  onSelect={onReferenceInNewIssue}
  disabled={busy}
>
  <MessageSquarePlus size={12} class="shrink-0 text-dimmed" />
  Reference in new issue
</Menu.Item>

{#if canEdit || canDelete || canHide}
  <Menu.Separator class="my-1 h-px bg-border" />
{/if}

{#if canEdit}
  <Menu.Item class={itemClass} onSelect={onEdit} disabled={busy}>
    <Pencil size={12} class="shrink-0 text-dimmed" />
    Edit
  </Menu.Item>
{/if}

{#if canHide}
  <Menu.Sub>
    <Menu.SubTrigger class={itemClass} disabled={busy}>
      <Ban size={12} class="shrink-0 text-dimmed" />
      Hide
    </Menu.SubTrigger>
    <Menu.SubContent
      class="z-50 min-w-56 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
      sideOffset={4}
    >
      {#each hideReasons as reason (reason.id)}
        <Menu.Item class={itemClass} onSelect={() => onHide(reason.id)} disabled={busy}>
          <span class="w-3 text-center text-[0.625rem] text-dimmed">·</span>
          {reason.label}
          <span class="ml-auto pl-3 text-[0.5625rem] text-dimmed">{reason.hint}</span>
        </Menu.Item>
      {/each}
    </Menu.SubContent>
  </Menu.Sub>
{/if}

{#if canDelete}
  <Menu.Item
    class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-danger outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
    onSelect={onDelete}
    disabled={busy}
  >
    <Trash2 size={12} class="shrink-0" />
    Delete
  </Menu.Item>
{/if}

<Menu.Separator class="my-1 h-px bg-border" />

<Menu.Item
  class={itemClass}
  data-external-url={externalUrls.report}
  onSelect={onReport}
  disabled={busy}
>
  <Flag size={12} class="shrink-0 text-dimmed" />
  Report content
</Menu.Item>
{#if canBlock}
  <Menu.Item
    class={itemClass}
    data-external-url={externalUrls.block}
    onSelect={onBlock}
    disabled={busy}
  >
    <Ban size={12} class="shrink-0 text-dimmed" />
    Block @{githubDisplayLogin(author)}
  </Menu.Item>
{/if}
