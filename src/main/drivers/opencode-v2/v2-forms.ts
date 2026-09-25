import type { AgentQuestion, AgentQuestionOption, AgentQuestionRequest } from '../../../lib/types'
import { arrayValue, recordValue, stringValue } from './v2-values'

/** One choice a V2 form field offers. */
interface FormOption {
  value: string
  label: string
  description?: string
}

/** The field shapes this mapper understands from `Form.Field`. */
type FormField =
  | { kind: 'choice'; key: string; options: FormOption[]; multiple: boolean; custom: boolean }
  | { kind: 'boolean'; key: string }
  | { kind: 'numeric'; key: string; integer: boolean }
  | { kind: 'text'; key: string; custom: boolean }

/** Normalize the `options` array of a V2 form field. */
function formOptions(value: unknown): FormOption[] {
  return arrayValue(value).flatMap((entry) => {
    if (typeof entry === 'string') return [{ value: entry, label: entry }]
    const record = recordValue(entry)
    const optionValue = stringValue(record?.['value'])
    if (!optionValue) return []
    const description = stringValue(record?.['description'])
    return [
      {
        value: optionValue,
        label: stringValue(record?.['label']) ?? optionValue,
        ...(description ? { description } : {})
      }
    ]
  })
}

/** Classify one `Form.Field` by how its answer is collected. */
function classifyField(value: unknown): FormField | null {
  const record = recordValue(value)
  const key = stringValue(record?.['key'])
  const type = stringValue(record?.['type'])
  if (!record || !key || !type) return null
  switch (type) {
    case 'string':
    case 'multiselect':
      return {
        kind: 'choice',
        key,
        options: formOptions(record['options']),
        multiple: type === 'multiselect',
        custom: record['custom'] !== false
      }
    case 'boolean':
      return { kind: 'boolean', key }
    case 'number':
      return { kind: 'numeric', key, integer: false }
    case 'integer':
      return { kind: 'numeric', key, integer: true }
    default:
      // `external` and any future field type fall back to a free-text answer,
      // which is the only thing a client can collect without the provider's
      // own renderer.
      return { kind: 'text', key, custom: true }
  }
}

/** The shared question option for one form choice. */
function toQuestionOption(option: FormOption): AgentQuestionOption {
  const recommended = /\(recommended\)/iu.test(option.label)
  return {
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(recommended ? { recommended: true } : {})
  }
}

/**
 * Map one V2 form field into the shared question model.
 *
 * V2 replaced V1's interactive `question` tool with a general form surface: the
 * tool now creates a form whose `metadata.kind` is `question`. Fields carry a
 * short `title` and the actual question in `description`, which is exactly the
 * header/prompt split the shared model uses.
 */
function mapFormField(field: FormField, record: Record<string, unknown>): AgentQuestion {
  const title = stringValue(record['title'])
  const description = stringValue(record['description'])
  const prompt = description ?? title ?? field.key
  const base: AgentQuestion = {
    prompt,
    ...(title ? { header: title.slice(0, 30) } : {})
  }
  if (field.kind === 'choice') {
    return {
      ...base,
      ...(field.options.length > 0 ? { options: field.options.map((option) => option.label) } : {}),
      ...(field.options.length > 0
        ? { richOptions: field.options.map((option) => toQuestionOption(option)) }
        : {}),
      ...(field.multiple ? { multiple: true } : {}),
      custom: field.custom
    }
  }
  if (field.kind === 'boolean') {
    return { ...base, options: ['Yes', 'No'], custom: false }
  }
  return { ...base, custom: true }
}

/** One question plus the form field it answers, in form order. */
export interface OpenCodeV2QuestionField {
  question: AgentQuestion
  field: FormField
}

/** Parse a `Form.Info` into the questions it asks and the fields behind them. */
export function mapOpenCodeV2FormQuestions(value: unknown): OpenCodeV2QuestionField[] {
  const record = recordValue(value)
  if (!record) return []
  const fields: OpenCodeV2QuestionField[] = []
  for (const raw of arrayValue(record['fields'])) {
    const field = classifyField(raw)
    const fieldRecord = recordValue(raw)
    if (!field || !fieldRecord) continue
    fields.push({ question: mapFormField(field, fieldRecord), field })
  }
  return fields
}

/** The form id a `Form.Info` carries. */
export function openCodeV2FormId(value: unknown): string | undefined {
  return stringValue(recordValue(value)?.['id'])
}

/** The session a `Form.Info` belongs to. */
export function openCodeV2FormSessionId(value: unknown): string | undefined {
  return stringValue(recordValue(value)?.['sessionID'])
}

/**
 * Map a V2 form into a pending question request.
 *
 * Returns `null` for a form with no usable field, so an unrenderable provider
 * form can never become a question card the user cannot answer.
 */
export function mapOpenCodeV2FormToQuestionRequest(value: unknown): AgentQuestionRequest | null {
  const record = recordValue(value)
  const requestId = openCodeV2FormId(value)
  const sessionId = openCodeV2FormSessionId(value)
  if (!record || !requestId || !sessionId) return null
  const fields = mapOpenCodeV2FormQuestions(record)
  if (fields.length === 0) return null
  const metadata = recordValue(record['metadata'])
  const tool = recordValue(metadata?.['tool'])
  const messageID = stringValue(tool?.['messageID'])
  const callID = stringValue(tool?.['id'])
  const title = stringValue(record['title'])
  return {
    requestId,
    sessionId,
    questions: fields.map((entry) => ({ ...entry.question, requestId })),
    ...(messageID || callID ? { tool: { messageID: messageID ?? '', callID: callID ?? '' } } : {}),
    metadata: {
      ...(title ? { title } : {}),
      ...(metadata && stringValue(metadata['kind']) ? { kind: metadata['kind'] } : {})
    }
  }
}

/** Map a `GET /api/session/{id}/form` page into pending question requests. */
export function mapOpenCodeV2PendingForms(payload: unknown): AgentQuestionRequest[] {
  const entries = Array.isArray(payload) ? payload : arrayValue(recordValue(payload)?.['data'])
  return entries
    .map((entry) => mapOpenCodeV2FormToQuestionRequest(entry))
    .filter((request): request is AgentQuestionRequest => request !== null)
}

/**
 * Resolve one answer to the value V2 expects for its field.
 *
 * The renderer answers with option labels (or a typed custom value), while V2
 * expects each option's `value`, which may differ from its label. An answer
 * that matches no option is passed through unchanged so a custom answer still
 * reaches the model.
 */
function resolveAnswer(field: FormField, answer: string): string {
  if (field.kind !== 'choice') return answer
  const match = field.options.find((option) => option.label === answer || option.value === answer)
  return match?.value ?? answer
}

/** One field's answer as V2 mixes it into a form answer payload. */
function answerValue(
  field: FormField,
  answers: readonly string[]
): string | number | boolean | string[] {
  if (field.kind === 'choice') {
    const values = answers.map((answer) => resolveAnswer(field, answer))
    return field.multiple ? values : (values[0] ?? '')
  }
  const first = answers[0] ?? ''
  if (field.kind === 'boolean') return /^(true|yes|y|1)$/iu.test(first.trim())
  if (field.kind === 'numeric') {
    const parsed = Number(first)
    if (!Number.isFinite(parsed)) {
      throw new Error(`Answer for form field "${field.key}" must be a number`)
    }
    return field.integer ? Math.trunc(parsed) : parsed
  }
  return first
}

/**
 * Build the `Form.Reply` body for a form from the renderer's answers.
 *
 * Answers arrive in field order, one string array per question, exactly as the
 * shared question contract delivers them. Any field without an answer is
 * omitted so a partially answered form still submits the rest.
 */
export function buildOpenCodeV2FormReply(
  form: unknown,
  answers: readonly string[][]
): { answer: Record<string, string | number | boolean | string[]> } {
  const fields = mapOpenCodeV2FormQuestions(form)
  const answer: Record<string, string | number | boolean | string[]> = {}
  fields.forEach((entry, index) => {
    const values = answers[index]
    if (!values || values.length === 0) return
    answer[entry.field.key] = answerValue(entry.field, values)
  })
  return { answer }
}
