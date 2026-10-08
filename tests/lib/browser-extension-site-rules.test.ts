import { describe, expect, it } from 'vitest'
import {
  filterManifestForSiteRules,
  hostOfUrl,
  matchPatternCoversHost,
  runsOnHost,
  siteHostMatches
} from '../../src/lib/browser/browser-extension-site-rules'

describe('browser extension site rules', () => {
  it('matches a host and its subdomains', () => {
    expect(siteHostMatches('example.com', 'example.com')).toBe(true)
    expect(siteHostMatches('example.com', 'sub.example.com')).toBe(true)
    expect(siteHostMatches('example.com', 'other.com')).toBe(false)
  })

  it('blocks wins over an empty allowlist', () => {
    expect(runsOnHost(['example.com'], [], 'example.com')).toBe(false)
    expect(runsOnHost(['example.com'], [], 'sub.example.com')).toBe(false)
    expect(runsOnHost(['example.com'], [], 'other.com')).toBe(true)
  })

  it('allowlist restricts to listed hosts', () => {
    expect(runsOnHost([], ['example.com'], 'example.com')).toBe(true)
    expect(runsOnHost([], ['example.com'], 'other.com')).toBe(false)
  })

  it('reads http hosts only', () => {
    expect(hostOfUrl('https://example.com/page')).toBe('example.com')
    expect(hostOfUrl('chrome-extension://abc/page.html')).toBe(null)
  })

  it('covers common match patterns', () => {
    expect(matchPatternCoversHost('<all_urls>', 'example.com')).toBe(true)
    expect(matchPatternCoversHost('*://*.example.com/*', 'sub.example.com')).toBe(true)
    expect(matchPatternCoversHost('https://example.com/*', 'example.com')).toBe(true)
    expect(matchPatternCoversHost('https://other.com/*', 'example.com')).toBe(false)
  })

  it('adds blocked hosts to exclude_matches', () => {
    const filtered = filterManifestForSiteRules(
      { content_scripts: [{ matches: ['<all_urls>'], js: ['run.js'] }] },
      ['example.com'],
      []
    )
    const scripts = filtered?.content_scripts as unknown[] | undefined
    expect(Array.isArray(scripts)).toBe(true)
    const first = scripts?.[0] as Record<string, unknown> | undefined
    expect(first && typeof first === 'object').toBe(true)
    expect((first as any).exclude_matches).toContain('*://example.com/*')
  })

  it('intersects an allowlist with declared matches', () => {
    const filtered = filterManifestForSiteRules(
      { content_scripts: [{ matches: ['<all_urls>'], js: ['run.js'] }] },
      [],
      ['example.com']
    )
    const scripts = filtered?.content_scripts as unknown[] | undefined
    expect(Array.isArray(scripts)).toBe(true)
    const first = scripts?.[0] as Record<string, unknown> | undefined
    expect(first && typeof first === 'object').toBe(true)
    expect((first as any).matches).toContain('*://example.com/*')
  })
})
