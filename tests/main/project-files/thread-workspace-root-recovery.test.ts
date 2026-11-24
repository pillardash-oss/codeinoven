import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectFilesRootResolver } from '../../../src/main/editor/project-files/project-files-roots'
import { GLOBAL_BROWSER_PROJECT_ID, type Project } from '../../../src/lib/types'
import { browserThreadWorkspaceDirectory } from '../../../src/lib/project-artifacts'

/**
 * A mount root the app resolved once, then removed under the app.
 *
 * Deleting a browser assistant conversation deletes its `browser-cwd/<thread>`
 * workspace (`threadOwnedDirectories`). The file-tree resolver cached that path,
 * so every later read served the dead directory and failed with a bare ENOENT
 * that outlived the conversation. The cache has to notice a root that is gone
 * and resolve it again, which is what this test holds it to.
 */
describe('thread workspace mount roots', () => {
  let configRoot: string
  let resolver: ProjectFilesRootResolver

  const browserProject: Project = {
    id: GLOBAL_BROWSER_PROJECT_ID,
    name: 'Browser',
    path: '',
    source: 'local',
    providerId: '',
    workflowId: '',
    threadLimit: 0,
    createdAt: 0,
    updatedAt: 0
  }

  beforeEach(async () => {
    configRoot = await mkdtemp(join(tmpdir(), 'cio-thread-root-'))
    resolver = new ProjectFilesRootResolver(
      {
        getProject: async (id) => (id === browserProject.id ? browserProject : null),
        listProjects: async () => [browserProject]
      },
      undefined,
      {
        // The app's own browser lookup: resolve the workspace and create it on
        // demand, exactly as `createBrowserWorkspaceRoots` does.
        browser: {
          resolve: async (threadId: string) => {
            const root = join(configRoot, browserThreadWorkspaceDirectory(threadId))
            await mkdir(root, { recursive: true })
            return root
          }
        }
      }
    )
  })

  afterEach(async () => {
    await rm(configRoot, { recursive: true, force: true })
  })

  it('resolves a conversation workspace again after it was deleted', async () => {
    const threadId = 'browser-e31c1b2a-2fe7-4d1e-ab47-09036dcd7811'
    const workspace = join(configRoot, browserThreadWorkspaceDirectory(threadId))

    const first = await resolver.projectRoot(GLOBAL_BROWSER_PROJECT_ID, undefined, threadId)
    expect(await resolver.resolveExistingPath(first, '', true)).toBe(first)

    // The conversation is deleted, and its workspace with it.
    await rm(workspace, { recursive: true, force: true })

    // The cached root is not served: resolving again recreates the workspace
    // instead of failing on the deleted directory.
    const second = await resolver.projectRoot(GLOBAL_BROWSER_PROJECT_ID, undefined, threadId)
    await expect(resolver.resolveExistingPath(second, '', true)).resolves.toBe(second)
  })
})
