/**
 * Generated definitions and handlers for the interactive tools: cio_ask_user, cio_todo_write, cio_request_files, and cio_ask_secret.
 *
 * The returned text is one fragment of the generated core-tools extension
 * source; pi-core-tools-extension.ts concatenates every fragment in order so
 * the emitted module is byte-for-byte identical to the original single string.
 */
import {
  CIO_ASK_SECRET_TOOL_NAME,
  CIO_ASK_USER_TOOL_NAME,
  CIO_REQUEST_FILES_TOOL_NAME,
  CIO_TODO_WRITE_TOOL_NAME
} from '../../../../lib/core-tools'

export function piCoreToolsInteractiveSource(): string {
  return `  pi.registerTool({
    name: '${CIO_ASK_USER_TOOL_NAME}',
    label: 'Ask the user a question',
    description:
      'Ask the user one to three structured questions and wait for their answers. Each question offers two or more described choices plus a custom answer. Use this whenever a decision, preference, or clarification is needed before continuing.',
    promptSnippet: 'Ask structured questions with described choices and wait for answers',
    promptGuidelines: [
      'Use ${CIO_ASK_USER_TOOL_NAME} when a decision, preference, or clarification from the user is needed before continuing.',
      'Ask one to three short questions at a time. Put the recommended option first and add (Recommended) to its label.',
      'Keep option labels short. Put context and tradeoffs in each option description, not in the question text.',
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
              })
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
        { description: 'Questions to ask, in order.', minItems: 1, maxItems: 3 }
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

  pi.registerTool({
    name: '${CIO_TODO_WRITE_TOOL_NAME}',
    label: 'Write the todo list',
    description:
      'Create or update the visible todo list so the user can track progress. Replace the whole list on every call: give every task with its current status (pending, in_progress, or completed). Mark tasks in_progress just before starting and completed immediately after finishing.',
    promptSnippet: 'Publish or update the shared todo list (task tracking)',
    promptGuidelines: [
      'Use ${CIO_TODO_WRITE_TOOL_NAME} as soon as a task spans multiple steps: publish the full plan, keep exactly one task in_progress, and update statuses as work advances.'
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
        { description: 'The full task list (replaces the previous one).', minItems: 1 }
      )
    }),
    async execute(_toolCallId, params) {
      const todos = params.todos.map((todo, index) => ({
        id: todo.id || 'todo-' + (index + 1) + '-' + todo.content,
        content: todo.content,
        status: todo.status
      }))
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
    name: '${CIO_ASK_SECRET_TOOL_NAME}',
    label: 'Request a secret from the user',
    description:
      'Collect one or more secret values (API keys, tokens, passwords) from the user without the value ever entering this conversation. Each value is stored in the encrypted device vault, bound to the utility you name when you pass utility_id, and exposed to this session as an environment variable. Use it right after installing a capability that needs a credential, or whenever a task needs a secret you do not have.',
    promptSnippet: 'Collect secret values from the user without ever seeing them',
    promptGuidelines: [
      'Use ${CIO_ASK_SECRET_TOOL_NAME} whenever you need a secret value (an API key, token, or password) to finish a task; never ask the user to paste a secret into the chat.',
      'Give each secret a short title and, when it helps, a one-line description with a link to where the user obtains the key.',
      'Pass environment_variable when the target expects a specific name (an MCP server variable or a CLI flag); otherwise the tool derives a CIO_ name and reports the exact name to reference.',
      'Pass utility_id to bind the secret to an installed capability as its credential, exactly as the Utilities page stores it.',
      'After the tool reports the secret is set, reference the value only as $ENVIRONMENT_VARIABLE at the target. Never print, echo, log, or read the value, and never paste it into the chat.'
    ],
    parameters: Type.Object({
      secrets: Type.Array(
        Type.Object({
          title: Type.String({ description: 'Short human label, e.g. "Authorization Key".' }),
          description: Type.Optional(
            Type.String({ description: 'One line on what the value is and where to obtain it.' })
          ),
          environment_variable: Type.Optional(
            Type.String({
              description:
                'Environment variable name the target expects. Omit to receive a derived CIO_ name.'
            })
          ),
          utility_id: Type.Optional(
            Type.String({
              description: 'Installed utility id to bind this secret to as its credential.'
            })
          )
        }),
        { description: 'Secrets to collect, in order.', minItems: 1, maxItems: 5 }
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const requests = params.secrets.map((secret, index) => {
        const id = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
        return {
          id,
          index,
          title: secret.title,
          environmentVariable: secretEnvName(secret.environment_variable, secret.title, id),
          ...(typeof secret.description === 'string' && secret.description.trim()
            ? { description: secret.description.trim() }
            : {}),
          ...(typeof secret.utility_id === 'string' && secret.utility_id.trim()
            ? { utilityId: secret.utility_id.trim() }
            : {})
        }
      })
      // The secret card lives in the app. The user pastes each value there, the
      // app stores it in the encrypted vault, and only the resolved environment
      // variable names travel back through this dialog for the model to read.
      const value = await ctx.ui.input(
        secretDialogTitle(requests),
        'Paste the value(s) in the secret card above, then submit.'
      )
      let parsed
      try {
        parsed = typeof value === 'string' && value.trim() ? JSON.parse(value) : null
      } catch {
        parsed = null
      }
      if (!parsed || parsed.status !== 'set' || !Array.isArray(parsed.secrets)) {
        return textResult({
          status: 'dismissed',
          message:
            'The user dismissed the secret request. Continue without it, and ask again only if the secret is essential.'
        })
      }
      const applied = []
      for (const entry of parsed.secrets) {
        if (
          !entry ||
          typeof entry.secretId !== 'string' ||
          typeof entry.environmentVariable !== 'string' ||
          typeof entry.value !== 'string' ||
          !entry.value
        ) {
          continue
        }
        // The value is interpolated into this session's process environment and
        // never into the tool result the model reads.
        process.env[entry.environmentVariable] = entry.value
        const request = requests.find((candidate) => candidate.id === entry.secretId)
        applied.push({
          title: request ? request.title : entry.environmentVariable,
          environment_variable: entry.environmentVariable,
          ...(request && request.utilityId ? { bound_to_utility: request.utilityId } : {})
        })
      }
      if (applied.length === 0) {
        return textResult({
          status: 'dismissed',
          message: 'No secret value was provided. Continue without it.'
        })
      }
      return textResult({
        status: 'set',
        message: 'Secret set, you may proceed.',
        secrets: applied,
        note:
          'Each value is available to your shell as $ENVIRONMENT_VARIABLE and is stored in the encrypted device vault. Reference it only at the target; never print, echo, log, or read it.'
      })
    }
  })

`
}
