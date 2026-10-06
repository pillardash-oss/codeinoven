import {
  OVEN_MINIMUM_NODE_VERSION,
  ovenHarnessIdForCommand,
  type OvenHarnessPreflight,
  type OvenPreflightAssessment,
  type OvenPreflightIssue,
  type OvenPreflightReport,
  type OvenPackageManager
} from '../../lib/ovens'

/** Every platform CodeInOven can set up. Anything else is recorded, not attempted. */
export const OVEN_SETUP_PLATFORMS = ['linux', 'darwin', 'win32'] as const

export type OvenSetupPlatform = (typeof OVEN_SETUP_PLATFORMS)[number]

/**
 * Architectures with a verified setup path. 32-bit targets are absent: the oven
 * service and every documented harness channel assume a 64-bit host.
 */
const SUPPORTED_ARCHITECTURES: Record<string, readonly string[]> = {
  linux: ['x64', 'arm64'],
  darwin: ['x64', 'arm64'],
  win32: ['x64', 'arm64']
}

export function isSetupPlatform(value: string): value is OvenSetupPlatform {
  return (OVEN_SETUP_PLATFORMS as readonly string[]).includes(value)
}

export function isSupportedArchitecture(platform: string, architecture: string): boolean {
  return SUPPORTED_ARCHITECTURES[platform]?.includes(architecture) ?? false
}

/** Package managers CodeInOven can drive, in the order setup prefers them. */
const PACKAGE_MANAGER_PROBES: readonly { manager: OvenPackageManager; command: string }[] = [
  { manager: 'brew', command: 'brew' },
  { manager: 'winget', command: 'winget' },
  { manager: 'apt', command: 'apt-get' },
  { manager: 'dnf', command: 'dnf' },
  { manager: 'yum', command: 'yum' },
  { manager: 'pacman', command: 'pacman' },
  { manager: 'zypper', command: 'zypper' },
  { manager: 'scoop', command: 'scoop' },
  { manager: 'choco', command: 'choco' }
]

/** Resolve a detected package-manager command name to a driver we support. */
export function resolvePackageManager(command: string | null | undefined): OvenPackageManager {
  if (!command) return 'unknown'
  return PACKAGE_MANAGER_PROBES.find((probe) => probe.command === command)?.manager ?? 'unknown'
}

/** Compare dotted version strings. Missing or unparsable components sort as 0. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = Number.parseInt(a[index] ?? '0', 10)
    const y = Number.parseInt(b[index] ?? '0', 10)
    const diff = (Number.isFinite(x) ? x : 0) - (Number.isFinite(y) ? y : 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/** True when the reported Node.js satisfies the oven service runtime requirement. */
export function nodeSatisfiesServiceRequirement(version: string | null): boolean {
  if (!version) return false
  const match = /^v?(\d+)\./u.exec(version.trim())
  if (!match) return false
  const major = Number.parseInt(match[1], 10)
  return Number.isFinite(major) && major >= OVEN_MINIMUM_NODE_VERSION
}

/**
 * Give every observed harness a health verdict. A harness is only healthy when
 * the oven resolved its executable and got a version back, so a present-but-dead
 * binary reads as broken rather than installed.
 */
export function assessHarnesses(observed: readonly OvenHarnessPreflight[]): OvenHarnessPreflight[] {
  return observed.map((harness) => {
    if (!harness.supported) {
      return {
        ...harness,
        health: 'unsupported' as const,
        issueCategory: 'unsupported-platform' as const
      }
    }
    if (harness.installedVersion === 'broken') {
      return {
        ...harness,
        installedVersion: null,
        health: 'broken' as const,
        issueCategory: 'broken-executable' as const
      }
    }
    if (harness.executablePath && harness.installedVersion)
      return { ...harness, health: 'healthy' as const, issueCategory: undefined }
    if (harness.executablePath && harness.installedVersion === null)
      return {
        ...harness,
        health: 'broken' as const,
        issueCategory: 'broken-executable' as const
      }
    return { ...harness, health: 'missing' as const, issueCategory: 'not-installed' as const }
  })
}

/**
 * Compute the setup verdict for an observed oven. Pure: the same report always
 * yields the same assessment, which is what lets setup treat a persisted
 * preflight as still valid until the oven is re-observed.
 */
export function assessPreflight(report: OvenPreflightReport): OvenPreflightAssessment {
  const issues: OvenPreflightIssue[] = []
  const platformSupported = isSetupPlatform(report.platform)
  const architectureSupported = isSupportedArchitecture(report.platform, report.architecture)

  if (!platformSupported)
    issues.push({
      code: 'unsupported-platform',
      message: `CodeInOven cannot set up this Oven (${report.osName}). Setup supports Linux, macOS, and native Windows.`,
      blocking: true
    })
  if (!architectureSupported)
    issues.push({
      code: 'unsupported-architecture',
      message: `${report.architecture} is not a verified Oven architecture. Setup supports x64 and arm64.`,
      blocking: true
    })

  const packageManagerSupported = report.packageManager !== 'unknown'
  if (platformSupported && !packageManagerSupported)
    issues.push({
      code: 'unknown-package-manager',
      message:
        'CodeInOven does not know how to upgrade packages on this Oven. Install Node.js 22 or later yourself, then run setup again.',
      blocking: false
    })

  if (!report.git.installed)
    issues.push({
      code: 'missing-git',
      message: 'Git is required on the Oven to clone and update project repositories.',
      blocking: false
    })
  if (!report.curl.installed)
    issues.push({
      code: 'missing-curl',
      message: 'curl is required on the Oven to download Node.js and native harnesses.',
      blocking: false
    })
  if (!report.node.installed)
    issues.push({
      code: 'node-missing',
      message: `Node.js ${OVEN_MINIMUM_NODE_VERSION} or later is required to run the Oven service.`,
      blocking: false
    })
  else if (!nodeSatisfiesServiceRequirement(report.node.version))
    issues.push({
      code: 'node-too-old',
      message: `The Oven runs Node.js ${report.node.version ?? 'an unknown version'}. The Oven service needs Node.js ${OVEN_MINIMUM_NODE_VERSION} or later.`,
      blocking: false
    })
  if (report.node.installed && !report.npm.installed)
    issues.push({
      code: 'npm-missing',
      message: 'npm is required to install the selected harnesses from their npm channels.',
      blocking: false
    })

  if (report.osUpdateRequired)
    issues.push({
      code: 'os-update-pending',
      message:
        report.osUpdateDetail ??
        'This Oven has pending operating-system updates. CodeInOven never upgrades the OS release; update it yourself when convenient.',
      blocking: false
    })
  if (report.rebootRequired)
    issues.push({
      code: 'reboot-required',
      message:
        'This Oven needs a reboot before package changes take effect. Reboot it yourself, then run setup again.',
      blocking: false
    })

  const harnesses = assessHarnesses(report.harnesses)
  for (const harness of harnesses) {
    if (harness.health === 'unsupported' && harness.unsupportedReason)
      issues.push({
        code: 'harness-unsupported',
        message: `${harness.name} cannot be installed on this Oven: ${harness.unsupportedReason}`,
        blocking: false
      })
    if (harness.health === 'broken')
      issues.push({
        code: 'harness-broken',
        message: `${harness.name} is on the Oven but its executable does not answer. Repair or remove it, then run setup again.`,
        blocking: false
      })
  }

  const supported = platformSupported && architectureSupported
  return {
    ovenId: report.ovenId,
    checkedAt: report.checkedAt,
    platform: report.platform,
    architecture: report.architecture,
    osName: report.osName,
    supported,
    setupCapable: supported && packageManagerSupported,
    prerequisitesSatisfied:
      supported &&
      report.git.installed &&
      report.node.installed &&
      nodeSatisfiesServiceRequirement(report.node.version),
    issues,
    harnesses,
    packageManager: report.packageManager,
    privilege: report.privilege,
    nodeVersion: report.node.version,
    timezone: report.timezone,
    osUpdateRequired: report.osUpdateRequired,
    ...(report.osUpdateDetail ? { osUpdateDetail: report.osUpdateDetail } : {}),
    rebootRequired: report.rebootRequired
  }
}

/** Steps that cannot complete on this privilege level without the user elevating. */
export function stepRequiresElevation(
  stepId: string,
  privilege: OvenPreflightReport['privilege']
): boolean {
  if (privilege === 'root' || privilege === 'passwordless-sudo') return false
  return stepId === 'packages' || stepId === 'node' || stepId === 'timezone'
}

/** Build one harness observation row for a preflight report. */
export function harnessObservation(input: {
  command: string
  name: string
  channels: readonly string[]
  executablePath: string | null
  installedVersion: string | null
  supported: boolean
  unsupportedReason?: string
}): OvenHarnessPreflight {
  return {
    harnessId: ovenHarnessIdForCommand(input.command) ?? input.command,
    command: input.command,
    name: input.name,
    supported: input.supported,
    ...(input.unsupportedReason ? { unsupportedReason: input.unsupportedReason } : {}),
    channels: [...input.channels],
    executablePath: input.executablePath,
    installedVersion: input.installedVersion,
    health: 'unknown'
  }
}
