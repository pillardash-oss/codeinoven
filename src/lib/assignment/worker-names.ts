export const WORKER_NAMES_FILE = 'wrk-names.json'
export const CUSTOM_WORKER_NAMES_FILE = 'wrk-names-custom.json'
export const MINIMUM_WORKER_NAME_COUNT = 10

export interface WorkerNameSettings {
  defaults: string[]
  custom: string[] | null
}

/** Emergency names used only when both config files are missing or unusable. */
export const FALLBACK_WORKER_NAMES = [
  'aaron',
  'abigail',
  'amos',
  'deborah',
  'ezra',
  'miriam',
  'naomi',
  'ruth',
  'samuel',
  'tobias'
] as const

/** Default Hebrew and Biblical names persisted to the user's config directory. */
export const DEFAULT_WORKER_NAMES = [
  'aaron',
  'abel',
  'abiathar',
  'abigail',
  'abner',
  'abraham',
  'adam',
  'adina',
  'ahinoam',
  'amos',
  'asa',
  'asher',
  'azariah',
  'barak',
  'benjamin',
  'boaz',
  'caleb',
  'carmel',
  'daniel',
  'david',
  'deborah',
  'dinah',
  'eli',
  'elijah',
  'elisha',
  'enoch',
  'ephraim',
  'esther',
  'ethan',
  'eve',
  'ezra',
  'gabriel',
  'gad',
  'gideon',
  'hannah',
  'hezekiah',
  'hoshea',
  'isaac',
  'isaiah',
  'jacob',
  'jael',
  'jeremiah',
  'joel',
  'jonah',
  'jonathan',
  'joseph',
  'joshua',
  'judah',
  'leah',
  'levi',
  'malachi',
  'manasseh',
  'micah',
  'miriam',
  'moses',
  'naomi',
  'nathan',
  'nehemiah',
  'noah',
  'obed',
  'rebecca',
  'reuben',
  'ruth',
  'samson',
  'samuel',
  'sarah',
  'saul',
  'seth',
  'shiloh',
  'simeon',
  'solomon',
  'tamar',
  'terah',
  'tirzah',
  'tobias',
  'yair',
  'zechariah',
  'zion'
] as const

export function normalizeWorkerNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const names = value
    .filter((name): name is string => typeof name === 'string')
    .map((name) =>
      name
        .trim()
        .toLocaleLowerCase('en-US')
        .replace(/\s+/gu, '-')
        .replace(/[^\p{L}\p{N}-]+/gu, '')
        .replace(/-+/gu, '-')
        .replace(/^-|-$/gu, '')
    )
    .filter(Boolean)
  return [...new Set(names)]
}
