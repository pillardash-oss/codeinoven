<script lang="ts">
  import CioZap from '@pdslng/cio-icon/CioZap.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { getCustomSvgDataUrl } from '../../../../lib/custom-svg-tint'
  import { vendorMatches } from '$lib/components/shared/model-picker-helpers'
  import type { ThinkingLevel } from '$shared/types'
  import type { OvenAppearance } from '$shared/ovens'
  import {
    CONVERSATION_METADATA_BADGE_CLASS,
    CONVERSATION_METADATA_ICONS
  } from './conversation-metadata-badges'

  const ThinkingMetadataIcon = CONVERSATION_METADATA_ICONS.thinking
  const AccountMetadataIcon = CONVERSATION_METADATA_ICONS.account
  const LocalMetadataIcon = CONVERSATION_METADATA_ICONS.local

  interface Props {
    /** The model doing the work. The whole group only renders when this is set. */
    modelLabel: string | null
    isFast: boolean
    thinkingLevel: ThinkingLevel | null
    providerName?: string | null
    providerId?: string | null
    harnessId?: string | null
    harnessName?: string | null
    accountLabel?: string | null
    ovenLabel?: string | null
    ovenIsLocal?: boolean
    ovenAppearance?: OvenAppearance
  }

  let {
    modelLabel,
    isFast,
    thinkingLevel,
    providerName,
    providerId,
    harnessId,
    harnessName,
    accountLabel,
    ovenLabel,
    ovenIsLocal = false,
    ovenAppearance
  }: Props = $props()

  // When the harness is its own vendor (OpenCode run through an OpenCode
  // provider) the harness mark already carries the brand, and drawing the vendor
  // mark beside it only repeats the same glyph on the same line.
  const harnessOwnsBrand = $derived.by(() => {
    const id = harnessId
    if (!id) return false
    return [providerName, providerId].some((name) => vendorMatches(id, name ?? ''))
  })
</script>

<!-- The trace's attribution, read left to right: harness, model, then the
     conditions that shape the run (fast, thinking, account, oven). It lives in
     the trace header so it stays on screen whether the trace is folded or not.
     One nowrap cluster that truncates its longest label: letting it break
     inside itself split the attribution over two rules. -->
<span class="flex min-w-0 items-center gap-x-1.5 whitespace-nowrap text-[0.5625rem] text-dimmed">
  {#if harnessId}
    <span class="flex shrink-0 items-center gap-1">
      <AgentIcon agentId={harnessId} size={14} />
      {#if harnessName}<span>{harnessName}</span>{/if}
    </span>
    <span class="shrink-0">·</span>
  {/if}
  <span class="flex min-w-0 items-center gap-1">
    {#if !harnessOwnsBrand}
      <VendorIcon name={providerName ?? modelLabel ?? ''} id={providerId ?? undefined} size={11} />
    {/if}
    <span class="truncate">{modelLabel}</span>
  </span>
  {#if isFast}
    <CioZap
      size={10}
      class="shrink-0 text-accent"
      fill="currentColor"
      aria-label="Fast inference"
      title="Fast inference"
    />
  {/if}
  {#if thinkingLevel}
    <span
      class={`${CONVERSATION_METADATA_BADGE_CLASS} capitalize`}
      title={`Thinking level: ${thinkingLevel}`}
      aria-label={`Thinking level: ${thinkingLevel}`}
    >
      <ThinkingMetadataIcon size={9} />
      {thinkingLevel}
    </span>
  {/if}
  {#if accountLabel && accountLabel !== 'Default'}
    <span
      class={CONVERSATION_METADATA_BADGE_CLASS}
      title={`Account: ${accountLabel ?? 'Default'}`}
      aria-label={`Account: ${accountLabel ?? 'Default'}`}
    >
      <AccountMetadataIcon size={10} />
      {accountLabel}
    </span>
  {/if}
  {#if ovenLabel}
    <span
      class={CONVERSATION_METADATA_BADGE_CLASS}
      title={`Oven: ${ovenLabel}`}
      aria-label={`Oven: ${ovenLabel}`}
    >
      {#if ovenIsLocal}
        <LocalMetadataIcon size={10} class="shrink-0" />
      {:else if ovenAppearance}
        <img
          class="h-3 w-3 shrink-0"
          alt=""
          src={ovenAppearance.customSvg
            ? getCustomSvgDataUrl(ovenAppearance.customSvg, ovenAppearance.color)
            : getIconSvgDataUrl(ovenAppearance.icon, ovenAppearance.color)}
        />
      {/if}
      {ovenLabel}
    </span>
  {/if}
</span>
