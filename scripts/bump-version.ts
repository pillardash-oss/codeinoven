import { readFile, rename, rm, writeFile } from 'node:fs/promises'

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/
const VERSION_FIELD_PATTERN = /"version"\s*:\s*"([^"]+)"/g

export function incrementVersion(version: string): string {
  const match = VERSION_PATTERN.exec(version)
  if (!match) {
    throw new TypeError(
      `Invalid package version "${version}". Expected major.minor.patch with minor and patch between 0 and 99.`
    )
  }

  let major = Number(match[1])
  let minor = Number(match[2])
  let patch = Number(match[3]) + 1

  if (patch === 100) {
    patch = 0
    minor += 1
  }
  if (minor === 100) {
    minor = 0
    major += 1
  }

  return `${major}.${minor}.${patch}`
}

async function writeJsonVersion(fileUrl: URL, nextVersion: string): Promise<void> {
  const temporaryUrl = new URL(`${fileUrl.pathname}.version-tmp`, import.meta.url)
  const text = await readFile(fileUrl, 'utf8')
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Expected ${fileUrl.pathname} to contain valid JSON.`)
  }
  data.version = nextVersion
  const updated = `${JSON.stringify(data, null, 2)}\n`
  try {
    await writeFile(temporaryUrl, updated, 'utf8')
    await rename(temporaryUrl, fileUrl)
  } finally {
    await rm(temporaryUrl, { force: true })
  }
}

async function bumpPackageVersion(): Promise<void> {
  const packageUrl = new URL('../package.json', import.meta.url)
  const temporaryUrl = new URL('../package.json.version-tmp', import.meta.url)
  const packageText = await readFile(packageUrl, 'utf8')
  const matches = [...packageText.matchAll(VERSION_FIELD_PATTERN)]

  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error('Expected package.json to contain exactly one version field.')
  }

  const currentVersion = matches[0][1]
  const nextVersion = incrementVersion(currentVersion)
  const updatedPackage = packageText.replace(
    matches[0][0],
    matches[0][0].replace(currentVersion, nextVersion)
  )

  try {
    await writeFile(temporaryUrl, updatedPackage, 'utf8')
    await rename(temporaryUrl, packageUrl)
  } finally {
    await rm(temporaryUrl, { force: true })
  }

  // Keep PWA manifest and remote-control package versions in sync
  // with the desktop app version so all deployable units share one version.
  const manifestUrl = new URL('../src/renderer/static/manifest.webmanifest', import.meta.url)
  await writeJsonVersion(manifestUrl, nextVersion)

  const remotePackageUrl = new URL('../services/remote-control/package.json', import.meta.url)
  await writeJsonVersion(remotePackageUrl, nextVersion)

  process.stdout.write(`${currentVersion} → ${nextVersion}\n`)
}

if (import.meta.main) {
  await bumpPackageVersion()
}
