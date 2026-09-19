import type { AgentQuestion, AgentQuestionRequest } from '../../../lib/types'
import { recordFromUnknown, recordValue, stringValue } from './opencode-values'

/** Extract the question text from the tool input, tolerating several field names. */
export function extractQuestionPrompt(input: Record<string, unknown>, title?: string): string {
  return (
    stringValue(input['prompt']) ||
    stringValue(input['question']) ||
    stringValue(input['text']) ||
    stringValue(input['message']) ||
    stringValue(input['content']) ||
    title ||
    ''
  )
}

/** Extract options from either `options` or `richOptions`. */
export function extractQuestionOptions(input: Record<string, unknown>): {
  options: string[]
  richOptions: { label: string; description?: string }[]
} {
  const rawOptions = Array.isArray(input['options']) ? input['options'] : []
  const rawRichOptions = Array.isArray(input['richOptions']) ? input['richOptions'] : []
  const allOptions = [...rawOptions, ...rawRichOptions]

  const options = allOptions
    .map((o: unknown) =>
      typeof o === 'string' ? o : (stringValue((o as Record<string, unknown>)['label']) ?? '')
    )
    .filter(Boolean)

  const richOptions = allOptions
    .map((o: unknown) => {
      if (typeof o === 'string') return null
      const opt = o as Record<string, unknown>
      const label = stringValue(opt['label'])
      return label
        ? {
            label,
            description: stringValue(opt['description']),
            ...(opt['recommended'] === true || /\(recommended\)/iu.test(label)
              ? { recommended: true }
              : {})
          }
        : null
    })
    .filter((o): o is NonNullable<typeof o> => o !== null)

  return { options, richOptions }
}

/** Normalize one provider question while preserving its position in a batch. */
export function mapOpenCodeQuestion(raw: unknown): AgentQuestion | null {
  const input = recordValue(raw)
  if (!input) return null
  const { options, richOptions } = extractQuestionOptions(input)
  const prompt = extractQuestionPrompt(input)
  if (!prompt.trim()) return null
  return {
    prompt,
    header: stringValue(input['header']),
    description: stringValue(input['description']),
    options: options.length > 0 ? options : undefined,
    richOptions: richOptions.length > 0 ? richOptions : undefined,
    multiple: input['multiple'] === true,
    custom: input['custom'] !== false
  }
}

/** Normalize the current ordered `questions` array. */
export function mapOpenCodeQuestions(input: Record<string, unknown>): AgentQuestion[] {
  const values = Array.isArray(input['questions']) ? input['questions'] : []
  return values
    .map((value) => mapOpenCodeQuestion(value))
    .filter((value): value is AgentQuestion => value !== null)
}

export function mapOpenCodeQuestionRequest(raw: unknown): AgentQuestionRequest | null {
  const request = recordValue(raw)
  if (!request) return null
  const requestId = stringValue(request['id']) ?? stringValue(request['requestID']) ?? ''
  const sessionId = stringValue(request['sessionID']) ?? ''
  const questions = mapOpenCodeQuestions(request)
  if (!requestId || !sessionId || questions.length === 0) return null
  const tool = recordValue(request['tool'])
  return {
    requestId,
    sessionId,
    questions,
    tool: tool
      ? {
          messageID: stringValue(tool['messageID']) ?? '',
          callID: stringValue(tool['callID']) ?? ''
        }
      : undefined
  }
}

/** Extract the user's answer from the tool output. */
export function extractQuestionAnswer(output: unknown): string | undefined {
  const outputRecord = recordFromUnknown(output)
  if (outputRecord) {
    return (
      stringValue(outputRecord['answer']) ||
      stringValue(outputRecord['result']) ||
      stringValue(outputRecord['value'])
    )
  }
  return stringValue(output)
}
