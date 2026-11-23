import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundleContainsPhoton,
  emitPhotonPayload,
  photonPayloadDirectories,
  resolvePhotonWasm
} from '../../scripts/lib/vite-photon-wasm-plugin'

let directory = ''
let payload = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cio-photon-rollup-'))
  payload = join(directory, 'source.wasm')
  await writeFile(payload, Buffer.from([0x00, 0x61, 0x73, 0x6d]))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('photonPayloadDirectories', () => {
  it('covers the bundle root and its chunks sibling', () => {
    // Built with `join` so the expectation follows the platform separator:
    // Windows normalises the paths to `\\a\\b` and the run must not depend on it.
    const root = join(directory, 'app', 'out', 'main')
    expect(photonPayloadDirectories(root)).toEqual([root, join(root, 'chunks')])
  })
})

describe('bundleContainsPhoton', () => {
  it('is false for a bundle that never imported Photon', async () => {
    const out = join(directory, 'out')
    await mkdir(join(out, 'chunks'), { recursive: true })
    await writeFile(join(out, 'chunks', 'chat-engine.js'), 'export {}')
    expect(bundleContainsPhoton(out)).toBe(false)
  })

  it('is true once a photon chunk was emitted', async () => {
    const out = join(directory, 'out')
    await mkdir(join(out, 'chunks'), { recursive: true })
    await writeFile(join(out, 'chunks', 'photon_rs-WGObNja2.js'), 'export default 1')
    expect(bundleContainsPhoton(out)).toBe(true)
  })
})

describe('emitPhotonPayload', () => {
  it('leaves a bundle without Photon untouched', async () => {
    const out = join(directory, 'out')
    await mkdir(join(out, 'chunks'), { recursive: true })
    expect(emitPhotonPayload(out, payload)).toBe(false)
    expect(existsSync(join(out, 'chunks', 'photon_rs_bg.wasm'))).toBe(false)
  })

  it('copies the payload beside the chunk that reads it', async () => {
    const out = join(directory, 'out')
    await mkdir(join(out, 'chunks'), { recursive: true })
    await writeFile(join(out, 'chunks', 'photon_rs-WGObNja2.js'), 'export default 1')
    expect(emitPhotonPayload(out, payload)).toBe(true)
    const copied = await readFile(join(out, 'chunks', 'photon_rs_bg.wasm'))
    expect([...copied]).toEqual([0x00, 0x61, 0x73, 0x6d])
  })

  it('refuses to ship a Photon bundle with no payload to copy', async () => {
    const out = join(directory, 'out')
    await mkdir(join(out, 'chunks'), { recursive: true })
    await writeFile(join(out, 'chunks', 'photon_rs-WGObNja2.js'), 'export default 1')
    expect(() => emitPhotonPayload(out, null)).toThrow(/photon_rs_bg\.wasm/)
  })
})

describe('resolvePhotonWasm', () => {
  it('resolves the installed payload', () => {
    const source = resolvePhotonWasm()
    expect(source).not.toBeNull()
    expect(source?.endsWith('photon_rs_bg.wasm')).toBe(true)
    expect(existsSync(source ?? '')).toBe(true)
  })
})
