#!/usr/bin/env bun
/// <reference types="node" />
/**
 * Create missing CodeInOven usage insights in US PostHog. Existing insights are
 * left intact. Run with CODEINOVEN_POSTHOG_ADMIN_KEY and a project ID argument.
 * The admin key must never be included in a desktop build or repository file.
 * API: https://posthog.com/docs/api/dashboards and /docs/api/insights.
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Logger } from '../src/main/system/logger'

const projectId = Bun.argv[2]
if (!projectId || !/^\d+$/u.test(projectId)) throw new Error('Pass the numeric PostHog project ID')
const adminKey = process.env.CODEINOVEN_POSTHOG_ADMIN_KEY
if (!adminKey) throw new Error('CODEINOVEN_POSTHOG_ADMIN_KEY is required')
const origin = 'https://us.posthog.com'
const base = `${origin}/api/projects/${projectId}`
const dashboardName = 'CodeInOven user base'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid PostHog response')
  return value as Record<string, unknown>
}

async function request(
  url: string,
  body?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (new URL(url).origin !== origin) throw new Error('Unexpected PostHog pagination origin')
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  // Never print API responses: project/user records can contain credentials.
  if (!response.ok) throw new Error(`PostHog dashboard request failed: ${response.status}`)
  return record(await response.json())
}

async function list(url: string): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = []
  for (let page = 0; page < 100; page++) {
    const response = await request(url)
    if (!Array.isArray(response.results)) throw new Error('Invalid PostHog list')
    values.push(...response.results.map(record))
    if (!response.next) return values
    if (typeof response.next !== 'string') throw new Error('Invalid pagination URL')
    url = response.next
  }
  throw new Error('PostHog pagination limit reached')
}

function table(sql: string): Record<string, unknown> {
  return { kind: 'DataTableNode', source: { kind: 'HogQLQuery', query: sql } }
}
function trend(event: string, math: string, property?: string): Record<string, unknown> {
  return {
    kind: 'InsightVizNode',
    source: {
      kind: 'TrendsQuery',
      dateRange: { date_from: '-30d' },
      interval: 'day',
      series: [
        {
          kind: 'EventsNode',
          event,
          math,
          ...(property ? { math_property: property, math_property_type: 'event' } : {})
        }
      ],
      trendsFilter: { display: 'ActionsLineGraph' }
    }
  }
}

const definitions = [
  {
    name: 'Daily active installations',
    description:
      'Unique consenting installation IDs with an app interaction each day. Development and probes are excluded.',
    query: trend('app_active', 'dau')
  },
  {
    name: 'Monthly active installations',
    description:
      'Calendar-month distinct installation counts in UTC. The current month is partial. These count installations until account identity is implemented.',
    query: table(
      "SELECT toStartOfMonth(timestamp) AS month, count(DISTINCT distinct_id) AS active_installations FROM events WHERE event = 'app_active' AND timestamp >= now() - INTERVAL 6 MONTH GROUP BY month ORDER BY month DESC LIMIT 7"
    )
  },
  {
    name: 'Total participating installations',
    description:
      'Distinct first_open installation IDs. first_open means first measured interaction after consent, not every download or an account signup.',
    query: table(
      "SELECT count(DISTINCT distinct_id) AS participating_installations FROM events WHERE event = 'first_open'"
    )
  },
  {
    name: 'New participating installations',
    description: 'First measured interaction after analytics opt-in, by day.',
    query: trend('first_open', 'dau')
  },
  {
    name: 'Active platforms and architectures',
    description:
      'Unique active installations over the last 30 days by operating system and CPU architecture.',
    query: table(
      "SELECT properties.platform AS platform, properties.architecture AS architecture, count(DISTINCT distinct_id) AS active_installations FROM events WHERE event = 'app_active' AND timestamp >= now() - INTERVAL 30 DAY GROUP BY platform, architecture ORDER BY active_installations DESC LIMIT 20"
    )
  },
  {
    name: 'Active app versions',
    description:
      'Unique active installations over the last 30 days. An installation that upgrades may appear under multiple versions.',
    query: table(
      "SELECT properties.app_version AS version, count(DISTINCT distinct_id) AS active_installations FROM events WHERE event = 'app_active' AND timestamp >= now() - INTERVAL 30 DAY GROUP BY version ORDER BY active_installations DESC LIMIT 20"
    )
  },
  {
    name: 'GitHub installer downloads',
    description:
      'Latest cumulative GitHub installer download snapshot per day. Excludes mirror-origin downloads, ZIP update payloads, and metadata. Deleted GitHub assets cannot be counted.',
    query: trend('github_download_snapshot', 'max', 'total_downloads')
  },
  {
    name: 'GitHub downloads since previous snapshot',
    description:
      'Increase since the preceding successful collection. Normally about one day; missed or manually triggered runs change that interval. This is download activity, not unique users.',
    query: trend('github_download_snapshot', 'max', 'downloads_since_previous')
  }
]

const dashboards = await list(
  `${base}/dashboards/?search=${encodeURIComponent(dashboardName)}&limit=100`
)
let dashboard = dashboards.find((value) => value.name === dashboardName && value.deleted !== true)
if (!dashboard) {
  dashboard = await request(`${base}/dashboards/`, {
    name: dashboardName,
    description:
      'Opt-in installation usage, platforms, versions, and GitHub installer downloads. Account identity is deferred. Mirror-origin downloads are not included.',
    pinned: true
  })
}
if (typeof dashboard.id !== 'number') throw new Error('Missing dashboard ID')
const existing = await list(`${base}/insights/?limit=100`)
let created = 0
for (const definition of definitions) {
  if (
    existing.some(
      (value) =>
        value.name === definition.name &&
        value.deleted !== true &&
        Array.isArray(value.dashboards) &&
        value.dashboards.includes(dashboard.id)
    )
  )
    continue
  await request(`${base}/insights/`, {
    ...definition,
    dashboards: [dashboard.id]
  })
  created++
}
const dashboardUrl = `${origin}/project/${projectId}/dashboard/${dashboard.id}`
await mkdir(resolve('.cio/work/usage-analytics'), { recursive: true })
await Bun.write(
  resolve('.cio/work/usage-analytics/dashboard.json'),
  JSON.stringify({ dashboardUrl, created, total: definitions.length }, null, 2)
)
Logger.info(`Usage dashboard configured: ${dashboardUrl}`)
