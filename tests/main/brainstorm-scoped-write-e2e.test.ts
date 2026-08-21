import { describe, expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildProcessEnvironment
} from '../../src/main/drivers/cli-environment'
import {
  BRAINSTORM_DOCUMENT_WRITE_TOOLS
} from '../../src/main/chat/chat-engine'
import { leanAgentDefinition } from '../../src/main/opencode/opencode-agent-definitions'

/**
 * P3-cp4 END-TO-END: run a REAL brainstorm document turn through a live
 * opencode serve under the shipped `cio-brainstorm` agent and observe the
 * agent itself persisting the session-report revision through its scoped
 * `edit` permission.
 *
 * Asserts:
 * 1. A report Markdown file appears under `.cio/specs/<feature>/versions/`.
 * 2. The agent wrote NOTHING outside `.cio/specs/` (path scope held).
 *
 * Gated behind `CIO_OPCODE_BRAINSTORM_E2E=1` because it spawns a real server
 * and makes a live provider call. Uses the free flash model.
 */

function probeSkipReason(): string | null {
  if (process.env['CIO_OPCODE_BRAINSTORM_E2E'] !== '1') {
    return 'Set CIO_OPCODE_BRAINSTORM_E2E=1 to run the live scoped-write end-to-end test'
  }
  try {
    execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 15_000 })
    return null
  } catch {
    return 'opencode is not installed on this machine'
  }
}

const FEATURE = 'test-feature'

// Verbatim replica of the shipped brainstorm-document app prompt (cio-prompts
// default template with APP_NAME / tool name substituted) plus the exact
// revision-path instruction the dispatch supplies on the scoped-write route.
function brainstormDocumentSystemPrompt(revisionPath: string): string {
  const citations =
    'Cite the source of every factual claim you report. Cite local files with their project-rooted relative path, never a bare filename. Cite external references as Markdown links, never as bare text. Never cite a source you did not inspect or retrieve.'
  const mermaid =
    'Use a fenced `mermaid` block when a multi-step flow is materially clearer as a diagram. Keep diagrams concise and parse-valid. Do not add decorative diagrams.'
  return [
    'Conduct evidence-driven research and create a reviewable Brainstorm document through brainstorm_document.',
    'Inspect actual project state with read-only tools and research current external facts when material.',
    'Label facts Verified, Inferred, or Unknown.',
    'Return Context, Goals, Decisions, Open Questions, Constraints, and Proposed Direction.',
    'When the dispatch supplies an exact session-report revision path under .cio/specs, write the report Markdown to exactly that path and nowhere else; never modify any other file. Do not implement.',
    citations,
    mermaid,
    '',
    'Session-report revision path (write the report Markdown to EXACTLY this project-relative path, creating parent directories as needed):',
    revisionPath
  ].join('\n')
}

async function startServe(projectDir: string): Promise<{
  baseUrl: string
  child: ReturnType<typeof spawn>
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd: projectDir,
      env: buildProcessEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error('serve start timeout')) }
    }, 30_000)
    child.stdout?.on('data', (chunk) => {
      buffer += chunk.toString()
      const m = buffer.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m && !settled) { settled = true; clearTimeout(timer); resolve({ baseUrl: `http://127.0.0.1:${m[1]}`, child }) }
    })
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } })
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`serve exit ${code}`)) } })
  })
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(full.slice(root.length + 1))
    }
  }
  await walk(root)
  return out
}

describe('brainstorm scoped-write end-to-end', () => {
  it.skipIf(probeSkipReason() !== null)(
    'persists the session-report revision through the agent write under .cio/specs versions',
    async () => {
      const skipReason = probeSkipReason()
      if (skipReason !== null) return
      const projectDir = await mkdtemp(join(tmpdir(), 'opencode-brainstorm-e2e-'))
      // Real project markers so the workspace looks like a CodeInOven project.
      await mkdir(join(projectDir, 'src'), { recursive: true })
      await writeFile(join(projectDir, 'src', 'app.ts'), 'export const feature = "brainstorm"\n', 'utf-8')
      const configDir = join(projectDir, '.opencode')
      await mkdir(configDir, { recursive: true })
      const agent = leanAgentDefinition('cio-brainstorm')
      if (!agent) throw new Error('missing cio-brainstorm agent')
      await writeFile(
        join(configDir, 'opencode.json'),
        JSON.stringify(
          { $schema: 'https://opencode.ai/config.json', agent: { [agent.name]: agent } },
          null,
          2
        ),
        'utf-8'
      )
      const revisionRelativePath = `.cio/specs/${FEATURE}/versions/session-e2e-brainstorm.md`
      let serve: { baseUrl: string; child: ReturnType<typeof spawn> } | null = null
      try {
        const started = await startServe(projectDir)
        serve = started
        const session = (await fetch(`${started.baseUrl}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'brainstorm-e2e' })
        }).then((r) => r.json())) as { id: string }
        const body = {
          model: { providerID: 'opencode', modelID: 'x-preview-f-free' },
          agent: agent.name,
          system: brainstormDocumentSystemPrompt(revisionRelativePath),
          tools: { '*': false, ...Object.fromEntries(BRAINSTORM_DOCUMENT_WRITE_TOOLS.map((t) => [t, true])) },
          parts: [{
            type: 'text',
            text: [
              'The team decided to build a lean chat agent to cut per-turn token usage; this was confirmed and is not open for debate.',
              'Write the session-report Markdown for that decision to the exact revision path given in your instructions, then reply DONE.',
              'You do not need web research for this; keep it local and brief.'
            ].join('\n')
          }]
        }
        await fetch(`${started.baseUrl}/session/${session.id}/prompt_async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        // Wait for the turn AND the agent's write (the write can land after
        // step-finish of an intermediate step, so poll the filesystem too).
        const deadline = Date.now() + 180_000
        let written: string | null = null
        while (Date.now() < deadline && written === null) {
          await new Promise((r) => setTimeout(r, 3_000))
          try {
            written = await readFile(join(projectDir, revisionRelativePath), 'utf-8')
          } catch {
            written = null
          }
        }
        expect(written, `agent never wrote ${revisionRelativePath}`).not.toBeNull()
        const report = written as string
        expect(report.toLowerCase()).toContain('lean chat agent')
        // Path scope held: nothing outside .cio/specs was created or modified.
        const files = await listFilesRecursive(projectDir)
        const escaped = files.filter(
          (file) => !file.startsWith('.cio/specs/') && !file.startsWith('.opencode/') && file !== 'src/app.ts' && !file.startsWith('serve.log')
        )
        expect(escaped, `agent wrote outside .cio/specs: ${escaped.join(', ')}`).toEqual([])
        // The report landed under the FEATURE versions directory specifically.
        const specFiles = files.filter((file) => file.startsWith(`.cio/specs/${FEATURE}/versions/`))
        expect(specFiles.length).toBeGreaterThan(0)
      } finally {
        if (serve) serve.child.kill()
        await rm(projectDir, { recursive: true, force: true }).catch(() => undefined)
      }
    },
    300_000
  )
})
