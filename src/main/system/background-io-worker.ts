import { parentPort } from 'node:worker_threads'
import { backgroundIo } from './background-io-core'
import type { ThreadEmbeddingRecord } from '../../lib/search/types'
import type { BackgroundIoRequest } from './background-io-protocol'

parentPort?.on('message', async (request: BackgroundIoRequest) => {
  try {
    const value: unknown = await backgroundIo(request)
    if (request.kind === 'index-read') {
      const page = value as { records: ThreadEmbeddingRecord[] }
      const buffers = new Set<ArrayBuffer>()
      for (const record of page.records)
        for (const window of record.windows) {
          if (window.vector.buffer instanceof ArrayBuffer) buffers.add(window.vector.buffer)
        }
      parentPort?.postMessage({ value }, [...buffers])
    } else if (
      request.kind === 'index-encode' &&
      value instanceof Uint8Array &&
      value.buffer instanceof ArrayBuffer
    ) {
      parentPort?.postMessage({ value }, [value.buffer])
    } else parentPort?.postMessage({ value })
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
})
