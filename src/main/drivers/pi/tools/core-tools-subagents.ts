/**
 * Generated sub-agent subsystem: worker session runtime, stop-request handling, live stream forwarding, and the cio_spawn_agent, cio_agent_status, and cio_agent_output tools.
 *
 * The returned text is one fragment of the generated core-tools extension
 * source; pi-core-tools-extension.ts concatenates every fragment in order so
 * the emitted module is byte-for-byte identical to the original single string.
 */
import {
  CIO_AGENT_OUTPUT_TOOL_NAME,
  CIO_AGENT_STATUS_TOOL_NAME,
  CIO_SPAWN_AGENT_TOOL_NAME,
  CIO_SUBAGENT_DONE_MESSAGE_TYPE,
  CIO_SUBAGENT_STREAM_STATUS_KEY
} from '../../../../lib/core-tools'

export function piCoreToolsSubagentSource(): string {
  return `  // ── Sub-agent spawning ──────────────────────────────────────────────
  // Sub-agents are nested pi sessions ("worker threads") controlled by the
  // primary agent. They never receive the spawn tool, so they cannot
  // recurse; their permission requests ride the parent's extension-UI
  // context so the permission card appears on the primary thread.
  const CIO_SUBAGENT_MARKER = 'cio-subagent:'
  const CIO_SUBAGENT_MAX_CONCURRENT = 4
  const CIO_SUBAGENT_OUTPUT_CAP = 20000
  const CIO_SUBAGENT_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const subAgents = new Map()
  let subAgentCounter = 0

  // ── App-owned stop requests ──────────────────────────────────────────
  // Pi's abort RPC reaches only the root run; workers are nested in-process
  // sessions the app cannot address. The driver publishes a stop request into
  // this session's stop-flag file when the user stops the thread (or one
  // worker), and this is the only code that can act on it.
  const CIO_STOP_FLAG_PATH = '__CIO_STOP_FLAG_PATH__'
  // Poll window while workers are live: two orders of magnitude below a
  // worker's own turn latency, and armed only while a worker runs, so an idle
  // session never polls.
  const CIO_STOP_POLL_MS = 400
  let stopFlagMtimeMs = -1
  let stopRequestToken = ''
  let stopRequestChildIds = []
  let consumedStopToken = ''
  let stopApplied = false
  let stopPollTimer = null

  /** Read the app's stop request (mtime-cached). The driver clears the token
   *  when the next turn starts, so an old request can never stop fresh work. */
  function readStopRequest() {
    try {
      const info = statSync(CIO_STOP_FLAG_PATH)
      if (info.mtimeMs !== stopFlagMtimeMs) {
        stopFlagMtimeMs = info.mtimeMs
        const parsed = JSON.parse(readFileSync(CIO_STOP_FLAG_PATH, 'utf8'))
        const source = typeof parsed === 'object' && parsed !== null ? parsed : {}
        stopRequestToken = typeof source.token === 'string' ? source.token : ''
        stopRequestChildIds = Array.isArray(source.childSessionIds) ? source.childSessionIds : []
      }
    } catch {
      stopFlagMtimeMs = -1
      stopRequestToken = ''
      stopRequestChildIds = []
    }
    return stopRequestToken
  }

  /** True while the app has a stop request this session has not applied yet. */
  function hasStopRequest() {
    const token = readStopRequest()
    return token !== '' && token !== consumedStopToken
  }

  /**
   * Apply the pending stop request. Each request is applied exactly once, and
   * an applied stop stays sticky until the next agent start: a worker spawned
   * after the sweep still belongs to the stopped turn, and the turn-end guard
   * must not wake the primary afterwards.
   */
  function applyStopRequest() {
    if (hasStopRequest()) {
      consumedStopToken = stopRequestToken
      const ids = stopRequestChildIds
      for (const record of subAgents.values()) {
        if (record.status !== 'running') continue
        if (ids.length > 0 && !ids.includes(record.childSessionId)) continue
        stopSubAgent(record)
      }
      stopApplied = true
    }
    return stopApplied
  }

  /** True when the app's pending stop request covers this worker. */
  function stopRequestCovers(record) {
    if (!hasStopRequest()) return false
    const ids = stopRequestChildIds
    return ids.length === 0 || ids.includes(record.childSessionId)
  }

  /**
   * Stop one worker for good: abort its run and remember the stop, so its
   * settle reports 'aborted' instead of a completed run and it never wakes the
   * primary with a done notification.
   */
  function stopSubAgent(record) {
    if (record.status !== 'running') return
    record.status = 'aborted'
    record.stopRequested = true
    try {
      void record.session.abort()
    } catch {}
  }

  /** Poll for stop requests, only while workers are live. */
  function ensureStopWatcher() {
    if (stopPollTimer) return
    readWatchedChildren()
    stopPollTimer = setInterval(function () {
      applyStopRequest()
      readWatchedChildren()
      let running = false
      for (const record of subAgents.values()) {
        if (record.status === 'running') {
          running = true
          break
        }
      }
      if (running) return
      clearInterval(stopPollTimer)
      stopPollTimer = null
    }, CIO_STOP_POLL_MS)
    // Never hold pi's event loop open on the app's behalf.
    if (typeof stopPollTimer.unref === 'function') stopPollTimer.unref()
  }

  function capOutput(text) {
    return text.length > CIO_SUBAGENT_OUTPUT_CAP
      ? text.slice(0, CIO_SUBAGENT_OUTPUT_CAP) + '\\n…(output truncated)'
      : text
  }

  // ── App-owned sub-agent watch state ──────────────────────────────────
  // The app names the child transcripts it is displaying right now in this
  // session's watch file. Token deltas and partial tool output exist only for
  // the live typewriter, so they are forwarded for watched children alone:
  // an unwatched worker still streams every structural record (messages, tool
  // calls, lifecycle, settle), which is all the card, the transcript capture
  // and the settle path need.
  const CIO_WATCH_FLAG_PATH = '__CIO_SUBAGENT_WATCH_PATH__'
  const CIO_WATCHED_CHILD_IDS = new Set()
  let watchFlagMtimeMs = -1

  /** Read the app's watched-children list (mtime-cached). */
  function readWatchedChildren() {
    try {
      const info = statSync(CIO_WATCH_FLAG_PATH)
      if (info.mtimeMs === watchFlagMtimeMs) return
      watchFlagMtimeMs = info.mtimeMs
      const parsed = JSON.parse(readFileSync(CIO_WATCH_FLAG_PATH, 'utf8'))
      const source = typeof parsed === 'object' && parsed !== null ? parsed : {}
      const ids = Array.isArray(source.childSessionIds) ? source.childSessionIds : []
      CIO_WATCHED_CHILD_IDS.clear()
      for (const id of ids) {
        if (typeof id === 'string' && id) CIO_WATCHED_CHILD_IDS.add(id)
      }
    } catch {
      watchFlagMtimeMs = -1
      CIO_WATCHED_CHILD_IDS.clear()
    }
  }

  /** True while the app is displaying this child's transcript. */
  function isChildWatched(childSessionId) {
    return CIO_WATCHED_CHILD_IDS.has(childSessionId)
  }

  function subAgentText(message) {
    const content = Array.isArray(message && message.content) ? message.content : []
    const parts = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      }
    }
    return parts.join('\\n\\n')
  }

  function subAgentFiles(record) {
    const files = Array.isArray(record.files) ? record.files : []
    return files.slice().sort()
  }

  function subAgentPayload(record) {
    return {
      agentId: record.agentId,
      purpose: record.purpose,
      childSessionId: record.childSessionId,
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
      status: record.status,
      ...(record.modelId ? { model: record.modelId } : {}),
      thinkingLevel: record.thinkingLevel,
      ...(record.error ? { error: record.error } : {}),
      files: subAgentFiles(record),
      output: record.output
    }
  }

  function sendSubAgentUpdate(onUpdate, record) {
    if (!onUpdate) return
    try {
      onUpdate({
        content: [
          { type: 'text', text: CIO_SUBAGENT_MARKER + JSON.stringify(subAgentPayload(record)) }
        ]
      })
    } catch {}
  }

  // ── Live sub-agent event stream ──────────────────────────────────────
  // A child session runs in-process, so the app can only see it through
  // this extension. Every child event is forwarded to the host over pi's
  // fire-and-forget \`setStatus\` channel: not the tool-update channel (pi
  // stops delivering updates once a background spawn's tool call returns)
  // and never \`sendMessage\` (that would leak the whole transcript into the
  // primary agent's context). The driver maps each forwarded record with the
  // same record mapper a root thread uses and emits child-scoped events, so
  // a sub-agent transcript streams exactly like a normal thread instead of
  // waiting for pi to flush the child's session file to disk.
  const CIO_SUBAGENT_STREAM_KEY = '${CIO_SUBAGENT_STREAM_STATUS_KEY}'
  // One stdout record per flush window: a chatty worker must not flood the
  // harness pipe with one record per streamed token.
  const CIO_SUBAGENT_STREAM_FLUSH_MS = 120
  const CIO_SUBAGENT_STREAM_MAX_RECORD = 24000
  const CIO_SUBAGENT_STREAM_MAX_CHUNK = 48000
  const CIO_SUBAGENT_STREAM_MAX_TEXT = 8000

  function capStreamText(value) {
    if (typeof value !== 'string') return value
    if (value.length <= CIO_SUBAGENT_STREAM_MAX_TEXT) return value
    return value.slice(0, CIO_SUBAGENT_STREAM_MAX_TEXT) + '\\n…(truncated for the live view)'
  }

  function streamContent(content) {
    if (!Array.isArray(content)) return []
    const blocks = []
    for (const block of content) {
      const value = recordValue(block)
      if (!value) continue
      if (value.type === 'text') {
        blocks.push({ type: 'text', text: capStreamText(value.text) })
        continue
      }
      if (value.type === 'thinking') {
        blocks.push({ type: 'thinking', thinking: capStreamText(value.thinking) })
        continue
      }
      if (value.type === 'toolCall') {
        blocks.push({
          type: 'toolCall',
          id: value.id,
          name: value.name,
          arguments: streamArgs(value.arguments)
        })
      }
    }
    return blocks
  }

  function streamArgs(args) {
    const value = recordValue(args)
    if (!value) return undefined
    const trimmed = {}
    for (const [key, item] of Object.entries(value)) {
      trimmed[key] = typeof item === 'string' ? capStreamText(item) : item
    }
    return trimmed
  }

  function streamMessage(message) {
    const value = recordValue(message)
    if (!value) return undefined
    return {
      ...(value.id ? { id: value.id } : {}),
      ...(value.role ? { role: value.role } : {}),
      ...(value.model ? { model: value.model } : {}),
      ...(value.provider ? { provider: value.provider } : {}),
      ...(value.usage ? { usage: value.usage } : {}),
      ...(value.stopReason ? { stopReason: value.stopReason } : {}),
      ...(value.isError === true ? { isError: true } : {}),
      ...(value.toolCallId ? { toolCallId: value.toolCallId } : {}),
      ...(value.toolName ? { toolName: value.toolName } : {}),
      ...(typeof value.errorMessage === 'string'
        ? { errorMessage: capStreamText(value.errorMessage) }
        : {}),
      content: streamContent(value.content)
    }
  }

  function streamResult(result) {
    const value = recordValue(result)
    if (!value) return undefined
    return {
      ...(value.isError === true ? { isError: true } : {}),
      ...(typeof value.error === 'string' ? { error: capStreamText(value.error) } : {}),
      content: streamContent(value.content)
    }
  }

  /**
   * Trim one child session event down to the fields the driver's Pi record
   * mapper needs. Dropping the bulk (partial messages, image data, oversized
   * tool output) keeps the forwarded stream roughly the size of a root
   * thread's own event stream.
   */
  function trimStreamRecord(event) {
    if (!event || typeof event !== 'object') return null
    const lifecycle = {
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.aborted === true ? { aborted: true } : {}),
      ...(typeof event.errorMessage === 'string'
        ? { errorMessage: capStreamText(event.errorMessage) }
        : {}),
      ...(typeof event.success === 'boolean' ? { success: event.success } : {}),
      ...(typeof event.finalError === 'string'
        ? { finalError: capStreamText(event.finalError) }
        : {}),
      ...(event.result ? { result: streamResult(event.result) } : {})
    }
    if (
      event.type === 'turn_start' ||
      event.type === 'agent_start' ||
      event.type === 'agent_settled' ||
      event.type === 'compaction_start' ||
      event.type === 'compaction_end' ||
      event.type === 'auto_compaction_start' ||
      event.type === 'auto_compaction_end' ||
      event.type === 'auto_retry_start' ||
      event.type === 'auto_retry_end'
    ) {
      return { type: event.type, ...lifecycle }
    }
    if (event.type === 'message_start') {
      return { type: 'message_start', message: streamMessage(event.message) }
    }
    if (event.type === 'message_update') {
      const delta = recordValue(event.assistantMessageEvent)
      const message = recordValue(event.message)
      if (!delta) return null
      return {
        type: 'message_update',
        message: { ...(message && message.id ? { id: message.id } : {}), role: message && message.role },
        assistantMessageEvent: {
          type: delta.type,
          contentIndex: delta.contentIndex,
          ...(typeof delta.delta === 'string' ? { delta: delta.delta } : {})
        }
      }
    }
    if (event.type === 'message_end') {
      return { type: 'message_end', message: streamMessage(event.message) }
    }
    if (event.type === 'tool_execution_start') {
      return {
        type: 'tool_execution_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: streamArgs(event.args)
      }
    }
    if (event.type === 'tool_execution_update') {
      return {
        type: 'tool_execution_update',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: streamArgs(event.args),
        partialResult: streamResult(event.partialResult)
      }
    }
    if (event.type === 'tool_execution_end') {
      return {
        type: 'tool_execution_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: streamArgs(event.args),
        isError: event.isError === true,
        result: streamResult(event.result)
      }
    }
    if (event.type === 'turn_end') {
      // Tool results already streamed as \`tool_execution_end\`; the turn end
      // only contributes the completion (usage, stop reason, failure).
      return { type: 'turn_end', message: streamMessage(event.message), toolResults: [] }
    }
    return null
  }

  /**
   * Batched forwarder for one child session. Records are queued and flushed
   * every window, split into bounded records, and the final flush carries the
   * settle signal so the driver can close the child's transcript.
   */
  function createSubAgentStream(parentCtx, childSessionId) {
    let queue = []
    let timer = null

    function send(records, extra) {
      if (records.length === 0 && !extra) return
      const ui = parentCtx && parentCtx.ui
      if (!ui || typeof ui.setStatus !== 'function') return
      try {
        ui.setStatus(
          CIO_SUBAGENT_STREAM_KEY,
          JSON.stringify({ childSessionId, records, ...(extra || {}) })
        )
      } catch {}
    }

    function flush(extra) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const pending = queue
      queue = []
      let batch = []
      let size = 0
      for (const record of pending) {
        let encoded
        try {
          encoded = JSON.stringify(record)
        } catch {
          continue
        }
        if (encoded.length > CIO_SUBAGENT_STREAM_MAX_RECORD) continue
        if (size > 0 && size + encoded.length > CIO_SUBAGENT_STREAM_MAX_CHUNK) {
          send(batch)
          batch = []
          size = 0
        }
        batch.push(record)
        size += encoded.length
      }
      send(batch, extra)
    }

    return {
      push(event) {
        // The high-frequency records (per-token deltas, partial tool output)
        // are forwarded only for a child the app is watching. Everything else
        //   messages, tool calls, lifecycle and the settle record below   is
        // forwarded for every worker, so an unwatched worker's card, status
        // and transcript capture behave exactly as before.
        if (
          (event.type === 'message_update' || event.type === 'tool_execution_update') &&
          !isChildWatched(childSessionId)
        ) {
          return
        }
        const record = trimStreamRecord(event)
        if (!record) return
        queue.push(record)
        if (!timer) timer = setTimeout(function () { flush() }, CIO_SUBAGENT_STREAM_FLUSH_MS)
      },
      settle(status, error) {
        flush({ settled: true, status, ...(error ? { error } : {}) })
      }
    }
  }

  /**
   * What the primary agent receives: metadata plus ONLY the sub-agent's
   * final message   never the running transcript. The full transcript stays
   * in the sub-agent's own session, viewable in the UI.
   */
  function subAgentResult(record) {
    return {
      agentId: record.agentId,
      purpose: record.purpose,
      childSessionId: record.childSessionId,
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
      status: record.status,
      ...(record.modelId ? { model: record.modelId } : {}),
      thinkingLevel: record.thinkingLevel,
      ...(record.error ? { error: record.error } : {}),
      files: subAgentFiles(record),
      output: record.finalOutput || record.output,
      ...(record.endedAt ? { durationMs: record.endedAt - record.startedAt } : {})
    }
  }

  /**
   * What a status poll receives: metadata only, deliberately WITHOUT the
   * worker output. Polling is the hot path (every turn end waits on it) and
   * a finished worker's final message can be tens of thousands of characters,
   * so shipping it on a "is it still running?" question pollutes the primary
   * agent's context with text it may never need. Use ${CIO_AGENT_OUTPUT_TOOL_NAME}
   * to read a finished worker's output on demand.
   */
  function subAgentStatus(record) {
    return {
      agentId: record.agentId,
      purpose: record.purpose,
      status: record.status,
      ...(record.error ? { error: record.error } : {})
    }
  }

  /** Final output of a finished worker; the live preview is the fallback. */
  function subAgentOutput(record) {
    return record.finalOutput || record.output || '(the sub-agent produced no text output)'
  }

  /** Flag a failed worker in the error map returned by ${CIO_AGENT_OUTPUT_TOOL_NAME}. */
  function recordSubAgentError(errors, record) {
    if (record.status !== 'error') return
    errors[record.agentId] = 'Sub-agent failed: ' + (record.error || 'unknown error')
  }

  /**
   * Steer the primary agent when a background sub-agent finishes. Uses a
   * display:false custom message: it reaches the model as a user-role
   * context message (with the final output) but never shows in the
   * transcript   the driver ignores custom-role messages. While the primary
   * is streaming this steers the current run; when idle it triggers a turn.
   */
  function notifySubAgentDone(record) {
    if (!pi || typeof pi.sendMessage !== 'function') return
    // A worker the user stopped must never wake the primary: the point of the
    // stop was to end its work, and a triggerTurn here would start a fresh
    // primary turn seconds after the user pressed stop.
    if (!record || record.stopRequested) return
    const files = subAgentFiles(record)
    const text =
      'Sub-agent done for task ' + record.purpose + ' (' + record.agentId + ', status: ' + record.status + ').' +
      (record.error ? ' Error: ' + record.error : '') +
      (files.length > 0 ? '\\n\\nFiles it worked on (you are responsible for committing approved work): ' + files.join(', ') : '') +
      '\\n\\nThis is the final output of the sub-agent   use it as you continue your work:\\n\\n' +
      (record.finalOutput || record.output || '(the sub-agent produced no text output)')
    try {
      void pi.sendMessage(
        {
          customType: '${CIO_SUBAGENT_DONE_MESSAGE_TYPE}',
          content: text,
          display: false,
          // Structured terminal payload for the CodeInOven driver: once this
          // spawn tool call has returned, pi drops tool-execution updates,
          // so this custom message is the only channel that can still close
          // the sub-agent card on the primary thread.
          details: subAgentPayload(record)
        },
        { triggerTurn: true, deliverAs: 'steer' }
      )
    } catch {}
  }

  async function resolveSubAgentModel(parentCtx, reference) {
    const registry = parentCtx.modelRegistry
    const slashIndex = reference.indexOf('/')
    if (slashIndex > 0) {
      const found = registry.find(reference.slice(0, slashIndex), reference.slice(slashIndex + 1))
      if (found) return found
    }
    const available = registry.getAvailable()
    const byId = available.find(function (candidate) { return candidate.id === reference })
    if (byId) return byId
    const all = registry.getAll()
    return (
      all.find(function (candidate) { return candidate.id === reference }) ??
      // Case-insensitive fallback: model ids arrive from free-form tool args.
      all.find(function (candidate) {
        return candidate.id.toLowerCase() === reference.toLowerCase()
      })
    )
  }

  /** Built-in worker tools wrapped with the same permission gate as the primary. */
  function gatedWorkerTools(parentCtx, touchedFiles) {
    async function gate(toolName, params) {
      const hit = evaluateGate(toolName, recordValue(params) ?? {}, parentCtx.cwd)
      if (!hit) return null
      const payload = {
        permission: hit.permission,
        patterns: hit.patterns,
        tool: toolName,
        subagent: true,
        ...(hit.command === undefined ? {} : { command: hit.command })
      }
      const approved = await parentCtx.ui.confirm(
        'Sub-agent needs permission: ' + hit.reason,
        CIO_PERMISSION_MARKER + JSON.stringify(payload)
      )
      if (approved) return null
      return (
        'The user denied this sub-agent action in the permission card because it is destructive (' +
        hit.reason +
        '). Do not retry it as-is; continue with a safe alternative.'
      )
    }
    const builtins = [
      createReadToolDefinition(parentCtx.cwd),
      createBashToolDefinition(parentCtx.cwd),
      createEditToolDefinition(parentCtx.cwd),
      createWriteToolDefinition(parentCtx.cwd)
    ]
    return builtins.map(function (definition) {
      const inner = definition.execute.bind(definition)
      return {
        ...definition,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const denial = await gate(definition.name, params)
          if (denial) {
            return { content: [{ type: 'text', text: denial }] }
          }
          // Track every file the worker edits or writes so the primary can
          // commit the work; shell-created files are reported by the worker
          // in its final message instead.
          if (
            touchedFiles &&
            (definition.name === 'edit' || definition.name === 'write') &&
            typeof params === 'object' &&
            params !== null &&
            typeof params.path === 'string' &&
            !touchedFiles.includes(params.path)
          ) {
            touchedFiles.push(params.path)
          }
          return inner(toolCallId, params, signal, onUpdate, ctx)
        }
      }
    })
  }

  /**
   * Cwd-bound session services shared by every worker in this harness process.
   * Building a session from scratch reads settings, models, the project
   * context file, and the whole skill catalog from disk again for each worker;
   * one set per cwd serves all of them, because the readers are read-only and
   * \`createAgentSessionFromServices\` neither reloads nor mutates them.
   *
   * The loader is only shared while it carries no extensions: an extension's
   * runtime is per-active-session state that each newly built session
   * overwrites, so sharing one loader across sessions that register extensions
   * would retarget their callbacks. Without extensions there is nothing to
   * retarget, and the fallback below keeps the previous per-worker build.
   */
  const sharedWorkerServicesByCwd = new Map()

  function sharedWorkerServices(parentCtx) {
    const cwd = parentCtx && parentCtx.cwd
    if (!cwd) return Promise.resolve(null)
    const existing = sharedWorkerServicesByCwd.get(cwd)
    if (existing) return existing
    const pending = createAgentSessionServices({ cwd })
      .then(function (services) {
        if (services.resourceLoader.getExtensions().extensions.length > 0) return null
        mirrorParentProviders(parentCtx, services.modelRuntime)
        return services
      })
      .catch(function () {
        return null
      })
    sharedWorkerServicesByCwd.set(cwd, pending)
    return pending
  }

  /** Copy the parent's app-managed provider registrations onto a target runtime. */
  function mirrorParentProviders(parentCtx, target) {
    const registry = parentCtx && parentCtx.modelRegistry
    if (!registry || !target || typeof target.registerProvider !== 'function') return
    const providerIds = registry.getRegisteredProviderIds()
    for (const providerId of providerIds) {
      const config = registry.getRegisteredProviderConfig(providerId)
      if (!config) continue
      try {
        target.registerProvider(providerId, config)
      } catch {}
    }
  }

  /**
   * Build one worker session. Shared services when they are available (the
   * common case, and the reason a worker no longer pays a full cold start of
   * its own), the plain from-scratch build otherwise.
   */
  async function createWorkerSession(parentCtx, sessionManager, resolvedModel, spec, customTools) {
    const shared = await sharedWorkerServices(parentCtx)
    const modelOptions = {
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {})
    }
    if (shared) {
      const created = await createAgentSessionFromServices({
        services: shared,
        sessionManager,
        ...modelOptions,
        tools: ['read', 'bash', 'edit', 'write'],
        customTools
      })
      return { session: created.session, shared: true }
    }
    const created = await createAgentSession({
      cwd: parentCtx.cwd,
      sessionManager,
      ...modelOptions,
      tools: ['read', 'bash', 'edit', 'write'],
      customTools
    })
    return { session: created.session, shared: false }
  }

  async function runSubAgent(parentCtx, onUpdate, spec, signal) {
    let runningCount = 0
    for (const record of subAgents.values()) {
      if (record.status === 'running') runningCount += 1
    }
    if (runningCount >= CIO_SUBAGENT_MAX_CONCURRENT) {
      return {
        error:
          'Too many sub-agents are running (' + CIO_SUBAGENT_MAX_CONCURRENT + ' max). Wait for one to finish (${CIO_AGENT_STATUS_TOOL_NAME} with wait: true), read its result with ${CIO_AGENT_OUTPUT_TOOL_NAME}, and only then spawn another.'
      }
    }
    let resolvedModel = parentCtx.model
    if (spec.model) {
      resolvedModel = await resolveSubAgentModel(parentCtx, spec.model)
      if (!resolvedModel) return { error: 'Model not found: ' + spec.model }
    }
    subAgentCounter += 1
    const agentId = 'cio-subagent-' + subAgentCounter
    // Declared before the session is built: gatedWorkerTools receives this
    // array at creation time, so it must not sit in the temporal dead zone.
    const touchedFiles = []
    let session
    let sharedServices = false
    try {
      const parentSessionFile = readParentSessionFile(parentCtx)
      const sessionDir = process.env.CIO_SUBAGENT_SESSION_DIR
      // The child links itself to the parent in its own session header, so an
      // orphaned worker transcript can be told apart from a thread transcript
      // when stale session files are pruned.
      const newSessionOptions = parentSessionFile ? { parentSession: parentSessionFile } : undefined
      const sessionManager = sessionDir
        ? SessionManager.create(parentCtx.cwd, sessionDir, newSessionOptions)
        : SessionManager.create(parentCtx.cwd, undefined, newSessionOptions)
      const created = await createWorkerSession(
        parentCtx,
        sessionManager,
        resolvedModel,
        spec,
        gatedWorkerTools(parentCtx, touchedFiles)
      )
      session = created.session
      sharedServices = created.shared
      pruneStaleWorkerSessions(session.sessionFile)
    } catch (error) {
      return {
        error:
          'Failed to start the sub-agent session: ' +
          (error && error.message ? error.message : String(error))
      }
    }
    if (!sharedServices) {
      // App-managed custom providers live only in the primary session's model
      // registry; mirror them so the sub-agent resolves the same models. With
      // shared services the mirror already ran once for the whole process.
      mirrorParentProviders(parentCtx, session.modelRuntime)
    }
    const record = {
      agentId,
      purpose: spec.purpose,
      childSessionId: session.sessionId,
      sessionFile: session.sessionFile,
      modelId: resolvedModel ? resolvedModel.provider + '/' + resolvedModel.id : '',
      thinkingLevel: spec.thinkingLevel ?? parentCtx.thinkingLevel ?? 'medium',
      status: 'running',
      output: '',
      files: touchedFiles,
      startedAt: Date.now(),
      // Set when the app's stop request reaches this worker: it decides the
      // settle status ('aborted') and bars the done notification from waking
      // the primary after the user stopped the session.
      stopRequested: false,
      session
    }
    subAgents.set(agentId, record)
    // The child's transcript streams to the app from the moment the session
    // exists: no waiting for pi to flush the child's session file, and no
    // polling on the renderer side.
    const stream = createSubAgentStream(parentCtx, session.sessionId)
    // The run that spawned this worker was aborted, so the worker's own run
    // ends with it and its result is not a completion. The stop-request sweep
    // is the app-initiated path; this covers an abort pi raised itself.
    const onAbort = function () {
      if (record.status !== 'running') return
      record.status = 'aborted'
      try {
        void session.abort()
      } catch {}
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    ensureStopWatcher()
    session.subscribe(function (event) {
      stream.push(event)
      if (event.type !== 'message_end') return
      const text = subAgentText(event.message)
      if (!text) return
      record.output = capOutput(record.output ? record.output + '\\n\\n' + text : text)
      sendSubAgentUpdate(onUpdate, record)
    })
    record.promise = (async function () {
      try {
        // The worker gets the CodeInOven framing around the primary agent's raw
        // instructions, so the file-report contract (the primary agent is the one
        // that commits) actually reaches the worker instead of only being
        // described in the spawn tool's schema.
        await session.prompt(workerPrompt(spec), { expandPromptTemplates: false })
        // A worker the user stopped never resolves as a completion: an aborted
        // child run resolves its prompt, so the status must not be reset here.
        if (record.status !== 'aborted') record.status = 'completed'
      } catch (error) {
        if (record.status !== 'aborted') {
          record.status = 'error'
          record.error = error && error.message ? error.message : String(error)
        }
      } finally {
        // A stop request that landed while this worker was finishing applies to
        // this record too: a raced stop must never be reported as a completion.
        // The sweep is applied as well, so the remaining workers stop with it.
        const coveredByStop = stopRequestCovers(record)
        applyStopRequest()
        if (coveredByStop) {
          record.status = 'aborted'
          record.stopRequested = true
        }
        // Only the sub-agent's final message goes back to the primary agent;
        // the accumulated output stays a live preview for the UI card.
        record.finalOutput = capOutput(subAgentText(lastAssistant(session)))
        record.endedAt = Date.now()
        sendSubAgentUpdate(onUpdate, record)
        // Flush the tail of the transcript and close the live stream so the
        // view settles on its final transcript instead of a stuck spinner.
        stream.settle(
          record.status === 'aborted' ? 'aborted' : record.status === 'error' ? 'error' : 'idle',
          record.error
        )
        // The worker's transcript is app-owned from here on: the engine mirrors
        // it into its own store when the child settles, so the harness session
        // file is pure duplication from the harness session dir, which holds
        // whole transcripts and never had a pruning path.
        discardWorkerSessionFile(record.sessionFile)
        // Background workers announce themselves; foreground spawns are
        // awaited inline by the primary and need no notification.
        if (spec.background && !record.stopRequested) notifySubAgentDone(record)
      }
    })()
    return { record }
  }

  function lastAssistant(session) {
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index]
      if (message && message.role === 'assistant') return message
    }
    return null
  }

  /** The parent's own session file, for the child's \`parentSession\` header. */
  function readParentSessionFile(parentCtx) {
    try {
      const manager = parentCtx && parentCtx.sessionManager
      const file =
        manager && typeof manager.getSessionFile === 'function' ? manager.getSessionFile() : undefined
      return typeof file === 'string' && file ? file : undefined
    } catch {
      return undefined
    }
  }

  /** Best-effort removal of a settled worker's session file. */
  function discardWorkerSessionFile(sessionFile) {
    if (typeof sessionFile !== 'string' || !sessionFile) return
    try {
      rmSync(sessionFile, { force: true })
    } catch {}
  }

  /**
   * Worker transcripts are deleted when they settle, but a crash or a
   * force-quit can leave one behind, and nothing else ever cleans the harness
   * session directory. This sweeps those leftovers: only files whose header
   * links them to a parent session (see \`parentSession\` on the worker session)
   * and that have not been touched for a week are removed, so a live worker and
   * a thread transcript are never candidates. At most one sweep per process,
   * off the event loop, so a spawn never waits on it.
   */
  const WORKER_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
  let workerSessionPruneStarted = false

  function pruneStaleWorkerSessions(sessionFile) {
    if (workerSessionPruneStarted) return
    if (typeof sessionFile !== 'string' || !sessionFile) return
    workerSessionPruneStarted = true
    void (async function () {
      try {
        const directory = dirname(sessionFile)
        const names = await readdir(directory)
        const now = Date.now()
        for (const name of names) {
          if (name.slice(-6) !== '.jsonl') continue
          const candidate = join(directory, name)
          if (candidate === sessionFile) continue
          try {
            const info = await stat(candidate)
            if (now - info.mtimeMs <= WORKER_SESSION_MAX_AGE_MS) continue
            if (!(await hasWorkerSessionHeader(candidate))) continue
            await rm(candidate, { force: true })
          } catch {}
        }
      } catch {}
    })()
  }

  /** True when a session file's header links it to a parent session. */
  async function hasWorkerSessionHeader(filePath) {
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(4096)
      const read = await handle.read(buffer, 0, buffer.length, 0)
      const text = buffer.subarray(0, read.bytesRead).toString('utf8')
      const newline = text.indexOf('\\n')
      if (newline === -1 || text.indexOf('"parentSession"') === -1) return false
      const header = JSON.parse(text.slice(0, newline))
      return typeof header.parentSession === 'string' && header.parentSession.length > 0
    } catch {
      return false
    } finally {
      await handle.close()
    }
  }

  function workerPrompt(spec) {
    return [
      'You are a CodeInOven sub-agent spawned by the primary agent to own one focused piece of work.',
      'Purpose: ' + spec.purpose + '.',
      'The user does not chat with you directly: your final message is returned to the primary agent, which reports to the user.',
      'Work autonomously and do not ask the user questions. Permission requests for destructive actions are surfaced to the user on the primary thread.',
      'Your final message MUST list every file you created or modified (relative to the project root), including files changed through shell commands   the primary agent is responsible for committing the work and needs this list.',
      '',
      'Instructions from the primary agent:',
      '',
      spec.instructions
    ].join('\\n')
  }

  pi.registerTool({
    name: '${CIO_SPAWN_AGENT_TOOL_NAME}',
    label: 'Spawn a sub-agent',
    description:
      'Spawn a sub-agent worker thread that executes one focused task (explore, implementation, tests, cleanup, documentation, or any custom purpose) and returns only its final result, keeping its transcript out of your context. By default, unless the user explicitly asks you to use sub-agents differently, delegate any task that can run in parallel with your own work to a sub-agent: explore or research a topic while you continue working, hand off long-running work so you can proceed without waiting and without polluting your context, and once your own work is done, spawn a sub-agent to run the checks for the files you touched (lint, typecheck, tests) so the work finishes faster. Run several sub-agents concurrently with background:true; each one automatically steers you a notification with its final output the moment it finishes, so you can keep working and act on results as they land. Omit background to block until the sub-agent finishes and returns its result directly; use that whenever you need the output before proceeding. You must never end your turn while any sub-agent is still running, regardless of outcome; workers report every file they touched because you are responsible for committing approved work. Sub-agents cannot spawn further sub-agents, and they inherit your model and thinking level unless you pass model/thinking_level overrides.',
    promptSnippet: 'Spawn sub-agent worker threads for focused or parallelizable tasks (explore, implement, tests, cleanup, docs)',
    promptGuidelines: CIO_SUBAGENT_PROMPT_GUIDELINES,
    parameters: Type.Object({
      purpose: Type.String({
        description: 'Short task category, e.g. explore, implementation, tests, cleanup, documentation.'
      }),
      instructions: Type.String({
        description: 'The complete, self-contained task instructions for the sub-agent.'
      }),
      model: Type.Optional(
        Type.String({
          description:
            "Model override as 'provider/model-id' or a model id. Defaults to the primary agent's model."
        })
      ),
      thinking_level: Type.Optional(
        Type.Union(CIO_SUBAGENT_THINKING_LEVELS.map(function (level) { return Type.Literal(level) }), {
          description:
            "Thinking-level override. Defaults to the primary agent's thinking level."
        })
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            'Run in the background and return immediately; the finished sub-agent steers you its final output automatically.'
        })
      )
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const spec = {
        purpose: params.purpose,
        instructions: params.instructions,
        model: params.model,
        thinkingLevel: params.thinking_level,
        background: params.background === true
      }
      const result = await runSubAgent(ctx, onUpdate, spec, signal ?? undefined)
      if (result.error) {
        return textResult({ spawned: false, error: result.error })
      }
      if (spec.background) {
        return textResult({
          spawned: true,
          // The same structured payload the progress stream and the done
          // notification carry, so the card shows the delegated task, model and
          // thinking level from the moment the worker is spawned instead of an
          // unlabeled placeholder until it finishes.
          ...subAgentPayload(result.record),
          note: 'Sub-agent is running in the background. When it finishes you will receive a steer message (sub-agent done for task …) carrying its final output   keep working until then; ${CIO_AGENT_STATUS_TOOL_NAME} (wait: true) polls status, and ${CIO_AGENT_OUTPUT_TOOL_NAME} (agent_ids) reads an output again at any time.'
        })
      }
      await result.record.promise
      return textResult(subAgentResult(result.record))
    }
  })

  pi.registerTool({
    name: '${CIO_AGENT_STATUS_TOOL_NAME}',
    label: 'Check sub-agent status',
    description:
      'Check spawned sub-agent worker threads and wait for them. Returns metadata only per agent   agentId, purpose, status, and the error when there is one   never the worker output, so polling cannot flood your context; read output with ${CIO_AGENT_OUTPUT_TOOL_NAME}. Background sub-agents steer you a completion notification with their final output automatically; use this tool to poll explicitly, or wait:true to block until every running sub-agent finishes (with or without a specific agent_id)   always do this before ending your turn so no result is lost.',
    promptSnippet: 'Check or wait for spawned sub-agent threads (metadata only, no output)',
    promptGuidelines: [
      'Background sub-agents announce completion themselves with a steer message; use ${CIO_AGENT_STATUS_TOOL_NAME} to poll status only, with wait:true before finishing the turn, then read the finished workers with ${CIO_AGENT_OUTPUT_TOOL_NAME}.',
      'Never treat a ${CIO_AGENT_STATUS_TOOL_NAME} result as the sub-agent result: it carries no output, so call ${CIO_AGENT_OUTPUT_TOOL_NAME} for the ids you still need.'
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.String({ description: 'A specific sub-agent id. Omit to report all sub-agents.' })
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            'Wait for running sub-agents to finish (success or failure) before returning.'
        })
      )
    }),
    async execute(_toolCallId, params) {
      const wait = params.wait === true
      let records
      if (params.agent_id) {
        const record = subAgents.get(params.agent_id)
        if (!record) {
          return textResult({ found: false, error: 'Unknown sub-agent id: ' + params.agent_id })
        }
        records = [record]
      } else {
        records = [...subAgents.values()]
        if (records.length === 0) {
          return textResult({ agents: [], note: 'No sub-agents have been spawned in this session.' })
        }
      }
      if (wait) {
        const running = records.filter(function (record) { return record.status === 'running' })
        if (running.length > 0) {
          await Promise.all(running.map(function (record) { return record.promise }))
        }
      }
      return textResult({
        agents: records.map(function (record) { return subAgentStatus(record) }),
        note:
          'Status only, no output. Read the final output of the finished agents with ' +
          '${CIO_AGENT_OUTPUT_TOOL_NAME} (agent_ids).'
      })
    }
  })

  pi.registerTool({
    name: '${CIO_AGENT_OUTPUT_TOOL_NAME}',
    label: 'Read sub-agent output',
    description:
      'Read the final output of sub-agent worker threads, keyed by agent id. Pass the ids you actually need (from ${CIO_SPAWN_AGENT_TOOL_NAME} or ${CIO_AGENT_STATUS_TOOL_NAME}); each finished worker returns its final message, and each still-running one is reported back so you can wait and ask again. This is the on-demand output channel   ${CIO_AGENT_STATUS_TOOL_NAME} deliberately returns no output   and a worker final message lists the files it changed, which you are responsible for committing.',
    promptSnippet: 'Read the final output of finished sub-agent threads as agentId -> output pairs',
    promptGuidelines: [
      'After ${CIO_AGENT_STATUS_TOOL_NAME} reports a sub-agent as completed or error, read what it actually produced with ${CIO_AGENT_OUTPUT_TOOL_NAME} (agent_ids) before you continue or commit; never guess a sub-agent result.',
      'Request only the ids you need: one call may carry several ids, and their outputs come back as a key/value map.'
    ],
    parameters: Type.Object({
      agent_ids: Type.Array(Type.String(), {
        description: 'One or more sub-agent ids to read output from.',
        minItems: 1
      }),
      wait: Type.Optional(
        Type.Boolean({
          description:
            'Wait for the requested agents that are still running to finish before returning their output.'
        })
      )
    }),
    async execute(_toolCallId, params) {
      const wait = params.wait === true
      const ids = Array.isArray(params.agent_ids) ? params.agent_ids : []
      const agents = {}
      const errors = {}
      if (ids.length === 0) {
        return textResult({ agents, errors: { agent_ids: 'Provide at least one sub-agent id.' } })
      }
      const pending = []
      for (const id of ids) {
        const record = subAgents.get(id)
        if (!record) {
          errors[id] = 'Unknown sub-agent id: ' + id
          continue
        }
        if (record.status === 'running') {
          pending.push(record)
          continue
        }
        recordSubAgentError(errors, record)
        agents[id] = subAgentOutput(record)
      }
      if (wait && pending.length > 0) {
        await Promise.all(pending.map(function (record) { return record.promise }))
        for (const record of pending) {
          recordSubAgentError(errors, record)
          agents[record.agentId] = subAgentOutput(record)
        }
      } else {
        for (const record of pending) {
          errors[record.agentId] =
            'Still running (' + record.purpose + '). Call ${CIO_AGENT_OUTPUT_TOOL_NAME} again with wait: true, or wait with ${CIO_AGENT_STATUS_TOOL_NAME} (wait: true), then read it.'
        }
      }
      return textResult({
        agents,
        ...(Object.keys(errors).length > 0 ? { errors } : {})
      })
    }
  })

`
}
