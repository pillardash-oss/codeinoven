import type { AgentMessage, AgentPart } from '$shared/types'
import { isTodoToolName, parseRecord, recordValue, firstString } from '$shared/agent-interactions'

export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed'

export interface AgentTodoItem {
  id: string
  label: string
  status: AgentTodoStatus
}

export interface AgentTodoSnapshot {
  items: AgentTodoItem[]
  signature: string
}

type ToolPart = Extract<AgentPart, { type: 'tool' }>

export function isTodoToolPart(part: AgentPart): part is ToolPart {
  if (part.type !== 'tool') return false
  return isTodoToolName(part.tool)
}

export function latestAgentTodo(messages: AgentMessage[]): AgentTodoSnapshot | null {
  let turnStartIndex = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') {
      turnStartIndex = index + 1
      break
    }
  }

  const hasAssistantMessage = messages
    .slice(turnStartIndex)
    .some((message) => message.role === 'assistant')
  if (!hasAssistantMessage) return null

  let latestItems: AgentTodoItem[] | null = null
  for (let index = turnStartIndex; index < messages.length; index++) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    for (const part of message.parts) {
      if (!isTodoToolPart(part)) continue
      const items = parseTodoItems(part.state.input, part.state.output)
      if (items.length > 0) latestItems = items
    }
  }

  if (!latestItems || latestItems.every((item) => item.status === 'completed')) {
    return null
  }

  return {
    items: latestItems,
    signature: latestItems.map((item) => `${item.id}:${item.status}:${item.label}`).join('|')
  }
}

function parseTodoItems(input: Record<string, unknown>, output?: string): AgentTodoItem[] {
  const source =
    findTodoArray(input) ?? (output ? findTodoArray(parseRecord(output) ?? {}) : undefined)
  if (!source) return []

  return source.flatMap((value, index) => {
    if (typeof value === 'string' && value.trim()) {
      return [
        {
          id: `todo-${index}`,
          label: value.trim(),
          status: 'pending' as const
        }
      ]
    }
    const item = recordValue(value)
    if (!item) return []
    const label = firstString(
      item['content'],
      item['step'],
      item['text'],
      item['title'],
      item['task'],
      item['name'],
      item['label'],
      item['summary'],
      item['description']
    )
    if (!label) return []
    const id = firstString(item['id'], item['key']) ?? `todo-${index}-${label}`
    return [{ id, label, status: normalizeStatus(item) }]
  })
}

function findTodoArray(input: Record<string, unknown>): unknown[] | undefined {
  for (const key of [
    'todos',
    'todo_list',
    'todoList',
    'checklist',
    'plan',
    'plan_update',
    'planUpdate',
    'items',
    'tasks',
    'steps'
  ]) {
    const value = input[key]
    if (Array.isArray(value)) return value
  }
  for (const key of ['input', 'arguments', 'payload', 'data']) {
    const nested = recordValue(input[key])
    if (!nested) continue
    const value = findTodoArray(nested)
    if (value) return value
  }
  return undefined
}

function normalizeStatus(item: Record<string, unknown>): AgentTodoStatus {
  if (
    item['completed'] === true ||
    item['done'] === true ||
    item['cancelled'] === true ||
    item['canceled'] === true
  )
    return 'completed'
  const status = firstString(item['status'], item['state'])
    ?.toLowerCase()
    .replace(/[\s-]+/gu, '_')
  if (
    status === 'completed' ||
    status === 'complete' ||
    status === 'done' ||
    status === 'cancelled' ||
    status === 'canceled'
  ) {
    return 'completed'
  }
  if (
    status === 'in_progress' ||
    status === 'inprogress' ||
    status === 'active' ||
    status === 'running' ||
    status === 'doing'
  ) {
    return 'in_progress'
  }
  return 'pending'
}
