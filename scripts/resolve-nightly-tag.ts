/**
 * Resolve the exact nightly prerelease a promotion of `dev` into `nightly` will
 * publish: `v<base>-nightly.<N>`.
 *
 * The counter is the only thing that tells two nightlies of the SAME base apart
 * (`0.5.69-nightly.2` vs `0.5.69-nightly.3`). Without it every promotion of a
 * version reads identically in the GitHub Actions run list, because those rows
 * are titled with the pull request title (`Promote dev to nightly: 0.5.69`).
 * `scripts/deploy-nightly.sh` titles the promotion PR with the value resolved
 * here, and `.github/workflows/nightly.yml` re-runs this script as the
 * authority immediately before packaging, so the label a human sees and the tag
 * that actually ships are resolved by the same code.
 *
 * Usage:
 *   bun scripts/resolve-nightly-tag.ts                      # package.json version
 *   bun scripts/resolve-nightly-tag.ts --version 0.5.69     # explicit base
 *
 * Prints the next tag (`v0.5.69-nightly.3`) on stdout.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * Counter of a nightly tag for the given base, or null when the tag is not a
 * nightly of that base. Accepts the current `-nightly.<N>` form and the legacy
 * `-nightly-<N>` form: electron-updater derives the channel from the first
 * dot-separated prerelease identifier, so the dot form is what publishes now,
 * but older tags still count towards the counter.
 */
export function nightlyIndexFromTag(tag: string, base: string): number | null {
  const [major, minor, patch] = base.split('.')
  const pattern = new RegExp(`^v${major}\\.${minor}\\.${patch}-nightly[.-]([0-9]+)$`)
  const match = pattern.exec(tag)
  if (!match) return null
  const index = Number(match[1])
  return Number.isSafeInteger(index) && index >= 0 ? index : null
}

export interface NextNightlyTag {
  /** Highest counter already published for this base, 0 when none exist. */
  highest: number
  /** Counter the next nightly takes. */
  index: number
  /** Full prerelease version, e.g. `0.5.69-nightly.3`. */
  version: string
  /** Git tag the workflow publishes, e.g. `v0.5.69-nightly.3`. */
  tag: string
}

/**
 * Resolve the next nightly tag from every tag/release string already published.
 * Unknown and legacy shapes are ignored rather than fatal, because the input is
 * whatever the remote happens to hold.
 */
export function nextNightlyTag(base: string, existingTags: Iterable<string>): NextNightlyTag {
  if (!STABLE_VERSION_PATTERN.test(base)) {
    throw new TypeError(
      `Nightly base version must be a stable major.minor.patch version, got "${base}"`
    )
  }
  let highest = 0
  for (const tag of existingTags) {
    const index = nightlyIndexFromTag(tag.trim(), base)
    if (index !== null && index > highest) highest = index
  }
  const index = highest + 1
  const version = `${base}-nightly.${index}`
  return { highest, index, version, tag: `v${version}` }
}

/** Tags already on the remote for this base. A missing git remote is not fatal. */
function remoteTags(base: string): string[] {
  try {
    const output = execFileSync('git', ['ls-remote', '--tags', 'origin', `v${base}-nightly*`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return output
      .split('\n')
      .map((line) => line.split('\t')[1] ?? '')
      .map((ref) => ref.replace(/^refs\/tags\//, ''))
      .filter((tag) => tag.length > 0)
  } catch {
    return []
  }
}

/**
 * Tags carried by published releases. This covers a tag that was pushed but not
 * yet fetched by the checkout running this script, which is what makes two
 * back-to-back promotions resolve distinct counters.
 */
function releasedTags(base: string): string[] {
  try {
    const output = execFileSync(
      'gh',
      ['release', 'list', '--limit', '200', '--json', 'tagName', '--jq', '.[].tagName'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return output
      .split('\n')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0 && nightlyIndexFromTag(tag, base) !== null)
  } catch {
    return []
  }
}

function packageVersion(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
    throw new TypeError('package.json has no version field')
  }
  const { version } = parsed
  if (typeof version !== 'string') throw new TypeError('package.json version is not a string')
  return version
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const versionFlag = args.indexOf('--version')
  const base = versionFlag >= 0 ? (args[versionFlag + 1] ?? '') : packageVersion()
  const resolved = nextNightlyTag(base, [...remoteTags(base), ...releasedTags(base)])
  process.stdout.write(`${resolved.tag}\n`)
}
