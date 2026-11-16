import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { StorageAreaAction, StorageAreaId } from '../../lib/types'

/**
 * What the app's data root is made of, as a fixed list of areas.
 *
 * Every area names the absolute paths it answers for. Measuring walks the root
 * once and attributes each file to the deepest area whose path contains it, so
 * the rows always add up to the folder's real size and two areas can never
 * report the same bytes. The one exception is the profile, which is never
 * claimed as a whole: only its cache folders are, and the rest of it falls
 * through to the last row.
 *
 * `clearance` is what a delete removes. It is computed here, in main, and never
 * comes from the renderer, so a channel can only ever delete a folder this file
 * names.
 */
export interface StorageAreaSpec {
  id: StorageAreaId
  label: string
  detail: string
  action: StorageAreaAction | null
  actionLabel: string | null
  /** Absolute paths this area answers for while measuring. */
  paths: string[]
  /** Absolute paths a delete removes. Empty when the area cannot be cleared. */
  clearance: string[]
}

/** Cache folders a Chromium profile keeps beside its real state. */
const PROFILE_CACHE_DIRECTORIES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GraphiteDawnCache',
  'DawnCache',
  'DawnGraphiteCache',
  'ShaderCache',
  'Service Worker/CacheStorage',
  'Service Worker/ScriptCache'
] as const

/**
 * Chromium profile folders the app can own.
 *
 * A packaged launch keeps its profile in `electron`, an unpackaged one in
 * `dev-browser-profile`, and every extra instance gets its own `slot-N` profile
 * so two Electron instances never share cookies. Naming all three means the
 * caches of a secondary window are reclaimable too.
 */
async function chromiumProfileRoots(configRoot: string): Promise<string[]> {
  const roots = [join(configRoot, 'electron'), join(configRoot, 'dev-browser-profile')]
  const slots = await listDirectoryNames(join(configRoot, 'electron-instances'))
  for (const slot of slots) {
    if (slot.startsWith('slot-')) roots.push(join(configRoot, 'electron-instances', slot))
  }
  return roots
}

/**
 * Every cache folder inside one Chromium profile, including the per-partition
 * ones a project's browser tab gets.
 */
async function chromiumCachePaths(profileRoot: string): Promise<string[]> {
  const paths: string[] = []
  for (const directory of PROFILE_CACHE_DIRECTORIES) paths.push(join(profileRoot, directory))
  const partitions = await listDirectoryNames(join(profileRoot, 'Partitions'))
  for (const partition of partitions) {
    for (const directory of PROFILE_CACHE_DIRECTORIES) {
      paths.push(join(profileRoot, 'Partitions', partition, directory))
    }
  }
  return paths
}

/**
 * The full area list for one data root.
 *
 * A folder that does not exist contributes nothing and needs no special case:
 * measuring skips a missing path, and a delete of a missing path is a no-op.
 */
export async function storageAreaSpecs(configRoot: string): Promise<StorageAreaSpec[]> {
  const root = resolve(configRoot)
  const at = (...parts: string[]): string => join(root, ...parts)

  const profileCachePaths: string[] = []
  for (const profileRoot of await chromiumProfileRoots(root)) {
    profileCachePaths.push(...(await chromiumCachePaths(profileRoot)))
  }

  return [
    {
      id: 'database',
      label: 'Database',
      detail: 'Threads, messages, projects and settings. Compacting hands free pages back to disk.',
      action: 'vacuum',
      actionLabel: 'Compact',
      paths: [at('codeinoven.db'), at('codeinoven.db-wal'), at('codeinoven.db-shm'), at('backups')],
      clearance: []
    },
    {
      id: 'models',
      label: 'Local models',
      detail: 'Speech, search, video and local AI models downloaded onto this machine.',
      action: 'delete',
      actionLabel: 'Delete models',
      paths: [
        at('local-models'),
        at('speech', 'models'),
        at('search', 'models'),
        at('video', 'models')
      ],
      clearance: [
        at('local-models'),
        at('speech', 'models'),
        at('search', 'models'),
        at('video', 'models')
      ]
    },
    {
      id: 'recordings',
      label: 'Recordings',
      detail: 'Dictation and meeting audio you recorded, kept until you remove it.',
      action: 'delete',
      actionLabel: 'Delete recordings',
      paths: [at('speech', 'recordings')],
      clearance: [at('speech', 'recordings')]
    },
    {
      id: 'caches',
      label: 'Caches',
      detail:
        'Browser caches, the search index, prepared playback copies and build scratch. All of it rebuilds itself.',
      action: 'delete',
      actionLabel: 'Clear caches',
      paths: [
        ...profileCachePaths,
        at('build-cache'),
        at('search', 'index'),
        at('search', 'staging'),
        at('speech', 'staging'),
        at('speech', 'playback')
      ],
      clearance: [
        ...profileCachePaths,
        at('build-cache'),
        at('search', 'index'),
        at('search', 'staging'),
        at('speech', 'staging'),
        at('speech', 'playback')
      ]
    },
    {
      id: 'logs',
      label: 'Logs',
      detail: 'Durable diagnostics the app writes per day, one folder per day.',
      action: 'delete',
      actionLabel: 'Delete logs',
      paths: [at('logs'), at('local-ai', 'logs')],
      clearance: [at('logs'), at('local-ai', 'logs')]
    },
    {
      id: 'workspaces',
      label: 'Conversation workspaces',
      detail:
        'Files and scratch the app keeps per chat, assistant and browser tab. CIO Cleanup removes what went stale instead of everything.',
      action: 'cleanup',
      actionLabel: 'Clean up',
      paths: [
        at('eph-cwd'),
        at('chats-cwd'),
        at('assistant-cwd'),
        at('browser-cwd'),
        at('chat-artifacts'),
        at('chats-artifacts'),
        at('chats'),
        at('scratch')
      ],
      clearance: []
    },
    {
      id: 'projects',
      label: 'Project data',
      detail:
        'Checkpoints, blobs, design history and attachments for the projects you opened. Removing a project removes its data.',
      action: null,
      actionLabel: null,
      paths: [at('projects'), at('projects-gh'), at('assistants')],
      clearance: []
    },
    {
      id: 'app-data',
      label: 'App data',
      detail:
        'Browser profiles, downloaded harness runtimes, extensions, secrets and saved window state. The app needs these as they are.',
      action: null,
      actionLabel: null,
      paths: [],
      clearance: []
    }
  ]
}

/** Directory names directly under a root, or an empty list when it is absent. */
async function listDirectoryNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter(
        (entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')
      )
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
