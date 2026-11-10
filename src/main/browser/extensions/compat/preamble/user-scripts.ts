/**
 * `chrome.userScripts`, rebuilt on the content-script pipeline.
 *
 * The runtime has no `chrome.userScripts`, and its `scripting` API refuses the
 * `USER_SCRIPT` execution world outright ("Value must be one of ISOLATED, MAIN",
 * measured with the permission declared), which is the CSP-exempt world the API
 * exists for. What remains is the pipeline Chromium itself uses for content scripts:
 * `register` writes each script's code into a file the app materializes inside the
 * extension's own copy, then registers that file. `world: 'MAIN'` maps exactly, and
 * `USER_SCRIPT` maps to the extension's isolated world.
 *
 * For the code extensions actually register this is faithful: uBlock Origin Lite's
 * generated user scripts are `eval`-free, use no `chrome.*` API and are isolated from
 * the page in either world (its own `js/offscreen/scriptlet.template.js`), so the one
 * loss is that a script which wanted `eval` would meet the extension's MV3 CSP
 * instead of the user-script world's exemption. Registering a file, rather than code,
 * is likewise what `scripting.registerContentScripts` accepts: its `js` is a list of
 * paths.
 *
 * WHY THE ANSWER COMES BACK THROUGH STORAGE
 * A worker has no other way to be answered: it cannot be called, only read. The
 * bridge page polls the request key, writes the files, and answers into a key the
 * worker polls.
 */
import { chromeApi, installNamespaceOnRoot, roots, state } from './context.ts'
import type { ChromeNamespace } from './context.ts'

/** One storage area, as far as this module calls one. */
interface KeyValueArea {
  get: (key: string) => Promise<Record<string, unknown> | null>
  set: (values: Record<string, unknown>) => Promise<unknown>
}

/** The `chrome.scripting` members this module calls. */
interface ScriptingApi {
  registerContentScripts: (scripts: Array<Record<string, unknown>>) => Promise<unknown>
  unregisterContentScripts: (filter: { ids: string[] }) => Promise<unknown>
  getRegisteredContentScripts?: () => Promise<Array<Record<string, unknown>>>
  executeScript?: (details: Record<string, unknown>) => Promise<unknown>
}

/** One user script as the extension declared it. */
interface UserScriptDeclaration {
  id?: unknown
  world?: unknown
  js?: unknown
  matches?: unknown
  excludeMatches?: unknown
  allFrames?: unknown
  runAt?: unknown
}

/** One script's code, as `js: [{ code }]` or `js: [{ file }]`. */
interface UserScriptSource {
  code?: unknown
  file?: unknown
}

/** One entry of this shim's own registry. */
interface UserScriptEntry {
  id: string
  world: string
  runtimeWorld: string
  registrationId: string
  file: string
  code: string
  matches: unknown[]
  excludeMatches: unknown[]
  allFrames: boolean
  runAt: string
}

/** The userScripts namespace this shim installs. */
interface UserScriptsApi extends ChromeNamespace {
  getScripts: () => Promise<unknown[]>
  register: (scripts: unknown) => Promise<void>
  unregister: (filter: unknown) => Promise<void>
  update: (scripts: unknown) => Promise<void>
  execute: (injection: unknown) => Promise<unknown>
  configureWorld: (config: unknown) => Promise<string>
  getWorldConfigurations: () => Promise<unknown[]>
  resetWorldConfiguration: (worldId: unknown) => Promise<void>
}

const userScriptIdPrefix = 'cio-us-'
const userScriptDirName = 'cio-user-scripts'
const userScriptRegistryKey = '__cioUserScripts'
const userScriptWorldsKey = '__cioUserScriptWorlds'
const userScriptRequestsKey = '__cioFileRequests'
const userScriptReadyKey = '__cioFileReady'
const userScriptMaxCode = 512 * 1024

/** A short, stable hash of a script id, so a registration id is predictable. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0').slice(0, 8)
}

function storageNamespace(): { local?: unknown; session?: unknown } | null {
  const storage = chromeApi.storage
  return storage ? (storage as { local?: unknown; session?: unknown }) : null
}

function localArea(): KeyValueArea | null {
  const storage = storageNamespace()
  const local = storage ? storage.local : null
  return local ? (local as KeyValueArea) : null
}

function sessionArea(): KeyValueArea | null {
  const storage = storageNamespace()
  if (!storage) return null
  return ((storage.session || storage.local || null) as KeyValueArea | null) ?? null
}

function scriptingApi(): ScriptingApi | null {
  return (chromeApi.scripting as ScriptingApi | undefined) ?? null
}

async function readKey(area: KeyValueArea | null, key: string): Promise<unknown> {
  if (!area) return null
  try {
    const bag = await area.get(key)
    return bag ? bag[key] : null
  } catch (error) {
    state.errors.push('userScripts-read: ' + String(error))
    return null
  }
}

async function writeKey(area: KeyValueArea | null, key: string, value: unknown): Promise<void> {
  if (!area) return
  try {
    await area.set({ [key]: value })
  } catch (error) {
    state.errors.push('userScripts-write: ' + String(error))
  }
}

/** The world Chromium is asked for, as the extension stated it. */
const requestedWorld = (world: unknown): string => (world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT')

/** The world this runtime has. `USER_SCRIPT` has no equivalent, and the
 *  extension's isolated world is the same isolation from the page. */
const runtimeWorld = (world: unknown): string => (world === 'MAIN' ? 'MAIN' : 'ISOLATED')

function codeOf(sources: unknown): string {
  if (!Array.isArray(sources)) return ''
  const parts: string[] = []
  for (const source of sources as UserScriptSource[]) {
    if (!source || typeof source !== 'object') continue
    if (typeof source.code === 'string') {
      parts.push(source.code)
      continue
    }
    // A file the extension shipped itself cannot be read back here, so the app is
    // asked to copy it in beside the registered code instead.
    if (typeof source.file === 'string' && source.file) {
      parts.push(`/* cio:file:${source.file} */`)
    }
  }
  return parts.join('\n;\n')
}

function registryEntry(script: UserScriptDeclaration): UserScriptEntry {
  const id = typeof script.id === 'string' && script.id ? script.id : 'cio-anonymous'
  const world = requestedWorld(script.world)
  const code = codeOf(script.js)
  const registrationId = `${userScriptIdPrefix}${shortHash(`${id}|${world}`)}`
  return {
    id,
    world,
    runtimeWorld: runtimeWorld(world),
    registrationId,
    file: `${userScriptDirName}/${registrationId}.js`,
    code,
    matches: Array.isArray(script.matches) ? script.matches : [],
    excludeMatches: Array.isArray(script.excludeMatches) ? script.excludeMatches : [],
    allFrames: script.allFrames === true,
    runAt: typeof script.runAt === 'string' ? script.runAt : 'document_start'
  }
}

let userScriptRequestSeq = 0

/**
 * Ask the app to write the registered code into the extension's own copy and wait for
 * it to answer. The bridge page polls this key, and the answer is written back into
 * the same storage the worker can read.
 */
async function materialize(entries: UserScriptEntry[]): Promise<unknown[]> {
  const area = sessionArea()
  if (!area) throw new Error('no storage area for user script files')
  const oversized = entries.find((entry) => entry.code.length > userScriptMaxCode)
  if (oversized) {
    throw new Error(`the code for user script "${oversized.id}" is too large to register`)
  }
  const request = ++userScriptRequestSeq
  const files = entries
    .filter((entry) => entry.code.length !== 0)
    .map((entry) => ({ path: entry.file, code: entry.code }))
  const keep = entries.map((entry) => entry.file)
  await writeKey(area, userScriptRequestsKey, { request, files, keep, at: Date.now() })
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const answer = (await readKey(area, userScriptReadyKey)) as Record<string, unknown> | null
    if (answer && typeof answer === 'object' && answer['request'] === request) {
      if (answer['error']) throw new Error(String(answer['error']))
      return Array.isArray(answer['paths']) ? (answer['paths'] as unknown[]) : []
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error('the app did not write the user script files in time')
}

async function readRegistry(): Promise<UserScriptEntry[]> {
  const stored = await readKey(localArea(), userScriptRegistryKey)
  if (!Array.isArray(stored)) return []
  return (stored as UserScriptEntry[]).filter(
    (entry) => entry && typeof entry === 'object' && entry.registrationId
  )
}

async function writeRegistry(entries: Array<Record<string, unknown>>): Promise<void> {
  await writeKey(localArea(), userScriptRegistryKey, entries)
}

async function registerScripts(scripts: unknown): Promise<void> {
  const scripting = scriptingApi()
  if (!scripting || typeof scripting.registerContentScripts !== 'function') {
    throw new Error('scripting.registerContentScripts is unavailable')
  }
  const unregister = scripting.unregisterContentScripts
  const register = scripting.registerContentScripts
  if (!Array.isArray(scripts) || scripts.length === 0) return
  const incoming = (scripts as UserScriptDeclaration[]).map(registryEntry)
  const previous = await readRegistry()
  const merged = previous
    .filter(
      (entry) => incoming.some((next) => next.registrationId === entry.registrationId) === false
    )
    .concat(incoming)
  await materialize(merged)
  // Registering the same id twice is an error, and a registration can outlive the
  // worker that made it, so the ids about to be used are freed first.
  const ids = incoming.map((entry) => entry.registrationId)
  await unregister({ ids }).catch(() => undefined)
  await register(
    incoming.map((entry) => ({
      id: entry.registrationId,
      world: entry.runtimeWorld,
      matches: entry.matches.length !== 0 ? entry.matches : ['<all_urls>'],
      ...(entry.excludeMatches.length !== 0 ? { excludeMatches: entry.excludeMatches } : {}),
      ...(entry.allFrames ? { allFrames: true } : {}),
      runAt: entry.runAt,
      js: [entry.file]
    }))
  )
  // The code lives in the file from here on, so the registry keeps only what
  // `getScripts` and the restore path need: a large scriptlet must not sit in
  // the extension's storage a second time.
  await writeRegistry(
    merged.map((entry) => {
      const stored = { ...entry } as Record<string, unknown>
      delete stored['code']
      return stored
    })
  )
  state['userScripts'] = {
    registered: merged.length,
    worlds: merged.map((entry) => entry.world),
    at: Date.now()
  }
}

async function unregisterScripts(filter: unknown): Promise<void> {
  const scripting = scriptingApi()
  if (!scripting || typeof scripting.unregisterContentScripts !== 'function') {
    throw new Error('scripting.unregisterContentScripts is unavailable')
  }
  const previous = await readRegistry()
  const requested = filter && typeof filter === 'object' ? (filter as Record<string, unknown>) : {}
  const ids = Array.isArray(requested['ids'])
    ? new Set((requested['ids'] as unknown[]).map((id) => String(id)))
    : null
  const keep: UserScriptEntry[] = []
  const drop: string[] = []
  for (const entry of previous) {
    if (ids === null || ids.has(entry.id)) drop.push(entry.registrationId)
    else keep.push(entry)
  }
  if (drop.length !== 0) {
    await scripting.unregisterContentScripts({ ids: drop }).catch(() => undefined)
  }
  await writeRegistry(keep as unknown as Array<Record<string, unknown>>)
  state['userScripts'] = { registered: keep.length, at: Date.now() }
}

async function listScripts(): Promise<unknown[]> {
  const entries = await readRegistry()
  return entries.map((entry) => ({
    id: entry.id,
    world: entry.world,
    matches: entry.matches.length !== 0 ? entry.matches : ['<all_urls>'],
    ...(entry.excludeMatches.length !== 0 ? { excludeMatches: entry.excludeMatches } : {}),
    ...(entry.allFrames ? { allFrames: true } : {}),
    runAt: entry.runAt,
    // The runtime holds this script as a file, and saying so is honest about
    // what `register` did with the code.
    js: [{ file: entry.file }]
  }))
}

const userScriptsApi: UserScriptsApi = {
  getScripts: () => listScripts(),
  register: (scripts) => registerScripts(scripts).then(() => undefined),
  unregister: (filter) => unregisterScripts(filter),
  update: async (scripts) => {
    const entries = await readRegistry()
    const known = new Set(entries.map((entry) => entry.id))
    for (const script of Array.isArray(scripts) ? (scripts as UserScriptDeclaration[]) : []) {
      const id = script && typeof script.id === 'string' ? script.id : ''
      if (!id || known.has(id) === false) {
        throw new Error(`no user script with id "${id}" is registered`)
      }
    }
    const declarations = (Array.isArray(scripts) ? scripts : []) as UserScriptDeclaration[]
    await unregisterScripts({ ids: declarations.map((script) => script.id) })
    await registerScripts(scripts)
  },
  execute: async (injection) => {
    const scripting = scriptingApi()
    if (!scripting || typeof scripting.executeScript !== 'function') {
      throw new Error('scripting.executeScript is unavailable')
    }
    const request =
      injection && typeof injection === 'object'
        ? (injection as Record<string, unknown>)
        : ({} as Record<string, unknown>)
    const entry = registryEntry({
      id: 'cio-execute',
      world: request['world'],
      js: request['js'],
      matches: ['<all_urls>']
    })
    await materialize([entry])
    return scripting.executeScript({
      world: entry.runtimeWorld,
      target: request['target'] ?? { tabId: request['tabId'] },
      ...(request['allFrames'] === true ? { allFrames: true } : {}),
      ...(request['injectImmediately'] === true ? { injectImmediately: true } : {}),
      files: [entry.file]
    })
  },
  configureWorld: async (config) => {
    const request = config && typeof config === 'object' ? (config as Record<string, unknown>) : {}
    const worlds =
      ((await readKey(localArea(), userScriptWorldsKey)) as Record<string, unknown> | null) || {}
    const worldId =
      typeof request['worldId'] === 'string' && request['worldId']
        ? (request['worldId'] as string)
        : `${userScriptIdPrefix}${shortHash(String(request['messaging'] === true))}`
    const stored = Object.assign({}, worlds, {
      [worldId]: {
        worldId,
        messaging: Boolean(request['messaging'] === true),
        ...(typeof request['csp'] === 'string' ? { csp: request['csp'] } : {})
      }
    })
    await writeKey(localArea(), userScriptWorldsKey, stored)
    return worldId
  },
  getWorldConfigurations: async () => {
    const worlds =
      ((await readKey(localArea(), userScriptWorldsKey)) as Record<string, unknown> | null) || {}
    return Object.keys(worlds).map((key) => worlds[key])
  },
  resetWorldConfiguration: async (worldId) => {
    const worlds =
      ((await readKey(localArea(), userScriptWorldsKey)) as Record<string, unknown> | null) || {}
    if (typeof worldId !== 'string' || !worldId) {
      await writeKey(localArea(), userScriptWorldsKey, {})
      return
    }
    const next = Object.assign({}, worlds)
    delete next[worldId]
    await writeKey(localArea(), userScriptWorldsKey, next)
  }
}

/** Install `chrome.userScripts` and reconcile registrations from an earlier life. */
export function installUserScripts(): void {
  try {
    for (const root of roots) {
      const existing = root && (root['userScripts'] as ChromeNamespace | undefined)
      if (existing && typeof existing['getScripts'] === 'function') continue
      installNamespaceOnRoot(root, 'userScripts', userScriptsApi, [])
    }
    state['userScripts'] = { installed: true }

    // A registration can outlive the worker that made it, so anything this app
    // registered for an earlier life is read back into the registry on startup:
    // `getScripts` then answers with what the runtime really holds, and a fresh
    // `register` with the same ids does not collide with the old ones.
    void (async () => {
      try {
        const scripting = scriptingApi()
        if (!scripting || typeof scripting.getRegisteredContentScripts !== 'function') return
        const registered = await scripting.getRegisteredContentScripts()
        const ours = registered.filter(
          (entry) =>
            entry && typeof entry['id'] === 'string' && entry['id'].startsWith(userScriptIdPrefix)
        )
        const registry = await readRegistry()
        const known = new Set(registry.map((entry) => entry.registrationId))
        const orphans = ours.filter((entry) => known.has(String(entry['id'])) === false)
        if (orphans.length !== 0) {
          await scripting.unregisterContentScripts({
            ids: orphans.map((entry) => String(entry['id']))
          })
        }
        state['userScripts'] = {
          installed: true,
          registered: registry.length,
          orphansRemoved: orphans.length
        }
      } catch (error) {
        state.errors.push('userScripts-sweep: ' + String(error))
      }
    })()
  } catch (error) {
    state.errors.push('userScripts: ' + String(error))
  }
}
