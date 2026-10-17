import { parentPort } from 'node:worker_threads'
import { ProjectFileIndexService } from './project-file-index-core'
import type { IndexRequest, IndexResponse } from './project-file-index-service'

const port = parentPort
const index = new ProjectFileIndexService()
port?.on('message', async ({ id, request }: { id: number; request: IndexRequest }) => {
  const response: IndexResponse = { id }
  try {
    switch (request.kind) {
      case 'search':
        response.entries = await index.search(
          request.projectId,
          request.root,
          request.query,
          request.category,
          request.projectName
        )
        break
      case 'prewarm':
        await index.prewarm(request.projectId, request.root)
        break
      case 'invalidate':
        index.invalidate(request.projectId)
        break
      case 'dispose':
        index.dispose(request.projectId)
        break
    }
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error)
  }
  port.postMessage(response)
})
