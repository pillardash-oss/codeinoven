#!/usr/bin/env bun
/// <reference types="node" />
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Logger } from '../src/main/system/logger'

interface AssetCount {
  id: number
  name: string
  release: string
  platform: 'macOS' | 'Windows' | 'Linux'
  downloads: number
}
interface Snapshot {
  timestamp: string
  source: 'github'
  assets: AssetCount[]
  total: number
  platforms: Record<string, number>
  previousTimestamp: string | null
  downloadsSincePrevious: number | null
}

const repository = process.env.GITHUB_REPOSITORY ?? 'pillardash-oss/codeinoven'
if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('Invalid GitHub repository')
const directory = resolve('.cio/tmp/download-metrics')
await mkdir(directory, { recursive: true })
const previousFile = Bun.file(resolve(directory, 'previous/snapshot.json'))
const previous = (await previousFile.exists()) ? ((await previousFile.json()) as Snapshot) : null
const assets: AssetCount[] = []
const platforms: Record<string, number> = { macOS: 0, Windows: 0, Linux: 0 }

async function github(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    },
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`GitHub metrics request failed: ${response.status}`)
  return response.json()
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid GitHub response')
  return value as Record<string, unknown>
}

// Page sequentially. Refuse truncation rather than publish a misleading total.
for (let page = 1; page <= 100; page++) {
  const releases = await github(`releases?per_page=100&page=${page}`)
  if (!Array.isArray(releases)) throw new Error('Invalid release list')
  for (const value of releases) {
    const release = record(value)
    if (release.draft === true) continue
    if (typeof release.id !== 'number' || typeof release.tag_name !== 'string')
      throw new Error('Invalid release')
    for (let assetPage = 1; assetPage <= 100; assetPage++) {
      const batch = await github(`releases/${release.id}/assets?per_page=100&page=${assetPage}`)
      if (!Array.isArray(batch)) throw new Error('Invalid asset list')
      for (const value of batch) {
        const asset = record(value)
        if (typeof asset.name !== 'string') throw new Error('Invalid asset name')
        // ZIPs are macOS auto-update payloads. Metadata and blockmaps are excluded.
        const platform = /\.dmg$/iu.test(asset.name)
          ? 'macOS'
          : /\.exe$/iu.test(asset.name)
            ? 'Windows'
            : /\.(?:AppImage|deb)$/iu.test(asset.name)
              ? 'Linux'
              : null
        if (!platform) continue
        if (
          typeof asset.id !== 'number' ||
          typeof asset.download_count !== 'number' ||
          !Number.isSafeInteger(asset.download_count) ||
          asset.download_count < 0
        )
          throw new Error('Invalid download count')
        assets.push({
          id: asset.id,
          name: asset.name,
          release: release.tag_name,
          platform,
          downloads: asset.download_count
        })
        platforms[platform] += asset.download_count
      }
      if (batch.length < 100) break
      if (assetPage === 100) throw new Error('Asset pagination limit reached')
    }
  }
  if (releases.length < 100) break
  if (page === 100) throw new Error('Release pagination limit reached')
}

const previousCounts = new Map(previous?.assets.map((asset) => [asset.id, asset.downloads]) ?? [])
const snapshot: Snapshot = {
  timestamp: new Date().toISOString(),
  source: 'github',
  assets,
  total: assets.reduce((sum, asset) => sum + asset.downloads, 0),
  platforms,
  previousTimestamp: previous?.timestamp ?? null,
  // Match by asset ID so deleted releases cannot make the aggregate delta negative.
  downloadsSincePrevious: previous
    ? assets.reduce(
        (sum, asset) => sum + Math.max(0, asset.downloads - (previousCounts.get(asset.id) ?? 0)),
        0
      )
    : null
}
await Bun.write(resolve(directory, 'snapshot.json'), JSON.stringify(snapshot, null, 2))
await Bun.write(
  resolve(directory, 'summary.md'),
  [
    '# GitHub installer downloads',
    '',
    `Captured at ${snapshot.timestamp}. Source: [GitHub release assets](https://docs.github.com/en/rest/releases/assets).`,
    '',
    `Total available installer downloads: ${snapshot.total}.`,
    `Downloads since previous snapshot: ${snapshot.downloadsSincePrevious ?? 'No baseline yet'}.`,
    '',
    '| Platform | Downloads |',
    '| --- | ---: |',
    ...Object.entries(platforms).map(([platform, count]) => `| ${platform} | ${count} |`),
    '',
    'Counts exclude ZIP update payloads and metadata. Installer downloads may include updates and repeated downloads. Deleted assets are unavailable. Mirror-origin downloads are excluded; see `docs/DOWNLOAD-MIRROR.md`.',
    ''
  ].join('\n')
)

// Scheduled service events are kept separate from app_active so they never
// inflate installation DAU/MAU. No personal/admin API key is required.
if (process.env.CODEINOVEN_POSTHOG_TOKEN) {
  const response = await fetch('https://us.i.posthog.com/batch/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
    body: JSON.stringify({
      api_key: process.env.CODEINOVEN_POSTHOG_TOKEN,
      batch: [
        {
          event: 'github_download_snapshot',
          distinct_id: 'codeinoven-download-metrics',
          timestamp: snapshot.timestamp,
          properties: {
            $process_person_profile: false,
            $geoip_disable: true,
            source: snapshot.source,
            total_downloads: snapshot.total,
            macos_downloads: platforms.macOS,
            windows_downloads: platforms.Windows,
            linux_downloads: platforms.Linux,
            downloads_since_previous: snapshot.downloadsSincePrevious,
            previous_snapshot_at: snapshot.previousTimestamp
          }
        }
      ]
    })
  })
  await response.body?.cancel()
  if (!response.ok) throw new Error(`PostHog metrics ingestion failed: ${response.status}`)
}
Logger.info('GitHub download snapshot saved')
