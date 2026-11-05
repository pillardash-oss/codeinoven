import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadSearchService } from '../../src/lib/engines/thread-manager-search'
import { AgentMessageRepo } from '../../src/main/database/repositories/agent-message-repo'
import { ThreadRepo } from '../../src/main/database/repositories/thread-repo'
import type { Database } from '../../src/main/database/database'
import { createTestDb, destroyTestDb } from './database/test-helper'

/**
 * A question an agent asks is a sentence, not a search box.
 *
 * The thread an agent needed was in the database the whole time, but its query
 * carried twelve words and the keyword pass required every one of them in a
 * single excerpt, so the search answered "no threads found" and the turn gave up
 * on its own history. These tests keep that answer honest: a sentence finds the
 * conversation that answers it, and a passage that carries none of the concepts
 * is still rejected.
 */

const PROJECT_ID = 'p-evidence'
const ANSWER_THREAD_ID = 'thread-answer'
const UNRELATED_THREAD_ID = 'thread-unrelated'

const ENV_ANSWER = [
  'Categorized environment variables, grouped in a usable format, required values first in each block.',
  'Public domains and app URLs: PUBLIC_USERS_URL, PUBLIC_SITE_URL, PUBLIC_ADMIN_URL.',
  'PostgreSQL: POSTGRES_PASSWORD is required and compose refuses to start without it.',
  'API secrets and auth: JWT_SECRET, JITSI_APP_SECRET, JICOFO_AUTH_PASSWORD.',
  'Classroom video (Jitsi): MEET_DOMAIN, MEET_PUBLIC_URL, JVB_ADVERTISE_IPS.',
  'Runtime defaults: TZ defaults to Africa/Lagos, COOKIE_SECURE defaults to true.',
  'The classroom sections repeat what compose already defaults, so most of them can be dropped.'
].join('\n')
const QUESTION =
  'Categorize environment variables into a usable grouped format classroom sections defaults env variables'

function seed(db: Database): void {
  db.run(
    `INSERT OR IGNORE INTO projects(id, name, path, source, provider_id, workflow_id, thread_limit, change_tracking_mode, created_at, updated_at)
     VALUES(?, 'Evidence', '/p', 'local', 'openai', 'default', 70, 'manual', 1, 1)`,
    PROJECT_ID
  )
  for (const [id, title] of [
    [ANSWER_THREAD_ID, 'Environment variables grouped'],
    [UNRELATED_THREAD_ID, 'Deployment pipeline']
  ] as const) {
    db.run(
      `INSERT INTO threads(id, project_id, provider_id, title, status, pinned, archived, read, scope_bucket_id, created_at, updated_at, last_activity)
       VALUES(?, ?, '', ?, 'created', 0, 0, 1, 'default', 1, 1, 1)`,
      id,
      PROJECT_ID,
      title
    )
  }
  const messages = new AgentMessageRepo(db)
  messages.upsert(
    {
      id: 'msg-question',
      role: 'user',
      parts: [
        {
          type: 'text',
          id: 'p-question',
          messageID: 'msg-question',
          text: 'Give me back these env variables, well categorized, so I can use them.'
        }
      ],
      createdAt: 1_000
    },
    ANSWER_THREAD_ID
  )
  messages.upsert(
    {
      id: 'msg-answer',
      role: 'assistant',
      parts: [{ type: 'text', id: 'p-answer', messageID: 'msg-answer', text: ENV_ANSWER }],
      createdAt: 2_000
    },
    ANSWER_THREAD_ID
  )
  messages.upsert(
    {
      id: 'msg-unrelated',
      role: 'assistant',
      parts: [
        {
          type: 'text',
          id: 'p-unrelated',
          messageID: 'msg-unrelated',
          text: 'The release pipeline publishes a delta and rolls back when the health check fails.'
        }
      ],
      createdAt: 3_000
    },
    UNRELATED_THREAD_ID
  )
}

describe('thread search evidence for sentence queries', () => {
  let db: Database
  let service: ThreadSearchService

  beforeEach(async () => {
    db = await createTestDb()
    seed(db)
    service = new ThreadSearchService(db, new ThreadRepo(db))
  })

  afterEach(() => {
    destroyTestDb(db)
  })

  it('finds the conversation a sentence-length question is about, with no model attached', async () => {
    service.setIntentProvider(null)

    const { results, semantic } = await service.searchWithIntent(QUESTION, {}, 50)

    expect(semantic).toBe(false)
    expect(results.map((result) => result.thread.id)).toContain(ANSWER_THREAD_ID)
    expect(results[0]?.thread.id).toBe(ANSWER_THREAD_ID)
  })

  it('still answers nothing for a question this corpus does not hold', async () => {
    service.setIntentProvider(null)

    const { results } = await service.searchWithIntent(
      'How does the quarterly invoicing remainder get reconciled across currencies',
      {},
      50
    )

    expect(results.map((result) => result.thread.id)).not.toContain(ANSWER_THREAD_ID)
  })
})
