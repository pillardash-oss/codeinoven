<script lang="ts">
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import { settingsHref, type Crumb } from '#lib/navigation'
  import { session } from '#lib/stores/session.svelte'

  /**
   * The header every panel wears: what the screen is, and the one control that
   * acts on the whole panel. Everything else the phone offers lives in the dock
   * at the foot of the screen, so this row stays a title and a single square.
   *
   * A screen that was opened from a panel wears its ancestry above that row: the
   * chevron goes back one step and the crumb says which step that is. The trail is
   * the ancestors and never the current screen, because the title underneath
   * already carries the current name.
   */
  interface Props {
    title: string
    subtitle?: string | null
    /** The tone of the state the subtitle names, drawn as its dot. */
    tone?: string | null
    count?: number | null
    /** A back control replaces the title's leading padding, as the design draws it. */
    back?: { href: string; label: string } | null
    /** The panels this screen sits under, nearest last. */
    trail?: Crumb[] | null
    /** A title that is itself a control (the threads and projects switcher); it
     *  replaces the plain heading so the caret and the menu sit inside it. */
    titleControl?: Snippet
    actions?: Snippet
  }

  let {
    title,
    subtitle = null,
    tone = null,
    count = null,
    back = null,
    trail = null,
    titleControl,
    actions
  }: Props = $props()

  let crumbs = $derived(trail ?? [])
  /** The nearest ancestor: where the chevron leads, and what it is called. */
  let parent = $derived(crumbs.at(-1) ?? null)
  /** On Settings the square would point at the screen it is already on. */
  let onSettings = $derived(page.url.pathname === '/settings')

  /** The person signed in: the account square, at the far right of the head. */
  let initials = $derived(initialsOf(session.user?.name ?? null, session.user?.email ?? ''))

  function initialsOf(name: string | null, email: string): string {
    const source = (name ?? email).trim()
    const parts = source.split(/[\s._@-]+/).filter(Boolean)
    const marks = parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('')
    return marks.length > 0 ? marks : '?'
  }
</script>

<header class="bar">
  {#if parent}
    <nav class="crumb-row" aria-label="Breadcrumb">
      <a
        class="crumb-back"
        href={parent.href}
        aria-label={`Back to ${parent.label}`}
        title={`Back to ${parent.label}`}
      >
        <CioBack size={18} />
      </a>
      <ol class="crumbs">
        {#each crumbs as crumb (crumb.href)}
          <li><a href={crumb.href}>{crumb.label}</a></li>
        {/each}
      </ol>
    </nav>
  {/if}
  <div class="bar-row">
    {#if back}
      <a class="menu-btn" href={back.href} aria-label={back.label} title={back.label}>
        <CioBack size={20} />
      </a>
    {/if}
    <div class={back ? 'talk-id' : 'bar-title'}>
      {#if titleControl}
        {@render titleControl()}
      {:else}
        <h1>
          {title}
          {#if count !== null && count !== undefined}<span class="count">{count}</span>{/if}
        </h1>
      {/if}
      {#if subtitle}
        <p class="bar-sub">
          {#if tone}<i class="dot" style:background={tone} aria-hidden="true"></i>{/if}
          <span>{subtitle}</span>
        </p>
      {/if}
    </div>
    {#if actions}
      <div class="actions">{@render actions()}</div>
    {/if}
    {#if session.user && !onSettings}
      <a
        class="head-account"
        href={settingsHref(page.url.pathname)}
        aria-label="Settings and account"
        title="Settings and account"
      >
        {initials}
      </a>
    {/if}
  </div>
</header>
