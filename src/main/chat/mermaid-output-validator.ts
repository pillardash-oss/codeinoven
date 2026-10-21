/// <reference types="electron-vite/node" />
import createValidationWorker from './pele-validation-worker.ts?nodeWorker'
import { Logger } from '../system/logger'

const MAX_MERMAID_BLOCKS = 12
const MERMAID_FENCE_PATTERN =
  /(?:^|\r?\n)[ \t]{0,3}(`{3,}|~{3,})[ \t]*mermaid(?:[ \t]+[^\r\n]*)?\r?\n([\s\S]*?)\r?\n[ \t]{0,3}\1[ \t]*(?=\r?\n|$)/gi

export interface MermaidValidationFailure {
  block: number
  detail: string
}

export interface MermaidOutputValidation {
  diagramCount: number
  failures: MermaidValidationFailure[]
}

// Parsing stays off Electron's main thread, including hostile or deeply nested sources.
let validationQueue: Promise<unknown> = Promise.resolve()

function parseSources(sources: string[]): Promise<MermaidValidationFailure[]> {
  const result = validationQueue.then(
    () =>
      new Promise<MermaidValidationFailure[]>((resolve, reject) => {
        const worker = createValidationWorker({ workerData: sources })
        let settled = false
        const finish = (error?: Error, failures: MermaidValidationFailure[] = []): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          void worker.terminate()
          if (error) reject(error)
          else resolve(failures)
        }
        const timer = setTimeout(() => finish(new Error('Diagram validation timed out')), 5_000)
        worker.on('message', (failures: MermaidValidationFailure[]) => finish(undefined, failures))
        worker.on('error', (error: Error) => finish(error))
        worker.on('exit', (code: number) => {
          if (!settled) finish(new Error(`Diagram validator exited (${code})`))
        })
      })
  )
  validationQueue = result.catch(() => undefined)
  return result
}

function extractMermaidSources(markdown: string): string[] {
  return [...markdown.matchAll(MERMAID_FENCE_PATTERN)].map((match) => match[2]?.trim() ?? '')
}

export async function validateMermaidOutput(markdown: string): Promise<MermaidOutputValidation> {
  const sources = extractMermaidSources(markdown)
  if (sources.length === 0) return { diagramCount: 0, failures: [] }
  if (sources.length > MAX_MERMAID_BLOCKS) {
    return {
      diagramCount: sources.length,
      failures: [
        {
          block: MAX_MERMAID_BLOCKS + 1,
          detail: `Response contains more than ${MAX_MERMAID_BLOCKS} Mermaid diagrams.`
        }
      ]
    }
  }

  try {
    return { diagramCount: sources.length, failures: await parseSources(sources) }
  } catch (error) {
    Logger.error('Pele output validation unavailable; preserving completed response', error)
    return { diagramCount: sources.length, failures: [] }
  }
}

export function mermaidRepairPrompt(failures: MermaidValidationFailure[]): string {
  const diagnostics = failures
    .map((failure) => `- Diagram ${failure.block}: ${failure.detail}`)
    .join('\n')
  return [
    'Your previous answer was rejected because it contained invalid Mermaid syntax.',
    diagnostics,
    'Return one complete replacement answer, not a patch or explanation of the correction.',
    'Parse-check every Mermaid block before finalizing. In flowcharts, wrap every human-readable node label in double quotes, for example `A["Label with (punctuation)"]`.',
    'If you cannot produce a valid diagram, omit it and explain the relationship clearly in prose. Do not repeat the invalid source.'
  ].join('\n\n')
}
