import { parentPort, workerData } from 'node:worker_threads'
import { parse } from 'pele'
import type { MermaidValidationFailure } from './mermaid-output-validator'

/**
 * electron-vite rewrites this file into a worker factory (`?nodeWorker`), so its
 * body only ever executes inside the worker that factory starts. A runner that
 * does not understand that query (vitest loads the importing module graph
 * directly) evaluates it as a plain module instead, where `workerData` is null
 * and there is no port to answer on. Parsing therefore hangs off the port: an
 * import outside a worker thread does nothing rather than throwing before the
 * real caller could even reach its own code.
 */
function validateSources(sources: string[]): MermaidValidationFailure[] {
  const failures: MermaidValidationFailure[] = []
  for (const [index, source] of sources.entries()) {
    try {
      if (!source) throw new Error('Mermaid diagram is empty.')
      parse(source, { limit: 50_000, maxEdges: 500 })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failures.push({ block: index + 1, detail: detail.slice(0, 1_000) })
    }
  }
  return failures
}

const port = parentPort
if (port)
  port.postMessage(validateSources(Array.isArray(workerData) ? (workerData as string[]) : []))
