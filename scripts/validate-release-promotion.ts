const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parseVersion(value: string, label: string): [number, number, number] {
  const match = VERSION_PATTERN.exec(value)
  if (!match) throw new TypeError(`${label} must be a stable major.minor.patch version`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function validateReleasePromotion(input: {
  baseBranch: string
  headBranch: string
  baseVersion: string
  currentVersion: string
}): void {
  const expectedHead =
    input.baseBranch === 'nightly' ? 'dev' : input.baseBranch === 'main' ? 'nightly' : null
  if (!expectedHead) return
  if (input.headBranch !== expectedHead) {
    throw new Error(
      `Pull requests into ${input.baseBranch} must come from ${expectedHead}, not ${input.headBranch}`
    )
  }

  const baseVersion = parseVersion(input.baseVersion, 'Base package version')
  const currentVersion = parseVersion(input.currentVersion, 'Pull request package version')
  if (input.baseBranch === 'nightly') {
    // Cohesive tagging: dev == nightly base, nightly tags are v{base}-nightly-{N}
    if (compareVersions(currentVersion, baseVersion) !== 0) {
      throw new Error(
        `package.json version must equal nightly base for ${input.headBranch} → ${input.baseBranch} ` +
          `(${input.baseVersion} → ${input.currentVersion}); ` +
          `nightly tags are v\${base}-nightly-{N} without bumping package.json`
      )
    }
    return
  }
  // main promotion: current must be exactly one patch ahead of base (e.g. 0.5.50 → 0.5.51)
  if (compareVersions(currentVersion, baseVersion) <= 0) {
    throw new Error(
      `package.json version must increase for ${input.headBranch} → ${input.baseBranch} ` +
        `(${input.baseVersion} → ${input.currentVersion})`
    )
  }
}

if (import.meta.main) {
  const baseBranch = process.env['BASE_BRANCH'] ?? ''
  const headBranch = process.env['HEAD_BRANCH'] ?? ''
  const baseVersion = process.env['BASE_VERSION'] ?? ''
  const currentVersion = process.env['CURRENT_VERSION'] ?? ''
  validateReleasePromotion({ baseBranch, headBranch, baseVersion, currentVersion })
  process.stdout.write(
    `Valid release promotion: ${headBranch} (${currentVersion}) → ${baseBranch} (${baseVersion})\n`
  )
}
