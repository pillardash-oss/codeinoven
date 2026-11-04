<script lang="ts">
  import type { Snippet } from 'svelte'
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import { session } from '#lib/stores/session.svelte'

  /**
   * The header every panel wears: what the screen is, and the one control that
   * acts on the whole panel. Everything else the phone offers lives in the dock
   * at the foot of the screen, so this row stays a title and a single square.
   */
  interface Props {
    title: string
    subtitle?: string | null
    /** The tone of the state the subtitle names, drawn as its dot. */
    tone?: string | null
    count?: number | null
    /** A back control replaces the title's leading padding, as the design draws it. */
    back?: { href: string; label: string } | null
    actions?: Snippet
  }

  let { title, subtitle = null, tone = null, count = null, back = null, actions }: Props = $props()

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
  <div class="bar-row">
    {#if back}
      <a class="menu-btn" href={back.href} aria-label={back.label} title={back.label}>
        <CioBack size={20} />
      </a>
    {/if}
    <div class={back ? 'talk-id' : 'bar-title'}>
      <h1>
        {title}
        {#if count !== null && count !== undefined}<span class="count">{count}</span>{/if}
      </h1>
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
    {#if session.user}
      <a
        class="head-account"
        href="/settings"
        aria-label="Settings and account"
        title="Settings and account"
      >
        {initials}
      </a>
    {/if}
  </div>
</header>
