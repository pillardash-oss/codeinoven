/// <reference types="vite/client" />

import type { AgentEvent } from '$shared/types'
import { subscribe } from '$lib/ipc.svelte'

const MAX_EXCHANGES = 50

/** Channels that begin an exchange (start of a request-response cycle). */
const EXCHANGE_STARTERS = new Set(['agent:sendPrompt', 'agent:generateSpec', 'agent:runCommand'])

/**
 * A single raw event received during an exchange.
 */
export interface DebugEvent {
  id: string
  timestamp: number
  type: string
  sessionId?: string
  data: unknown
}

/**
 * One request-response cycle — the send plus all received events until idle/error.
 */
export interface DebugExchange {
  id: string
  timestamp: number
  channel: string
  label: string
  data: unknown
  projectId?: string
  threadId?: string
  sessionId?: string
  events: DebugEvent[]
  status: 'active' | 'idle' | 'error'
  error?: string
  response?: unknown
}

class AgentDebugStore {
  #exchanges = $state<DebugExchange[]>([])
  #active = $state<DebugExchange | null>(null)
  #enabled = $state(false)
  #filterQuery = $state('')
  #idSeq = 0
  #unsubscribes: (() => void)[] = []

  get exchanges(): DebugExchange[] {
    if (!this.#filterQuery) return this.#exchanges
    const q = this.#filterQuery.toLowerCase()
    return this.#exchanges.filter((ex) => {
      if (ex.channel.toLowerCase().includes(q)) return true
      if (ex.label.toLowerCase().includes(q)) return true
      if (ex.threadId?.toLowerCase().includes(q)) return true
      if (ex.projectId?.toLowerCase().includes(q)) return true
      if (ex.sessionId?.toLowerCase().includes(q)) return true
      if (ex.events.some((e) => e.type.toLowerCase().includes(q))) return true
      return false
    })
  }

  get active(): DebugExchange | null {
    return this.#active
  }

  get enabled(): boolean {
    return this.#enabled
  }

  get filterQuery(): string {
    return this.#filterQuery
  }

  set filterQuery(value: string) {
    this.#filterQuery = value
  }

  get exchangeCount(): number {
    return this.#exchanges.length
  }

  enable(): void {
    if (!import.meta.env.DEV) return
    if (this.#enabled) return
    this.#enabled = true
    this.#unsubscribes.push(
      subscribe('agent:event', (...args: unknown[]) => {
        const event = args[0] as AgentEvent
        if (!event) return
        this.#handleAgentEvent(event)
      })
    )
  }

  disable(): void {
    this.#enabled = false
    for (const unsub of this.#unsubscribes) {
      unsub()
    }
    this.#unsubscribes = []
  }

  toggle(): void {
    if (this.#enabled) this.disable()
    else this.enable()
  }

  /** Called by the invoke wrapper to capture outgoing agent IPC calls. */
  trackInvoke(channel: string, args: unknown[]): void {
    if (!import.meta.env.DEV) return
    if (!this.#enabled) return
    if (!channel.startsWith('agent:')) return

    const [projectId, threadId] = args as [string?, string?, ...unknown[]]

    // Abort cancels the active exchange
    if (channel === 'agent:abort') {
      if (this.#active) {
        this.#active.status = 'error'
        this.#active.error = 'Aborted by user'
        this.#finalizeActive()
      }
      return
    }

    // Start a new exchange for every call
    this.#startExchange(channel, args, projectId, threadId)
  }

  /** Attach the invoke result to the active exchange (sets response + finalizes non-starters). */
  trackResult(channel: string, result: unknown): void {
    if (!import.meta.env.DEV) return
    if (!this.#enabled) return

    const ex = this.#active
    if (!ex) return

    ex.response = result

    // Non-starter calls have no streaming events — finalize immediately
    if (!EXCHANGE_STARTERS.has(channel)) {
      ex.status = 'idle'
      this.#finalizeActive()
    }
  }

  clear(): void {
    this.#active = null
    this.#exchanges = []
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  #startExchange(channel: string, args: unknown[], projectId?: string, threadId?: string): void {
    const text =
      channel === 'agent:sendPrompt'
        ? ((args[3] as string) ?? '')
        : channel === 'agent:generateSpec'
          ? ((args[2] as { instructions?: string })?.instructions ?? '')
          : ''
    const label =
      channel === 'agent:sendPrompt' ? (text.length > 80 ? text.slice(0, 80) + '…' : text) : channel

    this.#active = {
      id: `ex-${this.#idSeq++}`,
      timestamp: Date.now(),
      channel,
      label,
      data: args,
      projectId,
      threadId,
      events: [],
      status: 'active'
    }
  }

  #handleAgentEvent(event: AgentEvent): void {
    const ex = this.#active
    if (!ex) return

    // Link session id from the event (catalog events are app-level and have none).
    if (event.type !== 'catalog.updated' && event.type !== 'providerCatalog.updated') {
      ex.sessionId = event.sessionId
    }

    switch (event.type) {
      case 'session.idle':
        ex.status = 'idle'
        this.#finalizeActive()
        break
      case 'session.error':
        ex.status = 'error'
        ex.error = event.error
        this.#finalizeActive()
        break
      case 'message.part.updated':
        this.#addEvent(event.type, event.part, event.sessionId)
        break
      case 'message.part.delta':
        this.#addEvent(
          event.type,
          { field: event.field, delta: event.delta, messageId: event.messageId },
          event.sessionId
        )
        break
      case 'message.completed':
        this.#addEvent(
          event.type,
          { messageId: event.messageId, error: event.error },
          event.sessionId
        )
        break
      case 'permission.asked':
        this.#addEvent(event.type, event.permission, event.sessionId)
        break
      case 'permission.replied':
        this.#addEvent(
          event.type,
          { requestId: event.requestId, reply: event.reply },
          event.sessionId
        )
        break
    }
  }

  #addEvent(type: string, data: unknown, sessionId?: string): void {
    const ex = this.#active
    if (!ex) return
    ex.events = [
      ...ex.events,
      { id: `ev-${this.#idSeq++}`, timestamp: Date.now(), type, sessionId, data }
    ]
  }

  #finalizeActive(): void {
    const ex = this.#active
    if (!ex) return
    this.#active = null
    this.#exchanges = [ex, ...this.#exchanges.slice(0, MAX_EXCHANGES - 1)]
  }
}

export const agentDebug = new AgentDebugStore()
