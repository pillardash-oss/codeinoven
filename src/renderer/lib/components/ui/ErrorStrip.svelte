<script lang="ts" module>
  import type { Component } from 'svelte'

  /**
   * The one action an error card asks for. There is exactly one: it sits in the
   * header while the card is folded and moves to the right of the footer when it
   * unfolds, so the open card stays balanced. Every other button belongs in the
   * footer, which only exists while the card is unfolded.
   */
  export interface ErrorStripAction {
    label: string
    /** Tooltip and accessible name; defaults to the label. */
    title?: string
    icon?: Component
    loading?: boolean
    disabled?: boolean
    onclick: () => void
  }

  /**
   * What the card is communicating, which is also its colour: `danger` for a
   * failure, `warning` for a limit or an outage the reader can wait out or fix,
   * `info` for a pause the app is already handling.
   */
  export type ErrorStripTone = 'danger' | 'warning' | 'info'
</script>

<script lang="ts">
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioCode from '@pdslng/cio-icon/CioCode.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import type { Snippet } from 'svelte'
  import { fade, slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import type { CardChipData } from '../shared/CardTimer.svelte'
  import type { CardFramePlacement } from '../shared/card-frame'
  import { foldSlide } from '../shared/card-motion'
  import { copyText } from '$lib/copy-text'
  import { motionDuration } from '$lib/motion'

  /**
   * The base every error card builds on.
   *
   * It is a card like any other in the composer stack: the shared frame, head
   * (icon, name, reading, fold) and foot (falsy actions left, the truthy action
   * right), so an error folds, times and places its actions exactly as the rest
   * do. What it adds is what an error needs and nothing else: a tone drawn from
   * the status it reports, the one primary action that follows the fold, Dismiss,
   * and the raw diagnostic text behind Raw error with a copy button. The headline
   * stays plain language; the plumbing only ever appears in the raw view.
   *
   * Other cards (engineering, questions, secrets, MCP, assistants) are not errors
   * and do not build on this.
   */
  interface Props {
    /** Plain headline naming the problem, never the plumbing. */
    title: string
    /** Leading mark; defaults to the attention mark. */
    icon?: Component
    tone?: ErrorStripTone
    /** The reading beside the fold: a countdown, an elapsed time, or a state word. */
    chip?: CardChipData
    /** Chips beside the headline, such as the provider's name. */
    meta?: Snippet
    /** Where the card belongs, as every composer card states it. */
    placement?: CardFramePlacement
    /** Accessible name of the card; defaults to the headline. */
    label?: string
    /** `alert` for a failure, `status` for a wait that is not one. */
    role?: 'alert' | 'status'
    /** A single plain sentence of cause and fix. Richer bodies use `children`. */
    message?: string
    /** Full diagnostic text, shown only on request. */
    rawError?: string
    /** Starts folded; bindable so a card can remember the reader's choice. */
    folded?: boolean
    /** Names the card in the fold control; defaults to the headline. */
    foldLabel?: string
    primary?: ErrorStripAction
    onDismiss?: () => void
    /** Tooltip and accessible name of Dismiss when it means more than dismissing. */
    dismissTitle?: string
    /** Disables Dismiss while the card's own work is in flight. */
    dismissDisabled?: boolean
    /** The body, below the message. */
    children?: Snippet
    /** Falsy actions beyond Dismiss and Raw error, at the left of the footer. */
    footerStart?: Snippet
    /** Every other action, at the right of the footer and before the primary. */
    footerEnd?: Snippet
    /** Another card sits directly above, so the top rule becomes the broken line. */
    stackedAbove?: boolean
    /** The surface below carries the join, so this card drops its bottom rule. */
    joinsBelow?: boolean
    class?: string
  }

  let {
    title,
    icon = CioAttention,
    tone = 'danger',
    chip,
    meta,
    placement = 'top',
    label,
    role = 'alert',
    message,
    rawError,
    folded = $bindable(true),
    foldLabel,
    primary,
    onDismiss,
    dismissTitle = 'Dismiss this error',
    dismissDisabled = false,
    children,
    footerStart,
    footerEnd,
    stackedAbove = false,
    joinsBelow = false,
    class: className = ''
  }: Props = $props()

  let rawOpen = $state(false)
  let copied = $state(false)

  // The frame and the header wash carry the status colour. Icons and the
  // headline stay in the card's own ink: the card is already the colour.
  const TONE_CLASS: Record<ErrorStripTone, { frame: string; wash: string }> = {
    danger: { frame: 'border-danger/40! border-l-danger!', wash: 'bg-danger/10' },
    warning: { frame: 'border-warning/40! border-l-warning!', wash: 'bg-warning/10' },
    info: { frame: 'border-info/40! border-l-info!', wash: 'bg-info/10' }
  }
  const toneClass = $derived(TONE_CLASS[tone])

  const hasFoot = $derived(
    Boolean(primary || onDismiss || rawError || footerStart || footerEnd) && !folded
  )

  async function copyRaw(): Promise<void> {
    if (!rawError) return
    try {
      await copyText(rawError, null)
      copied = true
      setTimeout(() => (copied = false), 1500)
    } catch {
      // The clipboard is not available; the text stays selectable.
    }
  }
</script>

<div {role} aria-live="polite" class={className}>
  <CardFrame {placement} label={label ?? title} {stackedAbove} {joinsBelow} class={toneClass.frame}>
    <CardHead
      {icon}
      {title}
      {chip}
      {meta}
      bind:folded
      foldLabel={foldLabel ?? title}
      class={toneClass.wash}
    >
      {#snippet actions()}
        {#if primary && folded}
          <span transition:fade={{ duration: motionDuration(120) }}>
            <CardButton
              label={primary.label}
              title={primary.title}
              icon={primary.icon}
              variant="primary"
              size="sm"
              loading={primary.loading}
              disabled={primary.disabled}
              onclick={primary.onclick}
            />
          </span>
        {/if}
      {/snippet}
    </CardHead>

    {#if !folded && (message || children || (rawError && rawOpen))}
      <div
        transition:slide={foldSlide()}
        class="flex flex-col gap-2 px-3 py-2.5 text-xs leading-relaxed text-muted"
      >
        {#if message}
          <p class="select-text">{message}</p>
        {/if}
        {@render children?.()}
        {#if rawError && rawOpen}
          <div class="flex flex-col gap-1.5">
            <pre
              class="m-0 max-h-60 overflow-auto border border-border bg-raised p-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground select-text"><code
                >{rawError}</code
              ></pre>
            <div>
              <CardButton
                label={copied ? 'Copied' : 'Copy'}
                title={copied ? 'Copied' : 'Copy the raw error'}
                icon={copied ? CioCheck : CioCopy}
                variant="ghost"
                size="xs"
                onclick={() => void copyRaw()}
              />
            </div>
          </div>
        {/if}
      </div>
    {/if}

    {#if hasFoot}
      <div transition:slide={foldSlide()}>
        <CardFoot yields="right">
          {#snippet left()}
            {#if onDismiss}
              <CardButton
                label="Dismiss"
                title={dismissTitle}
                icon={CioClose}
                variant="ghost"
                disabled={dismissDisabled}
                onclick={onDismiss}
              />
            {/if}
            {#if rawError}
              <CardButton
                label="Raw error"
                title={rawOpen ? 'Hide the raw error' : 'Show the raw error'}
                icon={CioCode}
                variant="ghost"
                onclick={() => (rawOpen = !rawOpen)}
              />
            {/if}
            {@render footerStart?.()}
          {/snippet}
          {#snippet right()}
            {@render footerEnd?.()}
            {#if primary}
              <span in:fade={{ duration: motionDuration(120), delay: motionDuration(120) }}>
                <CardButton
                  label={primary.label}
                  title={primary.title}
                  icon={primary.icon}
                  variant="primary"
                  loading={primary.loading}
                  disabled={primary.disabled}
                  onclick={primary.onclick}
                />
              </span>
            {/if}
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
