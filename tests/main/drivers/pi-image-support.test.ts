import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditPiImageSupport,
  mainChunkRoots,
  photonWasmDirectories,
  resetPiImageSupportAudit
} from '../../../src/main/drivers/pi/pi-image-support'

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cio-photon-audit-'))
  resetPiImageSupportAudit()
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
  resetPiImageSupportAudit()
})

describe('photonWasmDirectories', () => {
  it('searches the chunk roots before the loader fallbacks', () => {
    const searched = photonWasmDirectories(['/app/out/main', '/app/out/main/chunks'])
    const executableDirectory = dirname(process.execPath)
    expect(searched.slice(0, 2)).toEqual(['/app/out/main', '/app/out/main/chunks'])
    expect(searched.slice(2)).toEqual([
      executableDirectory,
      join(executableDirectory, 'photon'),
      process.cwd()
    ])
  })
})

describe('mainChunkRoots', () => {
  it('covers a bundle beside the entry and a chunks sibling', () => {
    expect(mainChunkRoots(`file://${join(directory, 'bundle', 'chunk.js')}`)).toEqual([
      join(directory, 'bundle'),
      join(directory, 'bundle', 'chunks')
    ])
  })
})

describe('auditPiImageSupport', () => {
  it('reports an unusable pipeline when no Photon payload shipped', () => {
    const support = auditPiImageSupport(`file://${join(directory, 'chunk.js')}`)
    expect(support.resizable).toBe(false)
    expect(support.searched).toContain(directory)
  })

  it('reports a usable pipeline when the payload sits beside the chunk', async () => {
    await writeFile(join(directory, 'photon_rs_bg.wasm'), Buffer.from([0x00]))
    const support = auditPiImageSupport(`file://${join(directory, 'chunk.js')}`)
    expect(support.resizable).toBe(true)
  })

  it('audits once, so the cache answers later calls with the same layout', () => {
    const first = auditPiImageSupport(`file://${join(directory, 'chunk.js')}`)
    const second = auditPiImageSupport(`file://${join(directory, 'other', 'chunk.js')}`)
    expect(second).toBe(first)
  })
})
