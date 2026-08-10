import DOMPurify from 'dompurify'

const MAX_MERMAID_BLOCKS = 12
const MAX_MERMAID_SOURCE_CHARS = 50_000
const ERROR_DETAIL_LIMIT = 1_000
const MERMAID_FENCE_PATTERN =
  /(?:^|\r?\n)[ \t]{0,3}(`{3,}|~{3,})[ \t]*mermaid(?:[ \t]+[^\r\n]*)?\r?\n([\s\S]*?)\r?\n[ \t]{0,3}\1[ \t]*(?=\r?\n|$)/gi

interface HeadlessPurifier {
  addHook?: (entryPoint: string, hookFunction: (node: Element) => void) => void
  sanitize?: (source: string) => string
}

interface MermaidParser {
  parse(
    source: string,
    options?: { suppressErrors?: boolean }
  ): Promise<{ diagramType: string } | false>
}

export interface MermaidValidationFailure {
  block: number
  detail: string
}

export interface MermaidOutputValidation {
  diagramCount: number
  failures: MermaidValidationFailure[]
}

let parserPromise: Promise<MermaidParser> | undefined

function loadParser(): Promise<MermaidParser> {
  parserPromise ??= (async () => {
    // Mermaid's parser initializes diagram databases that expect DOMPurify's
    // browser hooks, even though syntax validation itself does not touch the DOM.
    // Supply inert hooks in Electron's main process before Mermaid is imported.
    const purifier = DOMPurify as unknown as HeadlessPurifier
    purifier.addHook ??= () => undefined
    purifier.sanitize ??= (source) => source
    const module = await import('mermaid')
    return module.default
  })().catch((error) => {
    parserPromise = undefined
    throw error
  })
  return parserPromise
}

function extractMermaidSources(markdown: string): string[] {
  return [...markdown.matchAll(MERMAID_FENCE_PATTERN)].map((match) => match[2]?.trim() ?? '')
}

function errorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return detail.slice(0, ERROR_DETAIL_LIMIT)
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

  const parser = await loadParser()
  const failures: MermaidValidationFailure[] = []
  for (const [index, source] of sources.entries()) {
    if (!source) {
      failures.push({ block: index + 1, detail: 'Mermaid diagram is empty.' })
      continue
    }
    if (source.length > MAX_MERMAID_SOURCE_CHARS) {
      failures.push({
        block: index + 1,
        detail: `Mermaid diagram exceeds ${MAX_MERMAID_SOURCE_CHARS} characters.`
      })
      continue
    }
    try {
      const result = await parser.parse(source)
      if (result === false) {
        failures.push({ block: index + 1, detail: 'Mermaid parser rejected the diagram.' })
      }
    } catch (error) {
      failures.push({ block: index + 1, detail: errorDetail(error) })
    }
  }
  return { diagramCount: sources.length, failures }
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
