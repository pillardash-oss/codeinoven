import { describe, expect, it, vi } from 'vitest'

// `buildSurfaceMetrics` is pure and takes plain shapes, but it lives beside the
// Electron reader that shares its module, so the module import needs a stub.
vi.mock('electron', () => ({
  app: { getAppMetrics: () => [] },
  webContents: { getAllWebContents: () => [] }
}))

import { buildSurfaceMetrics } from '../../../src/main/system/surface-metrics'

const KIB = 1024

function processRow(pid: number, cpuPercent: number, workingSetSize: number) {
  return { pid, cpu: { percentCPUUsage: cpuPercent }, memory: { workingSetSize } }
}

function contentsRow(pid: number, type: string, title: string, url: string) {
  return { pid, type, title, url }
}

describe('buildSurfaceMetrics', () => {
  it('returns nothing for empty input', () => {
    expect(buildSurfaceMetrics({ metrics: [], contents: [] })).toEqual([])
  })

  it('joins a WebContents to its process metrics by pid', () => {
    const surfaces = buildSurfaceMetrics({
      metrics: [processRow(4242, 12.5, 2048)],
      contents: [contentsRow(4242, 'window', 'CodeInOven', 'file:///app/index.html')]
    })

    expect(surfaces).toEqual([
      {
        pid: 4242,
        kind: 'window',
        title: 'CodeInOven',
        url: 'file:///app/index.html',
        cpuPercent: 12.5,
        memoryBytes: 2048 * KIB
      }
    ])
  })

  it('sorts by CPU first and memory second', () => {
    const surfaces = buildSurfaceMetrics({
      metrics: [processRow(1, 3, 4096), processRow(2, 40, 1024), processRow(3, 3, 8192)],
      contents: [
        contentsRow(1, 'window', 'Window', 'file:///one'),
        contentsRow(2, 'browserView', 'Tab', 'https://two.test/'),
        contentsRow(3, 'webview', 'Guest', 'https://three.test/')
      ]
    })

    expect(surfaces.map((surface) => surface.pid)).toEqual([2, 3, 1])
  })

  it('maps every WebContents type onto a surface kind', () => {
    const kinds = ['window', 'browserView', 'webview', 'offscreen', 'backgroundPage', 'remote'].map(
      (type, index) =>
        buildSurfaceMetrics({
          metrics: [processRow(index + 1, 1, KIB)],
          contents: [contentsRow(index + 1, type, `Surface ${index}`, 'file:///surface')]
        })[0]?.kind
    )

    expect(kinds).toEqual(['window', 'tab', 'webview', 'offscreen', 'offscreen', 'other'])
  })

  it('converts working-set kibibytes to bytes', () => {
    const surfaces = buildSurfaceMetrics({
      metrics: [processRow(7, 0.5, 512)],
      contents: [contentsRow(7, 'window', 'Window', 'file:///app/index.html')]
    })

    expect(surfaces[0]?.memoryBytes).toBe(512 * KIB)
  })

  it('strips the query and hash from a URL but keeps origin and path', () => {
    const surfaces = buildSurfaceMetrics({
      metrics: [processRow(11, 2, KIB)],
      contents: [
        contentsRow(
          11,
          'browserView',
          'Sign in',
          'https://example.test/auth/callback?token=secret#section'
        )
      ]
    })

    expect(surfaces[0]?.url).toBe('https://example.test/auth/callback')
    expect(surfaces[0]?.url).not.toContain('secret')
  })

  it('truncates a long URL instead of printing all of it', () => {
    const longUrl = `https://example.test/${'a'.repeat(400)}`
    const surfaces = buildSurfaceMetrics({
      metrics: [processRow(12, 2, KIB)],
      contents: [contentsRow(12, 'browserView', 'Long page', longUrl)]
    })

    expect(surfaces[0]?.url.length).toBe(200)
    expect(surfaces[0]?.url.startsWith('https://example.test/')).toBe(true)
    expect(surfaces[0]?.url.endsWith('…')).toBe(true)
  })

  it('falls back to the title when a surface has no URL', () => {
    const surfaces = buildSurfaceMetrics({
      metrics: [processRow(13, 2, KIB)],
      contents: [contentsRow(13, 'offscreen', 'Extension worker', '')]
    })

    expect(surfaces[0]?.url).toBe('Extension worker')
    expect(surfaces[0]?.title).toBe('Extension worker')
  })

  it('skips a metrics row that no WebContents claims', () => {
    const surfaces = buildSurfaceMetrics({
      metrics: [processRow(21, 5, KIB), processRow(22, 90, KIB), processRow(23, 1, KIB)],
      contents: [contentsRow(21, 'window', 'Window', 'file:///app/index.html')]
    })

    expect(surfaces.map((surface) => surface.pid)).toEqual([21])
  })

  it('skips a WebContents no metric reports yet', () => {
    const surfaces = buildSurfaceMetrics({
      metrics: [processRow(31, 5, KIB)],
      contents: [
        contentsRow(31, 'window', 'Window', 'file:///app/index.html'),
        contentsRow(32, 'webview', 'Fresh guest', 'https://guest.test/')
      ]
    })

    expect(surfaces.map((surface) => surface.pid)).toEqual([31])
  })

  it('reports one row per process when two surfaces share a renderer', () => {
    const surfaces = buildSurfaceMetrics({
      metrics: [processRow(41, 8, KIB)],
      contents: [
        contentsRow(41, 'window', 'Window', 'file:///app/index.html'),
        contentsRow(41, 'webview', 'Guest', 'https://guest.test/')
      ]
    })

    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]?.cpuPercent).toBe(8)
  })
})
