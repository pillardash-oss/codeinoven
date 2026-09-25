/**
 * Generated extension lifecycle hooks and the tool-call permission gate that closes the core-tools extension function.
 *
 * The returned text is one fragment of the generated core-tools extension
 * source; pi-core-tools-extension.ts concatenates every fragment in order so
 * the emitted module is byte-for-byte identical to the original single string.
 */
import { CIO_AGENT_OUTPUT_TOOL_NAME, CIO_AGENT_STATUS_TOOL_NAME } from '../../../../lib/core-tools'

export function piCoreToolsEventsSource(): string {
  return `  // A fresh, resumed, or forked session must not expose sub-agent tools before
  // its first turn: apply the published scope as soon as the session starts.
  pi.on('session_start', async () => {
    applyCioSubAgentScope()
  })

  // Abort every live sub-agent when the owning session shuts down.
  pi.on('session_shutdown', async () => {
    for (const record of subAgents.values()) stopSubAgent(record)
  })

  // Turn-end guard: the primary must never finish its work while sub-agents
  // are still running. When a run settles with live workers, wake the agent
  // with a fresh turn instructing it to collect every result (completed or
  // failed) before finishing. Loop terminates because the wait blocks until
  // the workers resolve.
  pi.on('agent_settled', async () => {
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
    if (running.length === 0) return
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
    applyCioSubAgentScope()
    const extra = loadCioSystemPrompt()
    const isProjectMode = extra.includes(CIO_PROJECT_MODE_MARKER)
    const withIdentity =
      isProjectMode && event.systemPrompt.includes(PI_ASSISTANT_IDENTITY_LINE)
        ? event.systemPrompt.replace(PI_ASSISTANT_IDENTITY_LINE, CIO_AGENT_IDENTITY_LINE)
        : event.systemPrompt
    const base = stripCioSubAgentPrompt(withIdentity)
    if (base === event.systemPrompt && !extra) return undefined
    return { systemPrompt: extra ? base + '\\n\\n' + extra : base }
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
    // File-System-OFF chat threads publish a tool allowlist; any pi built-in
    // the allowlist does not name requires an explicit permission card. The
    // app's policy auto-approves reads of files the user attached and asks
    // for everything else, so attachment access keeps working while the
    // broader file system stays gated.
    if (
      !hit &&
      allowedTools.length > 0 &&
      CIO_PI_BUILTIN_TOOLS.has(event.toolName) &&
      !allowedTools.includes(event.toolName)
    ) {
      if (isSafeNetworkCurl(event.toolName, input)) return undefined
      const command = typeof input['command'] === 'string' ? input['command'] : undefined
      const path = firstString(input['path'], input['file_path'], input['filePath'], input['filename'])
      const payload = {
        permission: command === undefined ? event.toolName : 'shell',
        patterns: command === undefined && path !== undefined ? [path] : [],
        tool: event.toolName,
        ...(command === undefined ? {} : { command })
      }
      const approved = await ctx.ui.confirm(
        'Permission needed: this chat has no file-system access   using ' + event.toolName + ' requires your approval',
        CIO_PERMISSION_MARKER + JSON.stringify(payload)
      )
      if (approved) return undefined
      return {
        block: true,
        reason:
          'The user denied this action: this chat has no file-system access, so ' +
          event.toolName +
          ' is not available. Do not retry it as-is; work from the files the user attached, or ask the user to enable File System for this chat.'
      }
    }
    if (!hit) return undefined
    const payload = {
      permission: hit.permission,
      patterns: hit.patterns,
      tool: event.toolName,
      ...(hit.command === undefined ? {} : { command: hit.command })
    }
    const approved = await ctx.ui.confirm(
      'Permission needed: ' + hit.reason,
      CIO_PERMISSION_MARKER + JSON.stringify(payload)
    )
    if (approved) return undefined
    return {
      block: true,
      reason:
        'The user denied this action in the permission card because it is destructive (' +
        hit.reason +
        '). Do not retry it as-is; continue the turn with a safe alternative.'
    }
  })
}
`
}
