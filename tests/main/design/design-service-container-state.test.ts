import { afterEach, describe, expect, it } from 'vitest'
import { ASSISTANT_SPACE_ID } from '../../../src/lib/types'
import { DesignService } from '../../../src/main/design/design-service'
import type { DirectoryPreviewService } from '../../../src/main/preview/directory-preview-service'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { createTestDb, destroyTestDb } from '../database/test-helper'
import type { Database } from '../../../src/main/database/database'

describe('DesignService conversation container state', () => {
  let database: Database | undefined

  afterEach(() => {
    if (database) destroyTestDb(database)
    database = undefined
  })

  it("lists an assistant task's own workspace, which starts empty", async () => {
    database = await createTestDb()
    new ProjectRepo(database).upsert({
      id: ASSISTANT_SPACE_ID,
      name: 'Assistant',
      path: '',
      source: 'local',
      providerId: '',
      workflowId: 'default',
      threadLimit: 500,
      hidden: true,
      pinned: false,
      color: '#123456',
      changeTrackingMode: 'manual',
      createdAt: 1,
      updatedAt: 1
    })
    const service = new DesignService({
      database,
      previews: {} as DirectoryPreviewService,
      browser: () => null
    })

    // The container has no folder of its own, but an assistant task runs in
    // `assistant-cwd/<assistant>`, so its board reads that workspace instead of
    // refusing: the root is the constant design folder inside it, and a task that
    // has designed nothing yet lists nothing.
    await expect(service.stateFor(ASSISTANT_SPACE_ID, 'assistant-thread')).resolves.toMatchObject({
      projectId: ASSISTANT_SPACE_ID,
      threadId: 'assistant-thread',
      kind: 'design',
      active: false,
      current: null,
      items: [],
      root: '.cio/designs'
    })
    await expect(service.authoredWorkKindFor('assistant-thread')).resolves.toBeNull()
  })
})
