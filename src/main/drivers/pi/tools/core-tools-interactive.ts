/**
 * Generated definitions and handlers for the interactive tools: cio_ask_user, cio_todo_write, and cio_request_files.
 *
 * The returned text is one fragment of the generated core-tools extension
 * source; pi-core-tools-extension.ts concatenates every fragment in order so
 * the emitted module is byte-for-byte identical to the original single string.
 *
 * `questionCap` is the app-configured maximum number of questions one
 * cio_ask_user call may carry (General settings, Threads section).
 */
import {
  CIO_ASK_USER_TOOL_NAME,
  CIO_REQUEST_FILES_TOOL_NAME,
  CIO_SENSITIVE_ACCESS_REASON_TOOL_NAME,
  CIO_TODO_WRITE_TOOL_NAME
} from '../../../../lib/core-tools'

export function piCoreToolsInteractiveSource(questionCap: number): string {
  return `  pi.registerTool({
    name: '${CIO_ASK_USER_TOOL_NAME}',
    label: 'Ask the user a question',
    description:
      'Ask the user one to ${questionCap} structured questions and wait for their answers. Each question offers two or more described choices plus a custom answer. Use this whenever a decision, preference, or clarification is needed before continuing.',
    promptSnippet: 'Ask structured questions with described choices and wait for answers',
    promptGuidelines: [
      'Use ${CIO_ASK_USER_TOOL_NAME} when a decision, preference, or clarification from the user is needed before continuing.',
      'Ask one to ${questionCap} short questions at a time. Put the recommended option first and add (Recommended) to its label.',
      'Keep option labels short. Put context and tradeoffs in each option description, not in the question text.',
      'When an option asks the user to run or paste something to produce the answer, put that exact text in the instruction field of the option instead of the description, so the user can copy it from the answer card without transcribing it. Never place a command, script, or multi-step procedure in the description.',
      'Custom answers are always available; do not add an Other option.'
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: 'The question text.' }),
          header: Type.String({
            description: 'Short header label (24 or fewer characters).',
            maxLength: 24
          }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: 'Short option label (1-5 words).' }),
              description: Type.String({
                description: 'One short sentence explaining the impact or tradeoff.'
              }),
              instruction: Type.Optional(
                Type.String({
                  description:
                    'Exact text the user must run or paste to produce this answer (a command, a script, or a short ordered procedure). Rendered in a copyable modal; do not duplicate it in the description.'
                })
              )
            }),
            {
              description: 'Two or more choices.',
              minItems: 2
            }
          ),
          multiple: Type.Optional(
            Type.Boolean({ description: 'Allow more than one option to be selected.' })
          )
        }),
        { description: 'Questions to ask, in order.', minItems: 1, maxItems: ${questionCap} }
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const title = questionDialogTitle(params.questions)
      const value =
        params.questions.length === 1
          ? await ctx.ui.select(
              title,
              params.questions[0].options.map((option) => option.label)
            )
          : await ctx.ui.input(
              title,
              'Answer the questions in the card above, then submit.'
            )
      const answers = []
      let parsed
      try {
        parsed = value === undefined ? null : (JSON.parse(value) as unknown)
      } catch {
        parsed = null
      }
      if (!Array.isArray(parsed)) {
        params.questions.forEach((question) => {
          answers.push({ question: question.question, dismissed: true, answer: [] })
        })
        return textResult({ answers })
      }
      params.questions.forEach((question, index) => {
        const entry = parsed[index]
        if (!Array.isArray(entry)) {
          answers.push({ question: question.question, dismissed: true, answer: [] })
          return
        }
        answers.push({
          question: question.question,
          dismissed: false,
          answer: entry.filter((part) => typeof part === 'string')
        })
      })
      return textResult({ answers })
    }
  })

  // Latest list the agent published through cio_todo_write, plus the work the
  // app has watched since it was published. Two guards in the events fragment
  // read them: the mid-run check-in, which keeps the card moving while a long
  // run is still going, and the turn-end reconcile, which catches the common
  // failure where the agent finishes its work but never marks the tasks
  // complete. The list is cleared on every settle and on every new user prompt,
  // so a turn that never publishes one is never judged against an older turn's.
  let latestTodoItems = []
  // Work steps (edits, writes, commands, scripts) taken since that publish; the
  // check-in spends it and resets it.
  let todoWorkSteps = 0
  // Set while a reconciliation nudge is outstanding, so one stale list is never
  // nudged twice; it clears when the published list is truthful again.
  let todoReconcileSpent = false

  pi.registerTool({
    name: '${CIO_TODO_WRITE_TOOL_NAME}',
    label: 'Write the todo list',
    description:
      'Create or update the visible todo list so the user can track progress. Replace the whole list on every call: give every task with its current status (pending, in_progress, or completed), or an empty list to clear the tasks. Update it as you go: mark a task in_progress just before you start it and completed in the same step you finish it, one call per transition instead of one batch at the end. The task card is the only place the user sees progress, so a list that stops moving while you keep working reads as a stalled run.',
    promptSnippet: 'Publish or update the shared todo list (task tracking)',
    promptGuidelines: [
      'Use ${CIO_TODO_WRITE_TOOL_NAME} as soon as a task spans multiple steps: publish the full plan, keep exactly one task in_progress, and update statuses as work advances.',
      'Update the list as you go, not at the end: a task is marked completed in the same step its work is finished, so the card moves while you work instead of jumping when you stop.',
      'Before you end a turn, publish the final list: mark every task you completed as completed, and publish an empty list (or a shorter one) to drop tasks you no longer intend to do, so the visible list matches what you actually finished.'
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String({ description: 'Stable task id; omit to derive from content.' })),
          content: Type.String({ description: 'The task label.' }),
          status: Type.Union([
            Type.Literal('pending'),
            Type.Literal('in_progress'),
            Type.Literal('completed')
          ])
        }),
        {
          description: 'The full task list (replaces the previous one). Empty clears it.',
          minItems: 0
        }
      )
    }),
    async execute(_toolCallId, params) {
      const todos = params.todos.map((todo, index) => ({
        id: todo.id || 'todo-' + (index + 1) + '-' + todo.content,
        content: todo.content,
        status: todo.status
      }))
      latestTodoItems = todos
      todoWorkSteps = 0
      const active = todos.find((todo) => todo.status === 'in_progress')
      return textResult({
        todos,
        summary: active ? 'Working on: ' + active.content : 'No task marked in_progress.'
      })
    }
  })

  pi.registerTool({
    name: '${CIO_REQUEST_FILES_TOOL_NAME}',
    label: 'Request files from the user',
    description:
      'Ask the user to share files by typing their paths. The paths are validated against the filesystem and returned so you can read them. Use this when the work needs files that are not yet in the conversation.',
    promptSnippet: 'Ask the user to share file paths and receive a validated file list',
    promptGuidelines: [
      'Use ${CIO_REQUEST_FILES_TOOL_NAME} when the task needs files the user has not shared yet; pass a clear message about which files and formats help.'
    ],
    parameters: Type.Object({
      message: Type.Optional(
        Type.String({ description: 'Why the files are needed and what formats help.' })
      ),
      suggested_paths: Type.Optional(
        Type.Array(Type.String(), { description: 'Likely paths to suggest in the prompt.' })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const detail = params.message ? params.message : 'Share the files the agent needs.'
      const suggested = Array.isArray(params.suggested_paths)
        ? params.suggested_paths.filter((path) => typeof path === 'string' && path.trim())
        : []
      // Structured question envelope so the app renders a real file-share
      // card: the agent's message as the prompt, suggested paths as
      // selectable options, plus custom text and file attachment entry points.
      const question = {
        question: detail,
        header: 'Share files',
        fileRequest: true,
        multiple: true,
        options: suggested.map((suggestedPath) => ({
          label: suggestedPath,
          description: 'Suggested file'
        }))
      }
      const value = await ctx.ui.select(
        questionDialogTitle([question]),
        question.options.map((option) => option.label)
      )
      let requested = []
      if (typeof value === 'string' && value.trim()) {
        let parsed
        try {
          parsed = JSON.parse(value)
        } catch {
          parsed = null
        }
        if (Array.isArray(parsed)) {
          requested = parsed
            .flat()
            .map((entry) => String(entry).trim())
            .filter(Boolean)
        }
      }
      if (requested.length === 0) {
        return textResult({ requested: false, message: 'The user dismissed the file request.' })
      }
      const files = requested.map((path) => {
        const absolutePath = isAbsolute(path) ? resolve(path) : resolve(ctx.cwd, path)
        return {
          path,
          absolutePath,
          exists: existsSync(absolutePath),
          insideProject: !isOutsideCwd(absolutePath, ctx.cwd)
        }
      })
      return textResult({
        requested: true,
        files,
        note: files.every((file) => !file.exists)
          ? 'None of the given paths exist; ask the user to double-check them.'
          : 'Read the existing files before continuing.'
      })
    }
  })

  pi.registerTool({
    name: '${CIO_SENSITIVE_ACCESS_REASON_TOOL_NAME}',
    label: 'Explain protected file access',
    description:
      'State why this run needs a file from the sensitive-file block list. Call it only after a tool call was blocked for a protected file: the app shows this reason in the approval card the user answers.',
    promptSnippet: 'Explain why the run needs a protected file before the user is asked',
    promptGuidelines: [
      'Use ${CIO_SENSITIVE_ACCESS_REASON_TOOL_NAME} only when a tool call was blocked for a protected file, and pass the exact paths the block named.',
      'Write one or two sentences the user can judge: what the file gives the run and why the work fails without it. Never claim a secret value is needed when only a name or a key list is.'
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: 'A blocked path, exactly as the block named it.' }), {
        description: 'The protected paths the block named.',
        minItems: 1,
        maxItems: 16
      }),
      reason: Type.String({
        description: 'Why this run needs those files, in one or two sentences.',
        maxLength: 600
      })
    }),
    async execute(_toolCallId, params) {
      const result = recordSensitiveAccessReason(params.paths, params.reason)
      if (result.recorded.length === 0) {
        return textResult({
          recorded: false,
          message:
            'No blocked path matched. Retry the tool call first, then explain the paths the block named.',
          ignored: result.ignored
        })
      }
      return textResult({
        recorded: true,
        paths: result.recorded,
        message: 'Reason recorded. Retry the blocked call now; the approval card shows this reason.'
      })
    }
  })

`
}
