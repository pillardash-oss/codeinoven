import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { incrementVersion } from './bump-version'

/**
 * Bump only the published `cio-oven` package version.
 *
 * The CLI ships on its own cadence, so releasing it must never move the desktop
 * app's version (the release pipeline owns that). This is the one place the
 * published package version changes; `bun run oven:cli:build` no longer touches
 * it.
 */
const VERSION_FIELD_PATTERN = /"version"\s*:\s*"([^"]+)"/g

async function bumpOvenCliVersion(): Promise<void> {
  const manifestUrl = new URL('../packages/cio-oven/package.json', import.meta.url)
  const temporaryUrl = new URL('../packages/cio-oven/package.json.version-tmp', import.meta.url)
  const manifestText = await readFile(manifestUrl, 'utf8')
  const matches = [...manifestText.matchAll(VERSION_FIELD_PATTERN)]

  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error('Expected packages/cio-oven/package.json to contain exactly one version field.')
  }

  const currentVersion = matches[0][1]
  const nextVersion = incrementVersion(currentVersion)
  const updated = manifestText.replace(
    matches[0][0],
    matches[0][0].replace(currentVersion, nextVersion)
  )

  try {
    await writeFile(temporaryUrl, updated, 'utf8')
    await rename(temporaryUrl, manifestUrl)
  } finally {
    await rm(temporaryUrl, { force: true })
  }

  process.stdout.write(`cio-oven ${currentVersion} → ${nextVersion}\n`)
}

if (import.meta.main) {
  await bumpOvenCliVersion()
}
