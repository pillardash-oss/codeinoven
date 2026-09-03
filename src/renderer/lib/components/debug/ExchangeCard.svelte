<script lang="ts">
  import type { DebugExchange, DebugEvent } from '$lib/stores/agent-debug.svelte'
  import { copyText } from '$lib/copy-text'
  import {
    ChevronDown,
    ChevronRight,
    Copy,
    Check,
    MessageSquare,
    SquareTerminal,
    Sparkles,
    List,
    AlertTriangle
  } from '@lucide/svelte'

  interface Props {
    ex: DebugExchange
    open?: boolean
    onToggle?: () => void
  }

  let { ex, open = false, onToggle }: Props = $props()

  const expanded = $derived(open)
  let copiedId = $state<string | null>(null)

  const Icon = $derived(
    ex.channel === 'agent:sendPrompt'
      ? MessageSquare
      : ex.channel === 'agent:generateSpec'
        ? Sparkles
        : ex.channel === 'agent:runCommand'
          ? SquareTerminal
          : MessageSquare
  )

  async function copyExchange(): Promise<void> {
    const json = JSON.stringify(formatExchange(ex), null, 2)
    try {
      await copyText(json)
      copiedId = ex.id
      setTimeout(() => (copiedId = null), 1500)
    } catch {
      // clipboard not available
    }
  }

  function formatExchange(exchange: DebugExchange): unknown {
    return {
      timestamp: new Date(exchange.timestamp).toISOString(),
      channel: exchange.channel,
      label: exchange.label,
      projectId: exchange.projectId,
      threadId: exchange.threadId,
      sessionId: exchange.sessionId,
      status: exchange.status,
      error: exchange.error,
      request: exchange.data,
      events: exchange.events.map((ev) => ({
        timestamp: new Date(ev.timestamp).toISOString(),
        type: ev.type,
        sessionId: ev.sessionId,
        data: ev.data
      }))
    }
  }

  function timeLabel(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  function shortId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id
  }

  function eventSummary(events: DebugEvent[]): string {
    const counts: Record<string, number> = {}
    for (const ev of events) {
      counts[ev.type] = (counts[ev.type] ?? 0) + 1
    }
    const parts: string[] = []
    for (const [type, count] of Object.entries(counts)) {
      const short = type
        .replace('message.', 'msg.')
        .replace('part.', '')
        .replace('session.', '')
        .replace('permission.', 'perm.')
      parts.push(count > 1 ? `${count}× ${short}` : short)
    }
    return parts.join(', ')
  }

  function eventBadgeClass(type: string): string {
    if (type === 'session.idle') return 'bg-success/10 text-success'
    if (type === 'session.error') return 'bg-danger/10 text-danger'
    if (type === 'permission.asked') return 'bg-warning/10 text-warning'
    if (type.startsWith('message')) return 'bg-info/10 text-info'
    return 'bg-elevated text-muted'
  }

  function eventLabel(ev: DebugEvent): string {
    switch (ev.type) {
      case 'message.part.updated': {
        const part = ev.data as { type?: string; tool?: string }
        const kind =
          part.type === 'reasoning'
            ? 'reasoning'
            : part.type === 'tool'
              ? `tool:${part.tool ?? '?'}`
              : part.type === 'file'
                ? 'file'
                : part.type === 'text'
                  ? 'text'
                  : (part.type ?? '?')
        return `part updated — ${kind}`
      }
      case 'message.part.delta': {
        const d = ev.data as { field?: string; delta?: string }
        return `delta — ${d.field} (${d.delta?.length ?? 0} chars)`
      }
      case 'message.completed': {
        const d = ev.data as { error?: string }
        return d.error ? `message errored: ${d.error}` : 'message completed'
      }
      case 'permission.asked': {
        const p = ev.data as { permission?: string; patterns?: string[] }
        return `permission: ${p.permission ?? '?'} ${p.patterns?.join(', ') ?? ''}`
      }
      case 'permission.replied': {
        const r = ev.data as { reply?: string }
        return `permission: ${r.reply ?? '?'}`
      }
      case 'run.updated': {
        const run = ev.data as { status?: string; id?: string }
        return `run ${run.id ? shortId(run.id) : '?'} → ${run.status ?? '?'}`
      }
      default:
        return ev.type
    }
  }
</script>

<div>
  <!-- Header row -->
  <button class="flex w-full items-center gap-2 px-3 py-2.5 text-left" onclick={() => onToggle?.()}>
    <Icon size={13} class="shrink-0 text-muted" />
    <span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
      {ex.label}
    </span>
    <span class="shrink-0 text-[0.625rem] tabular-nums text-dimmed">
      {timeLabel(ex.timestamp)}
    </span>
    <span class="shrink-0 text-dimmed">
      {#if expanded}
        <ChevronDown size={12} />
      {:else}
        <ChevronRight size={12} />
      {/if}
    </span>
  </button>

  <!-- Summary row (collapsed) -->
  {#if !expanded}
    <div class="flex flex-wrap gap-1 px-3 pb-2.5">
      {#if ex.status === 'error' && ex.error}
        <span
          class="flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 font-mono text-[0.5625rem] text-danger"
        >
          <AlertTriangle size={9} />
          {ex.error}
        </span>
      {/if}
      {#if ex.threadId}
        <span
          class="rounded bg-elevated px-1.5 py-0.5 font-mono text-[0.5625rem] text-dimmed"
          title="Thread"
        >
          {shortId(ex.threadId)}
        </span>
      {/if}
      {#if ex.sessionId}
        <span
          class="rounded bg-elevated px-1.5 py-0.5 font-mono text-[0.5625rem] text-dimmed"
          title="Session"
        >
          S:{shortId(ex.sessionId)}
        </span>
      {/if}
      {#if ex.events.length > 0}
        <span
          class="flex items-center gap-1 rounded bg-elevated px-1.5 py-0.5 text-[0.5625rem] text-dimmed"
        >
          <List size={9} />
          {eventSummary(ex.events)}
        </span>
      {/if}
    </div>
  {/if}

  <!-- Expanded detail -->
  {#if expanded}
    <div class="space-y-1.5 px-3 pb-3">
      <!-- Request data -->
      {#if ex.data}
        <details class="rounded-md border border-border">
          <summary
            class="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[0.625rem] font-medium text-muted hover:bg-elevated"
          >
            Request
          </summary>
          <pre
            class="max-h-48 overflow-auto whitespace-pre-wrap px-2 pb-2 font-mono text-[0.625rem] leading-relaxed text-muted">{JSON.stringify(
              ex.data,
              null,
              2
            )}</pre>
        </details>
      {/if}

      <!-- Response (only for non-starter calls where it's meaningful) -->
      {#if ex.response !== undefined}
        <details class="rounded-md border border-border">
          <summary
            class="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[0.625rem] font-medium text-success hover:bg-elevated"
          >
            Response
          </summary>
          <pre
            class="max-h-48 overflow-auto whitespace-pre-wrap px-2 pb-2 font-mono text-[0.625rem] leading-relaxed text-muted">{JSON.stringify(
              ex.response,
              null,
              2
            )}</pre>
        </details>
      {/if}

      <!-- Events -->
      {#if ex.events.length > 0}
        <details class="rounded-md border border-border" open>
          <summary
            class="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[0.625rem] font-medium text-muted hover:bg-elevated"
          >
            Events ({ex.events.length})
          </summary>
          <div class="space-y-1 px-2 pb-2">
            {#each ex.events as ev (ev.id)}
              <details class="rounded border border-border/50">
                <summary
                  class="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-[0.5625rem] {eventBadgeClass(
                    ev.type
                  )}"
                >
                  <span class="font-mono">{timeLabel(ev.timestamp)}</span>
                  <span class="font-medium">{eventLabel(ev)}</span>
                </summary>
                <pre
                  class="max-h-32 overflow-auto whitespace-pre-wrap px-2 pb-1.5 font-mono text-[0.5625rem] leading-relaxed text-dimmed">{JSON.stringify(
                    ev.data,
                    null,
                    2
                  )}</pre>
              </details>
            {/each}
          </div>
        </details>
      {:else}
        <p class="text-[0.5625rem] text-dimmed italic">Waiting for events…</p>
      {/if}

      <!-- Copy -->
      <div class="flex items-center gap-2 pt-0.5">
        <button
          class="flex items-center gap-1 text-[0.5625rem] text-dimmed hover:text-foreground"
          onclick={() => void copyExchange()}
        >
          {#if copiedId === ex.id}
            <Check size={9} class="text-success" />
            <span class="text-success">Copied</span>
          {:else}
            <Copy size={9} />
            Copy JSON
          {/if}
        </button>
        {#if ex.status === 'error' && ex.error}
          <span class="text-[0.5625rem] text-danger">{ex.error}</span>
        {/if}
      </div>
    </div>
  {/if}
</div>
