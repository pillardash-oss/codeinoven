import { parentPort, workerData } from 'node:worker_threads'
import { parse } from 'pele'
import type { MermaidValidationFailure } from './mermaid-output-validator'

const sources = workerData as string[]
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
parentPort?.postMessage(failures)
