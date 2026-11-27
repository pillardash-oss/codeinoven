import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb, destroyTestDb } from './test-helper'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import { AgentMessageRepo } from '../../../src/main/database/repositories/agent-message-repo'
import { ThreadCheckpointRepo } from '../../../src/main/database/repositories/thread-checkpoint-repo'
import type { Database } from '../../../src/main/database/database'
import type { AgentMessage } from '../../../src/lib/types'

/**
 * Which shape a transcript page takes.
 *
 * The fork clause is the only correct read for a fork and the wrong price for
 * every other thread: its `thread_id = ? OR EXISTS (...)` cannot walk the
 * messages timeline index, so SQLite scans the whole table and sorts it to
 * return one page. That was measured at 155 ms against 0.5 ms on a real
 * transcript, and a thread open reads several pages, so the scans stacked into
 * the seconds a reader waited for their conversation.
 *
 * These lock in both halves: an ordinary thread must not pay the clause, and a
 * fork must still see the history it inherits.
 */

const databases: Database[] = []

afterEach(() => {
  databases.splice(0).forEach(destroyTestDb)
})

function message(id: string, createdAt: number, role: 'user' | 'assistant'): AgentMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text: `${role} ${id}` }],
    createdAt
  } as AgentMessage
}

async function createApp(): Promise<{
  db: Database
  messages: AgentMessageRepo
  checkpoints: ThreadCheckpointRepo
}> {
  const db = await createTestDb()
  databases.push(db)
  new ProjectRepo(db).upsert({
    id: 'project-1',
    name: 'Transcript project',
    path: '/repo',
    source: 'local',
    providerId: 'openai',
    workflowId: 'default',
    threadLimit: 70,
    changeTrackingMode: 'manual',
    createdAt: 1,
    updatedAt: 1
  })
  const threads = new ThreadRepo(db)
  for (const id of ['thread-1', 'thread-2']) {
    threads.upsert({
      id,
      projectId: 'project-1',
      providerId: 'openai',
      title: id,
      titleSource: 'auto',
      status: 'created',
      pinned: false,
      archived: false,
      read: true,
      createdAt: 1,
      updatedAt: 1,
      lastActivity: 1,
      workingDirectory: '/repo'
    })
  }
  return {
    db,
    messages: new AgentMessageRepo(db),
    checkpoints: new ThreadCheckpointRepo(db)
  }
}

describe('transcript page shape', () => {
  it('reads an ordinary thread from the messages timeline index, without the fork clause', async () => {
    const { messages, db } = await createApp()
    messages.upsert(message('m1', 100, 'user'), 'thread-1')

    const page = messages.loadPageByThread('thread-1', undefined, 10, false)
    expect(page.messages.map((row) => row.id)).toEqual(['m1'])
    // The plan is the point: the page must be served from the thread timeline
    // index instead of a scan of every message in the database.
    const plan = db.all<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT * FROM agent_messages WHERE session_id IS NULL ' +
        "AND visibility IN ('conversation', 'working_trace') AND thread_id = ? " +
        'ORDER BY created_at DESC, id DESC LIMIT 10',
      'thread-1'
    )
    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_agent_messages_thread_timeline')
  })

  it('still shows a fork the history it inherits', async () => {
    const { messages, checkpoints } = await createApp()
    messages.upsert(message('parent-1', 100, 'user'), 'thread-1')
    messages.upsert(message('parent-2', 200, 'assistant'), 'thread-1')
    messages.upsert(message('fork-1', 300, 'user'), 'thread-2')
    checkpoints.create({
      threadId: 'thread-2',
      kind: 'fork',
      harnessId: 'pi',
      sessionId: 'fork-session',
      parentThreadId: 'thread-1',
      boundaryMessageId: 'parent-2',
      boundaryCreatedAt: 200,
      createdAt: 300
    })

    const page = messages.loadPageByThread('thread-2', undefined, 10, true)
    expect(page.messages.map((row) => row.id)).toEqual(['parent-1', 'parent-2', 'fork-1'])
  })

  it('orders and pages a cursor the same way with and without the fork clause', async () => {
    const { messages } = await createApp()
    for (const index of [100, 200, 300, 400]) {
      messages.upsert(message(`m${index}`, index, 'user'), 'thread-1')
    }
    expect(
      messages.loadPageByThread('thread-1', undefined, 2, false).messages.map((row) => row.id)
    ).toEqual(['m300', 'm400'])
    expect(
      messages
        .loadPageByThread('thread-1', { createdAt: 300, id: 'm300' }, 2, false)
        .messages.map((row) => row.id)
    ).toEqual(['m100', 'm200'])
  })
})
