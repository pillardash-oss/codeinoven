import type { AgentMessage, AgentPart } from '$shared/types'
import {
  firstString,
  isTodoToolName,
  normalizeInteractionName,
  parseRecord,
  recordValue
} from '$shared/agent-interactions'

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

/**
 * Resolve the task that should be presented as active.
 *
 * Harnesses do not always publish an `in_progress` transition before starting
 * work. While the turn is live, fall back to the first pending item so the task
 * card still reflects observed agent activity. An explicit provider status
 * always wins.
 */
export function activeAgentTodoIndex(items: AgentTodoItem[], busy: boolean): number {
  const explicitIndex = items.findIndex((item) => item.status === 'in_progress')
  if (explicitIndex >= 0) return explicitIndex
  return busy ? items.findIndex((item) => item.status === 'pending') : -1
}

export function agentTodoProgressLabel(
  itemCount: number,
  completedCount: number,
  activeIndex: number
): string {
  if (activeIndex >= 0) return `Working on ${activeIndex + 1} of ${itemCount}`
  if (completedCount === 0) return `${itemCount} tasks`
  return `${completedCount}/${itemCount} done`
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

  const tasks = new Map<string, AgentTodoItem>()
  for (let index = turnStartIndex; index < messages.length; index++) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    for (const part of message.parts) {
      if (!isTodoToolPart(part)) continue
      applyTodoPart(tasks, part)
    }
  }

  const latestItems = [...tasks.values()]
  if (latestItems.length === 0 || latestItems.every((item) => item.status === 'completed')) {
    return null
  }

  return {
    items: latestItems,
    signature: latestItems.map((item) => `${item.id}:${item.status}:${item.label}`).join('|')
  }
}

function applyTodoPart(tasks: Map<string, AgentTodoItem>, part: ToolPart): void {
  const tool = normalizeInteractionName(part.tool)
  if (tool.endsWith('taskcreate')) {
    applyTaskCreate(tasks, part)
    return
  }
  if (tool.endsWith('taskupdate')) {
    applyTaskUpdate(tasks, part.state.input)
    return
  }
  if (tool.endsWith('tasklist')) {
    const items = part.state.output ? parseTodoItems({}, part.state.output) : []
    if (items.length > 0) replaceTasks(tasks, items)
    return
  }
  const items = parseTodoItems(part.state.input, part.state.output)
  if (items.length > 0) replaceTasks(tasks, items)
}

function applyTaskCreate(tasks: Map<string, AgentTodoItem>, part: ToolPart): void {
  const input = part.state.input
  const result = parseRecord(part.state.output)
  const taskResult = recordValue(result?.['task'])
  const id =
    firstString(taskResult?.['id'], result?.['id'], input['taskId'], input['task_id']) ??
    part.callID
  const label = firstString(
    taskResult?.['subject'],
    input['subject'],
    input['activeForm'],
    input['description']
  )
  if (!label) return
  tasks.delete(part.callID)
  tasks.set(id, { id, label, status: normalizeStatus(input) })
}

function applyTaskUpdate(tasks: Map<string, AgentTodoItem>, input: Record<string, unknown>): void {
  const id = firstString(input['taskId'], input['task_id'], input['id'])
  if (!id) return
  const rawStatus = firstString(input['status'], input['state'])?.toLowerCase()
  if (rawStatus === 'deleted') {
    tasks.delete(id)
    return
  }
  const existing = tasks.get(id)
  const label = firstString(
    input['subject'],
    input['activeForm'],
    input['description'],
    existing?.label
  )
  if (!label) return
  tasks.set(id, {
    id,
    label,
    status: rawStatus ? normalizeStatus(input) : (existing?.status ?? 'pending')
  })
}

function replaceTasks(tasks: Map<string, AgentTodoItem>, items: AgentTodoItem[]): void {
  tasks.clear()
  for (const item of items) tasks.set(item.id, item)
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
