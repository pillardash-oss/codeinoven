import { readFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { getConfigRoot, atomicWrite } from '../utils'
import { createHash } from 'crypto'

const FREQUENCY_FILE = 'memory-frequency.json'
const MEMORY_DIR = 'memory'
const MEMORY_PROJECTS_DIR = join(MEMORY_DIR, 'projects')

interface FrequencyRecord {
  contentHash: string
  count: number
  firstSeen: number
  lastSeen: number
  messageSamples: string[]
}

interface FrequencyStore {
  records: FrequencyRecord[]
}

function hashContent(content: string): string {
  return createHash('sha256').update(content.toLowerCase().trim()).digest('hex').slice(0, 16)
}

function getFrequencyPath(projectId?: string): string {
  const basePath = projectId
    ? join(getConfigRoot(), MEMORY_PROJECTS_DIR, projectId)
    : join(getConfigRoot(), MEMORY_DIR)
  return join(basePath, FREQUENCY_FILE)
}

async function readStore(projectId?: string): Promise<FrequencyStore> {
  try {
    const content = await readFile(getFrequencyPath(projectId), 'utf-8')
    const parsed: unknown = JSON.parse(content)
    if (isRecord(parsed) && Array.isArray(parsed.records)) {
      return { records: parsed.records as FrequencyRecord[] }
    }
    return { records: [] }
  } catch {
    return { records: [] }
  }
}

async function writeStore(store: FrequencyStore, projectId?: string): Promise<void> {
  const path = getFrequencyPath(projectId)
  if (projectId) {
    await mkdir(join(getConfigRoot(), MEMORY_PROJECTS_DIR, projectId), { recursive: true })
  }
  await atomicWrite(path, JSON.stringify(store, null, 2))
}

/**
 * Track how often the same instruction or preference is repeated.
 * Returns the updated count and whether this should trigger a memory proposal.
 */
export async function trackFrequency(
  content: string,
  projectId?: string
): Promise<{ count: number; shouldPropose: boolean }> {
  const store = await readStore(projectId)
  const hash = hashContent(content)
  const now = Date.now()

  const existing = store.records.find((r) => r.contentHash === hash)
  if (existing) {
    existing.count++
    existing.lastSeen = now
    if (existing.messageSamples.length < 3) {
      existing.messageSamples.push(content.slice(0, 200))
    }
    await writeStore(store, projectId)
    return {
      count: existing.count,
      shouldPropose: existing.count >= 2
    }
  }

  const record: FrequencyRecord = {
    contentHash: hash,
    count: 1,
    firstSeen: now,
    lastSeen: now,
    messageSamples: [content.slice(0, 200)]
  }
  store.records.push(record)
  await writeStore(store, projectId)
  return { count: 1, shouldPropose: false }
}

/** Get the frequency count for a specific content hash. */
export async function getFrequency(content: string, projectId?: string): Promise<number> {
  const store = await readStore(projectId)
  const hash = hashContent(content)
  return store.records.find((r) => r.contentHash === hash)?.count ?? 0
}

/** Get all frequency records above a minimum count. */
export async function getFrequentInstructions(
  minCount: number,
  projectId?: string
): Promise<FrequencyRecord[]> {
  const store = await readStore(projectId)
  return store.records.filter((r) => r.count >= minCount)
}

/** Decay old records by reducing their count. Records below 1 are removed. */
export async function decayFrequencies(projectId?: string, decayFactor = 0.9): Promise<void> {
  const store = await readStore(projectId)
  store.records = store.records
    .map((r) => ({ ...r, count: Math.floor(r.count * decayFactor) }))
    .filter((r) => r.count > 0)
  await writeStore(store, projectId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
