/**
 * Navigation-safe store for active agent runs and working-trace state.
 *
 * Keeps the "agent is working" flag and the current turn's walking-trace open
 * state keyed by thread, so switching away and back does not lose the trace.
 */

interface AgentRunEntry {
  /** True while the agent is processing the current turn. */
  busy: boolean;
  /** User message ID that started the current turn; used as the trace key. */
  currentTurnUserMessageId: string | null;
  /** Whether the working trace is currently open. */
  traceOpen: boolean;
  /** Whether the user explicitly opened the trace (vs auto-opened by busy state). */
  traceUserOpened: boolean;
}

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`;
}

class AgentRunsStore {
  #runs = new Map<string, AgentRunEntry>();

  /** Reactive cache keyed by `projectId:threadId`. */
  runs = $state(new Map<string, AgentRunEntry>());

  private entry(projectId: string, threadId: string): AgentRunEntry {
    const key = threadKey(projectId, threadId);
    let entry = this.#runs.get(key);
    if (!entry) {
      entry = {
        busy: false,
        currentTurnUserMessageId: null,
        traceOpen: false,
        traceUserOpened: false,
      };
      this.#runs.set(key, entry);
      this.runs = new Map(this.#runs);
    }
    return entry;
  }

  /** True while the agent is processing a turn for this thread. */
  isBusy(projectId: string, threadId: string): boolean {
    return this.runs.get(threadKey(projectId, threadId))?.busy ?? false;
  }

  /** ID of the user message that started the current turn, if any. */
  currentTurnUserMessageId(projectId: string, threadId: string): string | null {
    return (
      this.runs.get(threadKey(projectId, threadId))?.currentTurnUserMessageId ??
      null
    );
  }

  /** Whether the working trace is open for the current turn. */
  isTraceOpen(projectId: string, threadId: string): boolean {
    return this.runs.get(threadKey(projectId, threadId))?.traceOpen ?? false;
  }

  /** Whether the user explicitly opened the trace. */
  isTraceUserOpened(projectId: string, threadId: string): boolean {
    return (
      this.runs.get(threadKey(projectId, threadId))?.traceUserOpened ?? false
    );
  }

  /**
   * Mark a run as active. If a new turn is starting, resets trace state and
   * records the user message ID that owns the turn.
   */
  setBusy(
    projectId: string,
    threadId: string,
    busy: boolean,
    turnUserMessageId?: string,
  ): void {
    const entry = this.entry(projectId, threadId);
    const wasBusy = entry.busy;
    const isNewTurn =
      busy &&
      turnUserMessageId !== undefined &&
      turnUserMessageId !== entry.currentTurnUserMessageId;
    entry.busy = busy;

    if (isNewTurn && turnUserMessageId) {
      entry.currentTurnUserMessageId = turnUserMessageId;
      entry.traceOpen = false;
      entry.traceUserOpened = false;
    }

    // Auto-open the trace when a new turn starts; auto-close when it ends
    // unless the user explicitly opened it.
    if (busy && (!wasBusy || isNewTurn)) {
      entry.traceOpen = true;
    } else if (!busy && !entry.traceUserOpened) {
      entry.traceOpen = false;
    }

    this.#notify();
  }

  /** Toggle the working trace open/closed state, recording user intent. */
  setTraceOpen(
    projectId: string,
    threadId: string,
    open: boolean,
    userOpened: boolean,
  ): void {
    const entry = this.entry(projectId, threadId);
    entry.traceOpen = open;
    entry.traceUserOpened = userOpened;
    this.#notify();
  }

  /** Mark the run idle and close the trace unless the user opened it. */
  setIdle(projectId: string, threadId: string): void {
    const entry = this.entry(projectId, threadId);
    entry.busy = false;
    entry.currentTurnUserMessageId = null;
    if (!entry.traceUserOpened) {
      entry.traceOpen = false;
    }
    this.#notify();
  }

  /** Clear the run state for a thread (e.g. on deletion). */
  clear(projectId: string, threadId: string): void {
    const key = threadKey(projectId, threadId);
    this.#runs.delete(key);
    this.#notify();
  }

  #notify(): void {
    this.runs = new Map(this.#runs);
  }
}

export const agentRuns = new AgentRunsStore();
