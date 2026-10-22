/**
 * Generated extension lifecycle hooks and the tool-call permission gate that closes the core-tools extension function.
 *
 * The returned text is one fragment of the generated core-tools extension
 * source; pi-core-tools-extension.ts concatenates every fragment in order so
 * the emitted module is byte-for-byte identical to the original single string.
 */
import {
  CIO_AGENT_OUTPUT_TOOL_NAME,
  CIO_AGENT_STATUS_TOOL_NAME,
  CIO_TODO_WRITE_TOOL_NAME
} from '../../../../lib/core-tools'

export function piCoreToolsEventsSource(): string {
  return `  // A fresh, resumed, or forked session must not expose sub-agent tools before
  // its first turn: apply the published scope as soon as the session starts.
  pi.on('session_start', async () => {
    applyCioWindowsShells()
    applyCioSubAgentScope()
  })

  // Abort every live sub-agent when the owning session shuts down.
  pi.on('session_shutdown', async () => {
    for (const record of subAgents.values()) stopSubAgent(record)
  })

  // How many work steps   edits, writes, commands, scripts   may pass without a
  // task-list update before the app reminds the agent mid-run. Reads and
  // searches are not progress the user can see, so only work that changes
  // something counts.
  const CIO_TODO_CHECKIN_STEPS = 10
  const CIO_TODO_WORK_TOOLS = new Set(['edit', 'write', 'bash', 'powershell', 'cmd', 'codemode'])

  pi.on('tool_execution_end', (event) => {
    if (!event || event.isError) return
    // A codemode script's inner calls are already covered by the script itself.
    if (event.parentToolCallId) return
    if (CIO_TODO_WORK_TOOLS.has(event.toolName)) todoWorkSteps += 1
  })

  /** Labels of the tasks the list the agent last published still shows unfinished. */
  function unfinishedCioTodos() {
    const unfinished = []
    for (const item of latestTodoItems) {
      if (item.status !== 'completed') unfinished.push(item.content)
    }
    return unfinished
  }

  function hasRunningCioSubAgents() {
    for (const record of subAgents.values()) {
      if (record.status === 'running') return true
    }
    return false
  }

  /**
   * The reconcile instruction, shared by the boundary guard and the settle
   * fallback.
   *
   * It never claims the card is showing this particular list. A steer moves the
   * turn boundary, so the card drops the list it was showing and the guard's
   * remembered list is one the user can no longer see; saying "the app shows
   * that list" would be false exactly when the guard is asking for the list the
   * steer replaced. Naming the list that was last published holds in both cases
   * and still gets the run to end on a truthful card.
   */
  function cioTodoReconcilePrompt(unfinished) {
    return (
      'Your turn is ending, but the task list you last published still shows unfinished work: ' +
      unfinished.join('; ') +
      '. The task card is how the user follows the run, and a run that ends on that list reads as abandoned work. Publish the final list before you finish: call ' +
      '${CIO_TODO_WRITE_TOOL_NAME} once more with the list as it really stands, marking every task you completed as completed and dropping the tasks you no longer intend to do (an empty list clears them). ' +
      'When the work is truly complete and only the list lagged, make that one ${CIO_TODO_WRITE_TOOL_NAME} call and nothing else: add no prose and no other tool call. The app keeps the final answer you already gave the user and shows it, so any words you add here would only replace that answer with a redundant second version of it. Write text only if something material truly changed since that answer, and never mark a task complete that you did not actually finish. Only end your turn once the list matches what you actually did.'
    )
  }

  /**
   * The mid-run task-list check-in, or an empty string when there is nothing to
   * say. A list published at the start of a long run and never updated leaves
   * the app's task card frozen on the first task while the agent works through
   * all of it, which reads as a stalled run. Once a batch of work steps has
   * passed without an update, the next model request carries this reminder, and
   * the counter resets so the next one waits for another batch instead of
   * nagging on every step. It says "the list you published", not "the list on
   * screen": a steer clears the card, and this reminder is also what brings it
   * back mid-run by getting the agent to publish the list again. The reminder is
   * request-local: the context handler hands it to one provider request and Pi
   * restores the conversation after, so it is never persisted, summarized, or
   * rendered as a message of its own.
   */
  function buildCioTodoCheckin() {
    const steps = todoWorkSteps
    if (steps < CIO_TODO_CHECKIN_STEPS) return ''
    todoWorkSteps = 0
    const unfinished = unfinishedCioTodos()
    if (unfinished.length === 0) return ''
    return (
      'Automatic task-list check-in from CodeInOven, not a message from the user and not a request to stop working: ' +
      steps +
      ' steps of work have passed since your last ' +
      '${CIO_TODO_WRITE_TOOL_NAME} call, and the list you published then still shows these tasks unfinished: ' +
      unfinished.join('; ') +
      '. Call ${CIO_TODO_WRITE_TOOL_NAME} now with the true status of every task, then carry on with the work exactly as you were.'
    )
  }

  // Task-list guard (boundary): agent_before_settle is the last actionable
  // boundary, so a run about to end with an unfinished list is stopped for one
  // more request that publishes the list matching what the agent actually did;
  // the app then finalizes a turn whose card is truthful instead of one frozen
  // mid-run. One nudge per stale list: the budget is spent here, released when
  // the list becomes truthful again, and reset by the next user prompt. An
  // aborted turn, a stopped session, and a run still waiting on sub-agents are
  // never continued from here.
  pi.on('agent_before_settle', (event) => {
    if (!event || event.outcome !== 'completed') return undefined
    if (applyStopRequest()) return undefined
    if (hasRunningCioSubAgents()) return undefined
    if (event.context && event.context.canContinue === false) return undefined
    const unfinished = unfinishedCioTodos()
    if (unfinished.length === 0) {
      todoReconcileSpent = false
      return undefined
    }
    if (todoReconcileSpent) return undefined
    todoReconcileSpent = true
    return {
      entries: [
        {
          type: 'custom_message',
          customType: 'cio-todo-reconcile',
          content: cioTodoReconcilePrompt(unfinished),
          display: false
        }
      ],
      continue: true
    }
  })

  // Turn-end guard: the primary must never finish its work while sub-agents
  // are still running. When a run settles with live workers, wake the agent
  // with a fresh turn instructing it to collect every result (completed or
  // failed) before finishing. Loop terminates because the wait blocks until
  // the workers resolve.
  pi.on('agent_settled', async (event) => {
    // A settled run the app just stopped must not wake the primary: the stop
    // request aborted every worker, and the guard below would otherwise start a
    // fresh turn defending work the user cancelled. The suppression stays until
    // the next agent start, which is a new turn by definition.
    if (applyStopRequest()) return
    const running = []
    for (const record of subAgents.values()) {
      if (record.status === 'running') {
        running.push(record.purpose + ' (' + record.agentId + ')')
      }
    }
    // Capture the published list's unfinished tasks before clearing it: the
    // list only describes the run that just settled, and a later turn that
    // never publishes one must not be judged against it.
    const unfinishedTodos = unfinishedCioTodos()
    latestTodoItems = []
    if (running.length > 0) {
      if (!pi || typeof pi.sendMessage !== 'function') return
      try {
        void pi.sendMessage(
          {
            customType: 'cio-subagent-wait',
            content:
              'Your turn ended while sub-agents are still running: ' +
              running.join(', ') +
              '. Do not finish your work yet. Call ${CIO_AGENT_STATUS_TOOL_NAME} with wait:true (or omit agent_id to cover them all) to let them finish, read each finished worker with ${CIO_AGENT_OUTPUT_TOOL_NAME} (agent_ids), and incorporate every result   successful or failed   before ending your turn. Sub-agents report the files they changed; you are responsible for committing approved work.',
            display: false
          },
          { triggerTurn: true }
        )
      } catch {}
      return
    }
    // Task-list guard (fallback): a runtime whose settle boundary could not
    // continue, or one that reports no boundary at all, must still not leave the
    // app's card frozen on an unfinished list. Wake the agent with one fresh turn
    // to publish the final list. The budget is shared with the boundary guard
    // above, so a run that guard already nudged is never nudged twice, and an
    // aborted run is never defended with a fresh turn.
    if (event && event.aborted) return
    if (unfinishedTodos.length === 0) {
      todoReconcileSpent = false
      return
    }
    if (todoReconcileSpent) return
    if (!pi || typeof pi.sendMessage !== 'function') return
    todoReconcileSpent = true
    try {
      void pi.sendMessage(
        {
          customType: 'cio-todo-reconcile',
          content: cioTodoReconcilePrompt(unfinishedTodos),
          display: false
        },
        { triggerTurn: true }
      )
    } catch {}
  })

  // A new agent start is a new turn, never a continuation of a stop the user
  // requested earlier: the driver clears the stop-flag token before prompting.
  pi.on('agent_start', async () => {
    stopApplied = false
  })

  // Deliver the CodeInOven-composed instructions as a real system-role field
  // instead of duplicating them inside every user turn's text (see
  // loadCioSystemPrompt above for why).
  pi.on('before_agent_start', (event) => {
    // A genuine user prompt begins a fresh task-list budget: the previous
    // turn's list is gone from the screen, and a reconciliation nudge may be
    // spent again. Pi 1.2 also fires this hook for custom-message runs; those
    // must preserve the guard's budget and current task list.
    if (event.messageType === 'user') {
      latestTodoItems = []
      todoReconcileSpent = false
    }
    // Pi reports each surface's annotations here, and an MCP server can connect
    // between turns, so the read-only set is refreshed before every turn.
    refreshCioReadOnlyTools(pi)
    applyCioWindowsShells()
    applyCioSubAgentScope()
    const activeWindowsShells = windowsShellTools.filter((tool) => pi.getActiveTools().includes(tool.name))
    const windowsGuidance = activeWindowsShells.length === 0 ? '' :
      'Windows command execution: native tools available here: ' + activeWindowsShells.map((tool) => tool.name).join(', ') +
      '. Use PowerShell syntax with powershell and CMD.exe syntax with cmd. Git Bash is optional. If bash is unavailable, continue with an available native tool. Inspect files directly with read, ls, find and grep; do not ask the user to paste project source because bash is missing.'
    const extra = [loadCioSystemPrompt(), windowsGuidance].filter(Boolean).join('\\n\\n')
    const isProjectMode = extra.includes(CIO_PROJECT_MODE_MARKER)
    const withIdentity =
      isProjectMode && event.systemPrompt.includes(PI_ASSISTANT_IDENTITY_LINE)
        ? event.systemPrompt.replace(PI_ASSISTANT_IDENTITY_LINE, CIO_AGENT_IDENTITY_LINE)
        : event.systemPrompt
    const base = stripCioSubAgentPrompt(withIdentity)
    if (base === event.systemPrompt && !extra) return undefined
    return { systemPrompt: extra ? base + '\\n\\n' + extra : base }
  })

  // Rebuilt sessions (fork, account or harness switch, edited or deleted
  // history, lost session) have no native transcript. The driver publishes the
  // restored replay each turn; deliver it as its own leading user message so it
  // lands in the user channel   the replay mixes the user's words, tool output,
  // and file content, and the system role would grant it system authority.
  // Request-local: Pi restores the conversation afterward, so the replay is
  // never persisted or summarized, and the next recap cannot nest inside one.
  pi.on('context', (event) => {
    const recap = loadCioHistoryRecap()
    const messages = recap
      ? [{ role: 'user', content: recap, timestamp: Date.now() }, ...event.messages]
      : event.messages
    // The mid-run task-list check-in rides the same request-local channel: the
    // agent sees it on this provider request only, and it is the last thing on
    // the wire so a stale list is answered before the agent plans its next step.
    const checkin = buildCioTodoCheckin()
    if (!checkin) return recap ? { messages } : undefined
    return {
      messages: [...messages, { role: 'user', content: checkin, timestamp: Date.now() }]
    }
  })

  // Permission gate: destructive tool calls require an explicit permission
  // card. The confirm dialog's message carries the structured payload behind
  // the shared marker; the CodeInOven driver upgrades it into a real
  // permission request. In full-access mode the app auto-approves, so gating
  // stays transparent there.
  pi.on('tool_call', async (event, ctx) => {
    const input = recordValue(event.input) ?? {}
    const contaminated = findContaminatedToolArg(input)
    if (contaminated) {
      return {
        block: true,
        reason:
          'This tool call was not executed: its "' +
          contaminated.key +
          '" argument contains "' +
          contaminated.marker +
          '", meaning the previous response stream did not terminate the tool call cleanly and leaked raw text (reasoning, or a second tool-call attempt) into the argument. This is a streaming artifact, not a real command or file content, and not evidence of prompt injection or a fabricated transcript. Re-issue this tool call now with a single, clean argument containing only the intended command/content, and continue normally.'
      }
    }
    const allowedTools = loadCioAllowedTools()
    // A script (Pi 0.99 codemode) runs other tools through this same pipeline.
    // App-owned tools are deliberately reachable from scripts: stringing many
    // bridge calls into one script is the reason codemode exists, and a script
    // reaching a user-facing tool makes the same call the model makes directly,
    // on the same gate. Pi excludes codemode itself from its own script table,
    // so a script can never recurse into codemode.
    // Backstop for the window between a scope change and the next agent start:
    // a scoped session must never run a sub-agent tool, even when the model
    // still saw it in an earlier request.
    if (
      allowedTools.length > 0 &&
      CIO_SUBAGENT_TOOL_NAMES.has(event.toolName) &&
      !allowedTools.includes(event.toolName)
    ) {
      return {
        block: true,
        reason:
          'Sub-agent tools are not available in this session: it runs with a restricted tool scope, and a session with a restricted scope does every step itself. Perform this step directly with the tools you have.'
      }
    }
    const hit = evaluateGate(event.toolName, input, ctx.cwd)
    // Shared and Pi-native skill roots are harness runtime, not user file
    // access: a skill read resolves before every gate below, so no session mode
    // opens a permission card for it. Without this, a read-only temporary chat
    // (whose allowlist already names read/find/grep/ls) falls through to the
    // outside-the-project gate and blocks on a card just to load a skill.
    if (isIntrinsicSkillRead(event.toolName, input, ctx.cwd)) return undefined
    // Chat exposes local tools for its own workspace. Route every local call
    // through the app policy even when listed, so external paths stay gated.
    // Other restricted sessions retain their ordinary tool allowlist.
    if (
      !hit &&
      allowedTools.length > 0 &&
      !isCioOwnToolName(event.toolName) &&
      (!allowedTools.includes(event.toolName) ||
        (allowedTools.includes('webfetch') &&
          allowedTools.includes('write') &&
          ['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash', 'powershell', 'cmd'].includes(event.toolName)))
    ) {
      if (isSafeNetworkCurl(event.toolName, input)) return undefined
      const command = typeof input['command'] === 'string' ? input['command'] : undefined
      const path = firstString(input['path'], input['file_path'], input['filePath'], input['filename']) ?? ctx.cwd
      const payload = {
        permission: command === undefined ? event.toolName : 'shell',
        patterns: command === undefined && path !== undefined ? [path] : [],
        tool: event.toolName,
        ...(command === undefined ? {} : { command }),
        ...(CIO_PI_BUILTIN_TOOLS.has(event.toolName) ? {} : { surface: event.toolName })
      }
      const approved = await ctx.ui.confirm(
        'Permission check: ' + event.toolName + ' must stay inside this chat workspace or use an authorized external path',
        CIO_PERMISSION_MARKER + JSON.stringify(payload)
      )
      if (approved) return undefined
      return {
        block: true,
        reason:
          'This action was denied by the chat file-access policy. Keep work inside this chat workspace and use only authorized external inputs. Do not retry the denied action unchanged.'
      }
    }
    if (!hit) return undefined
    const payload = {
      permission: hit.permission,
      patterns: hit.patterns,
      tool: event.toolName,
      ...(hit.command === undefined ? {} : { command: hit.command }),
      ...(hit.surface === undefined ? {} : { surface: hit.surface })
    }
    const approved = await ctx.ui.confirm(
      'Permission needed: ' + hit.reason,
      CIO_PERMISSION_MARKER + JSON.stringify(payload)
    )
    if (approved) return undefined
    return {
      block: true,
      reason:
        'The user denied this action (' +
        hit.reason +
        '). Do not retry it as-is; continue the turn with a safe alternative.'
    }
  })
}
`
}
