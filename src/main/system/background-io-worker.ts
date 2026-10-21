import { parentPort } from 'node:worker_threads'
import { backgroundIo } from './background-io-core'
import type { BackgroundIoRequest } from './background-io-protocol'

parentPort?.on('message', async (request: BackgroundIoRequest) => {
  try {
    parentPort?.postMessage({ value: await backgroundIo(request) })
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
})
