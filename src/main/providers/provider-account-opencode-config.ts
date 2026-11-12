import { randomUUID } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { isOpenCodeV2Version } from '../../lib/opencode-version'
import {
  cachedOpenCodeInstallation,
  detectOpenCodeInstallation
} from '../agents/opencode-installation'
import { readHarnessHomeFile, writeHarnessHomeFile } from '../drivers/harness-runtime'

/**
 * OpenCode's hidden-provider config. V1 hides a provider through
 * `disabled_providers`, V2 through `experimental.policies` deny statements, and
 * both forms live in the same global config file. Reads take the union on a V2
 * install; writes edit the file in place so comments and trailing commas
 * round-trip untouched.
 */

/** OpenCode's global config file   hiding providers edits disabled_providers here. */
const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json')

const OPENCODE_CONFIG_FORMAT = { tabSize: 2, insertSpaces: true, eol: '\n' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One `experimental.policies` statement in an OpenCode V2 config. */
export interface OpenCodeV2Policy {
  action: string
  resource: string
  effect: string
}

/** The global config file both OpenCode lines read (`.jsonc` also works). */
const OPENCODE_CONFIG_RELATIVE_PATH = '.config/opencode/opencode.json'

/**
 * Provider ids hidden from OpenCode's model picker.
 *
 * V1 lists them in `disabled_providers`. V2 replaced that list with
 * `experimental.policies` statements, documented as "Use provider.use instead
 * of the V1 enabled_providers and disabled_providers lists":
 * `{action:'provider.use', resource:<id>, effect:'deny'}`. A denied provider
 * disappears from the catalog and model selection even with valid credentials.
 * Both forms live in the same global config file, and a V2 install still
 * translates a `disabled_providers` list it finds, so a V2 read is the union of
 * the two: a list written before the upgrade keeps hiding its providers.
 */
export async function readHiddenProviders(v2: boolean): Promise<string[]> {
  try {
    const raw = await readOpenCodeConfig()
    if (raw === null) return []
    const config = parseOpenCodeConfig(raw)
    if (!config) return []
    return readHiddenProviderIds(config, v2)
  } catch {
    return []
  }
}

/**
 * Hidden provider ids in one parsed config, for the detected line. V1 reads
 * `disabled_providers`; V2 reads the union of both forms, because a V2 install
 * still translates a V1 list it finds.
 */
export function readHiddenProviderIds(config: Record<string, unknown>, v2: boolean): string[] {
  if (!v2) return readHiddenProvidersFromDisabledList(config)
  return Array.from(
    new Set([
      ...readHiddenProvidersFromDisabledList(config),
      ...readHiddenProvidersFromPolicies(config)
    ])
  )
}

/** Provider ids denied by `provider.use` policy statements, in written order. */
export function readHiddenProvidersFromPolicies(config: Record<string, unknown>): string[] {
  const experimental = config['experimental']
  if (!isRecord(experimental)) return []
  const policies = experimental['policies']
  if (!Array.isArray(policies)) return []
  const hidden: string[] = []
  for (const entry of policies) {
    if (!isRecord(entry)) continue
    if (entry['action'] !== 'provider.use' || entry['effect'] !== 'deny') continue
    const resource = entry['resource']
    if (typeof resource === 'string' && resource.trim()) hidden.push(resource.trim())
  }
  return Array.from(new Set(hidden))
}

/** Provider ids listed in the V1 `disabled_providers` array. */
export function readHiddenProvidersFromDisabledList(config: Record<string, unknown>): string[] {
  const list = config['disabled_providers']
  return Array.isArray(list)
    ? Array.from(new Set(list.filter((entry): entry is string => typeof entry === 'string')))
    : []
}

/**
 * Persist the hidden-provider list with a targeted text edit, so the rest of
 * the file (comments, trailing commas, other keys) round-trips untouched.
 * Written atomically so a harness config is never left half-written.
 */
export async function writeHiddenProviders(providers: string[], v2: boolean): Promise<void> {
  const raw = (await readOpenCodeConfig()) ?? '{}\n'
  const edited = v2
    ? openCodeV2HiddenConfig(raw, providers)
    : applyEdits(
        raw,
        modify(raw, ['disabled_providers'], providers, {
          formattingOptions: OPENCODE_CONFIG_FORMAT
        })
      )
  const content = edited.endsWith('\n') ? edited : `${edited}\n`
  if (await writeHarnessHomeFile('opencode', OPENCODE_CONFIG_RELATIVE_PATH, content)) return

  const configDir = dirname(OPENCODE_CONFIG_PATH)
  await mkdir(configDir, { recursive: true })
  const temporaryPath = `${OPENCODE_CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    await rename(temporaryPath, OPENCODE_CONFIG_PATH)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * The V2 policy list to persist: every non-`provider.use` statement and every
 * `provider.use` allow kept as written, then one deny per hidden provider.
 * Denies come last because the last matching statement wins, so a provider the
 * user hid stays hidden even when an allow for it already exists. An empty list
 * removes the key instead of leaving `policies: []` behind.
 */
export function openCodeV2HiddenPolicies(
  raw: string,
  providers: string[]
): OpenCodeV2Policy[] | undefined {
  const config = parseOpenCodeConfig(raw)
  const experimental = config?.['experimental']
  const existing =
    isRecord(experimental) && Array.isArray(experimental['policies'])
      ? experimental['policies']
      : []
  const kept: OpenCodeV2Policy[] = []
  for (const entry of existing) {
    if (!isRecord(entry)) continue
    const action = entry['action']
    const resource = entry['resource']
    const effect = entry['effect']
    if (typeof action !== 'string' || typeof resource !== 'string' || typeof effect !== 'string') {
      continue
    }
    if (action === 'provider.use' && effect === 'deny') continue
    kept.push({ action, resource, effect })
  }
  const policies = [
    ...kept,
    ...providers.map((resource) => ({ action: 'provider.use', resource, effect: 'deny' }))
  ]
  return policies.length > 0 ? policies : undefined
}

/**
 * The V2 config text for a hidden-provider set.
 *
 * Two things are written. The native form is `experimental.policies` deny
 * statements, which is what V2 documents. The V1 `disabled_providers` list is
 * kept mirrored to the same set: a V2 install translates that list into the
 * same denies anyway (verified against the binary), so mirroring changes
 * nothing at the V2 line while keeping the user's hiding intact if the machine
 * later runs a V1 install. A list the user already had is rewritten rather than
 * dropped, and the key is removed once nothing is hidden.
 */
export function openCodeV2HiddenConfig(raw: string, providers: string[]): string {
  const config = parseOpenCodeConfig(raw)
  const hadLegacyList = config !== null && Array.isArray(config['disabled_providers'])
  let edited = applyEdits(
    raw,
    modify(raw, ['experimental', 'policies'], openCodeV2HiddenPolicies(raw, providers), {
      formattingOptions: OPENCODE_CONFIG_FORMAT
    })
  )
  if (hadLegacyList || providers.length > 0) {
    edited = applyEdits(
      edited,
      modify(edited, ['disabled_providers'], providers.length > 0 ? providers : undefined, {
        formattingOptions: OPENCODE_CONFIG_FORMAT
      })
    )
  }
  return edited
}

/** The OpenCode global config, or `null` when it does not exist yet. */
async function readOpenCodeConfig(): Promise<string | null> {
  const wslRaw = await readHarnessHomeFile('opencode', OPENCODE_CONFIG_RELATIVE_PATH)
  if (wslRaw !== undefined) return wslRaw
  try {
    return await readFile(OPENCODE_CONFIG_PATH, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

/** Parse the config as JSONC; `null` when it is unreadable or not an object. */
function parseOpenCodeConfig(raw: string): Record<string, unknown> | null {
  const errors: ParseError[] = []
  const parsed = parse(raw, errors, { allowTrailingComma: true })
  return errors.length === 0 && isRecord(parsed) ? parsed : null
}

/** Whether the OpenCode install the app will drive is the V2 line. */
export async function isOpenCodeV2Installed(): Promise<boolean> {
  const installation = cachedOpenCodeInstallation() ?? (await detectOpenCodeInstallation())
  return installation !== null && isOpenCodeV2Version(installation.version)
}
