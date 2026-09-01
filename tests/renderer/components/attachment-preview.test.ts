import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../../../', import.meta.url)

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, repoRoot), 'utf8')
}

const componentSource = readRepoFile('src/renderer/lib/components/chats/AttachmentPreview.svelte')
const lockfile = readRepoFile('bun.lock')
const packageJson = JSON.parse(readRepoFile('package.json')) as {
  dependencies?: Record<string, string>
  overrides?: Record<string, string>
}

describe('AttachmentPreview SEC-01 presentation containment', () => {
  it('removes the interactive pptx-preview renderer from the production component', () => {
    expect(componentSource).not.toMatch(/pptx-preview/)
  })

  it('never injects untrusted presentation bytes into a trusted DOM container', () => {
    expect(componentSource).not.toMatch(/innerHTML\s*=/)
  })

  it('keeps the sanitized, sandboxed document preview that PPTX documents fall back to', () => {
    expect(componentSource).toMatch(/DOMPurify\.sanitize/)
    expect(componentSource).toMatch(/sandbox=""/)
    expect(componentSource).toMatch(/srcdoc=\{documentSrcdoc\}/)
  })

  it('drops pptx-preview and echarts from the production graph while pinning UUID 11.1.1', () => {
    expect(packageJson.dependencies?.['pptx-preview']).toBeUndefined()
    expect(packageJson.overrides?.echarts).toBeUndefined()
    expect(packageJson.overrides?.uuid).toBe('11.1.1')
    expect(lockfile).not.toMatch(/"pptx-preview"/)
    expect(lockfile).not.toMatch(/"echarts": \["echarts@/)
  })
})
