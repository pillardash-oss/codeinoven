// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shapeRunReceipt } from '$shared/run-receipt'
import type { RunReceipt, Thread } from '$shared/types'
import { ASSISTANT_SPACE_ID } from '$shared/types'

vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(async () => null),
  subscribe: () => () => undefined,
  subscribeGuarded: () => () => undefined
}))

import RunReceiptBlock from '$lib/components/threads/RunReceipt.svelte'

/**
 * The receipt is a definition list, one label column with right-aligned counts.
 *
 * These cases assert structure and the style contract rather than a snapshot, so
 * a token change never breaks them and a change back to cards, badges or
 * uppercase micro-headings always does.
 */

const componentPaths = [
  'src/renderer/lib/components/threads/RunReceipt.svelte',
  'src/renderer/lib/components/threads/RunReceipt/RunReceiptFacts.svelte',
  'src/renderer/lib/components/threads/RunReceipt/RunReceiptFiles.svelte',
  'src/renderer/lib/components/threads/RunReceipt/RunReceiptChecks.svelte',
  'src/renderer/lib/components/threads/RunReceipt/RunReceiptStates.svelte'
]

function thread(): Thread {
  return {
    id: 'run1',
    projectId: ASSISTANT_SPACE_ID,
    providerId: 'pi',
    title: 'Run · 09:07',
    titleSource: 'manual',
    status: 'completed',
    pinned: false,
    archived: false,
    read: true,
    assistantId: 'assistant1',
    assistantTaskId: 'task1',
    boundScope: { projectId: 'project1', scopeBucketId: 'default' },
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/project'
  }
}

function receipt(): RunReceipt {
  return shapeRunReceipt({
    state: 'ready',
    projectId: 'project1',
    threadId: 'run1',
    scope: {
      projectId: 'project1',
      scopeBucketId: 'default',
      scopeName: 'Default',
      branch: 'cio/bound-assistant-tasks'
    },
    baseSha: 'base1',
    headSha: 'head1',
    commits: [
      { hash: 'head1', shortHash: 'head1', subject: 'A change', author: 'Ada', at: 2 }
    ],
    files: [
      {
        path: 'src/features/receipt.ts',
        status: 'modified',
        additions: 4,
        deletions: 2,
        binary: false
      }
    ],
    uncommitted: [],
    checks: [{ command: 'bun run test', outcome: 'passed' }],
    readAt: 1
  })
}

let instance: ReturnType<typeof mount> | undefined
let target: HTMLDivElement | undefined

afterEach(async () => {
  if (instance) await unmount(instance)
  instance = undefined
  target?.remove()
})

function mountReceipt(): HTMLDivElement {
  target = document.createElement('div')
  document.body.append(target)
  instance = mount(RunReceiptBlock, { target, props: { thread: thread(), receipt: receipt() } })
  flushSync()
  return target
}

describe('run receipt markup', () => {
  it('renders the facts as a definition list with one label column', () => {
    const root = mountReceipt()
    const list = root.querySelector('dl')
    expect(list).not.toBeNull()
    expect(list?.querySelectorAll('dt').length).toBe(5)
    expect(list?.querySelectorAll('dd').length).toBe(5)
    for (const definition of list?.querySelectorAll('dd') ?? []) {
      expect(definition.className).toContain('text-right')
    }
  })

  it('states the counts without a click', () => {
    const root = mountReceipt()
    const labels = [...(root.querySelectorAll('dt') ?? [])].map((node) => node.textContent?.trim())
    expect(labels).toEqual(['Workspace', 'Commits', 'Files', 'Uncommitted', 'Checks'])
    expect(root.textContent).toContain('cio/bound-assistant-tasks')
    expect(root.textContent).toContain('1 passed')
  })

  it('shows a file row with its letter and its line counts', () => {
    const root = mountReceipt()
    expect(root.textContent).toContain('M')
    expect(root.textContent).toContain('receipt.ts')
    expect(root.textContent).toContain('+4 −2')
  })

  it('draws no rounded corners and no type below 0.75rem', () => {
    for (const path of componentPaths) {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      // Only class attributes are judged: a doc comment may legitimately explain
      // that the surface has no rounded corners.
      const classes = [...source.matchAll(/class="([^"]*)"/gu)].map((match) => match[1]).join(' ')
      expect(classes).not.toMatch(/rounded/u)
      expect(classes).not.toMatch(/uppercase/u)
      expect(source).not.toMatch(/text-\[[0-9.]+px\]/u)
      const sizes = [...source.matchAll(/text-\[([0-9.]+)rem\]/gu)].map((match) =>
        Number.parseFloat(match[1] ?? '0')
      )
      for (const size of sizes) expect(size).toBeGreaterThanOrEqual(0.75)
    }
  })

  it('reserves --color-dimmed for marks, not for content strings', () => {
    for (const path of componentPaths) {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      expect(source).not.toMatch(/text-dimmed/u)
    }
  })
})
