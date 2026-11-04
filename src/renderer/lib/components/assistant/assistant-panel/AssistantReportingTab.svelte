<script lang="ts">
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import EnumSelect from '$lib/components/ui/EnumSelect.svelte'
  import {
    ASSISTANT_DELIVERY_OPTIONS,
    ASSISTANT_IMPACT_OPTIONS,
    ASSISTANT_TIMELINESS_OPTIONS,
    assistantDeliveryChannelLabel
  } from '$shared/assistant-reporting'
  import type {
    Assistant,
    AssistantDeliveryChannel,
    AssistantImpact,
    AssistantTimeliness,
    UpdateAssistantInput
  } from '$shared/types'

  /**
   * Where this assistant's output goes, and how urgent it is. Every control here
   * writes one field of the assistant record and keeps the rest, so picking a
   * channel never silently discards the destination the user already gave.
   */
  interface Props {
    assistant: Assistant
    /** Whether the agreed channel can actually be honoured right now. */
    deliveryReady: boolean
    /** One write path for the assistant record, owned by the panel. */
    onPersist: (patch: UpdateAssistantInput, failure: string) => Promise<void>
  }

  let { assistant, deliveryReady, onPersist }: Props = $props()

  /** The delivery channels, with a hint saying whether the choice needs a connection. */
  const deliveryChoices = ASSISTANT_DELIVERY_OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    hint: option.external
      ? 'Needs a connection this assistant must have'
      : 'A normal thread notification inside CodeInOven'
  }))

  /**
   * Pick the delivery channel. The destination and any note are carried over, so
   * switching channel does not silently discard what the user already told the
   * agent; the in-app channel drops the destination because it has none.
   */
  function setDeliveryChannel(channel: AssistantDeliveryChannel): void {
    const current = assistant.delivery
    const target = current?.target?.trim()
    void onPersist(
      {
        delivery: {
          channel,
          ...(target && channel !== 'in-app' ? { target } : {}),
          ...(current?.note ? { note: current.note } : {})
        }
      },
      'Could not save the delivery channel'
    )
  }

  /** Commit the typed destination. The input is uncontrolled, so this is the only write. */
  function commitDeliveryTarget(raw: string): void {
    const delivery = assistant.delivery
    if (!delivery || delivery.channel === 'in-app') return
    const target = raw.trim()
    if (target === (delivery.target ?? '')) return
    void onPersist(
      {
        delivery: {
          channel: delivery.channel,
          ...(target ? { target } : {}),
          ...(delivery.note ? { note: delivery.note } : {})
        }
      },
      'Could not save the delivery destination'
    )
  }

  function clearDelivery(): void {
    void onPersist({ delivery: null }, 'Could not clear the delivery channel')
  }

  /**
   * Set one priority bracket, keeping the other. When the assistant has no
   * priority yet the other bracket starts from the middle of its scale, and the
   * tab immediately shows the pair that was actually saved.
   */
  function setPriorityTimeliness(timeliness: AssistantTimeliness): void {
    void onPersist(
      { priority: { timeliness, impact: assistant.priority?.impact ?? 'team' } },
      'Could not save the priority'
    )
  }

  function setPriorityImpact(impact: AssistantImpact): void {
    void onPersist(
      { priority: { timeliness: assistant.priority?.timeliness ?? 'today', impact } },
      'Could not save the priority'
    )
  }

  function clearPriority(): void {
    void onPersist({ priority: null }, 'Could not clear the priority')
  }
</script>

<div class="flex flex-col gap-2 p-3">
  <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
    <div class="flex items-center gap-1.5">
      <h2 class="text-[0.875rem] font-semibold text-foreground">Reporting</h2>
      {#if !deliveryReady}
        <span
          class="flex items-center"
          style="color: var(--color-warning)"
          role="img"
          aria-label="The delivery channel needs a connection"
          title="The delivery channel needs a connection"
        >
          <CioAttention size={11} strokeWidth={2} />
        </span>
      {/if}
    </div>
    <p class="text-[0.6875rem] leading-relaxed text-muted">
      Where this assistant's output goes, and how urgent it is. Agree it with the agent, or set it
      here.
    </p>
    <div class="flex flex-col">
      <div
        class="flex items-center justify-between gap-3 border-t border-border py-2 first:border-t-0"
      >
        <span class="shrink-0 text-[0.75rem] text-muted">Deliver to</span>
        <div class="flex min-w-0 flex-1 items-center gap-1">
          <EnumSelect
            options={deliveryChoices}
            value={assistant.delivery?.channel ?? null}
            onChange={setDeliveryChannel}
            placeholder="Delivery channel"
            ariaLabel="Delivery channel"
            title="Where this assistant's output is delivered"
            class="flex-1"
          />
          {#if assistant.delivery}
            <button
              type="button"
              class="shrink-0 px-1.5 py-1 text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              title="Clear the delivery channel"
              aria-label="Clear the delivery channel"
              onclick={clearDelivery}
            >
              Clear
            </button>
          {/if}
        </div>
      </div>

      {#if assistant.delivery && assistant.delivery.channel !== 'in-app'}
        <div class="border-t border-border py-2">
          <input
            type="text"
            class="w-full border border-border bg-elevated px-2.5 py-1.5 text-[0.75rem] text-foreground outline-none transition-colors placeholder:text-dimmed focus-visible:ring-2 focus-visible:ring-primary"
            placeholder="Destination: a chat, a channel, an address"
            aria-label="Delivery destination"
            title="The concrete destination, for example #eng-alerts"
            value={assistant.delivery.target ?? ''}
            onblur={(event) => commitDeliveryTarget(event.currentTarget.value)}
            onkeydown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
        </div>
      {/if}

      {#if assistant.delivery && !deliveryReady}
        <p
          class="border-t border-border py-2 text-[0.625rem] leading-relaxed"
          style="color: var(--color-warning)"
        >
          {assistantDeliveryChannelLabel(assistant.delivery.channel)} is not connected yet. Add it on
          the Connections tab; until then runs deliver in CodeInOven.
        </p>
      {/if}

      <div class="flex items-center justify-between gap-3 border-t border-border py-2">
        <span class="shrink-0 text-[0.75rem] text-muted">Timeliness</span>
        <div class="flex min-w-0 flex-1 items-center gap-1">
          <EnumSelect
            options={ASSISTANT_TIMELINESS_OPTIONS}
            value={assistant.priority?.timeliness ?? null}
            onChange={setPriorityTimeliness}
            placeholder="Timeliness"
            ariaLabel="Time-based priority"
            title="How soon this assistant's output matters"
            class="flex-1"
          />
        </div>
      </div>

      <div class="flex items-center justify-between gap-3 border-t border-border py-2">
        <span class="shrink-0 text-[0.75rem] text-muted">Impact</span>
        <div class="flex min-w-0 flex-1 items-center gap-1">
          <EnumSelect
            options={ASSISTANT_IMPACT_OPTIONS}
            value={assistant.priority?.impact ?? null}
            onChange={setPriorityImpact}
            placeholder="Impact"
            ariaLabel="Scope-based priority"
            title="How far this assistant's output reaches"
            class="flex-1"
          />
          {#if assistant.priority}
            <button
              type="button"
              class="shrink-0 px-1.5 py-1 text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              title="Clear the priority"
              aria-label="Clear the priority"
              onclick={clearPriority}
            >
              Clear
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>
