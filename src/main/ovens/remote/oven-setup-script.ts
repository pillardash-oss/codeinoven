import {
  OVEN_MINIMUM_NODE_VERSION,
  OVEN_HARNESS_COMMANDS,
  ovenHarnessIdForCommand,
  type OvenHarnessCommand,
  type OvenPackageManager,
  type OvenPreflightAssessment,
  type OvenPrivilege,
  type OvenSetupConfiguration,
  type OvenSetupPhase,
  type OvenSetupStep
} from '../../../lib/ovens'
import {
  harnessUninstallCommand,
  preferredHarnessInstallChannel,
  type HarnessChannel
} from '../../agents/harness-install-service'
import { stepRequiresElevation } from '../oven-setup-capabilities'
import { OVEN_SETUP_SCRIPT_VERSION, planNodeInstall } from '../oven-setup-bootstrap'

/**
 * One external command, kept as structured argv so it is quoted once at the SSH
 * boundary instead of interpolated into a shell string here.
 */
export interface SetupCommand {
  command: string
  args: string[]
  /** Needs administrator or sudo. A refusal blocks the step instead of skipping it. */
  elevated: boolean
  /**
   * True when an interrupted run cannot be assumed either way, so recovery must
   * re-observe the Oven before treating the step as done.
   */
  uncertainWhenInterrupted: boolean
}

export interface PlannedStep {
  id: string
  name: string
  phase: OvenSetupPhase
  requiresElevation: boolean
  commands: SetupCommand[]
  /** Run after the commands to decide success instead of trusting the exit code. */
  verify?: { command: string; args: string[] }
  detail?: string
  /** Shown instead of running when the step is not needed on this Oven. */
  skippedReason?: string
  /** The app, not the Oven shell, owns this step. */
  handledByApp?: boolean
  /** Clock step only: the zone this computer resolved at plan time. */
  timezoneZone?: string
}

export interface SetupPlan {
  version: number
  platform: string
  architecture: string
  packageManager: OvenPackageManager
  privilege: OvenPrivilege
  steps: PlannedStep[]
  /** Blockers that stop setup before it mutates anything. */
  blockers: string[]
  /** Non-blocking notices such as a pending OS update or a required reboot. */
  notices: string[]
}

const ELEVATED_OK: readonly OvenPrivilege[] = ['root', 'passwordless-sudo']

function needsElevation(privilege: OvenPrivilege, elevated: boolean): boolean {
  return elevated && !ELEVATED_OK.includes(privilege)
}

function command(
  name: string,
  args: string[],
  options: { elevated?: boolean; uncertain?: boolean } = {}
): SetupCommand {
  return {
    command: name,
    args,
    elevated: options.elevated ?? false,
    uncertainWhenInterrupted: options.uncertain ?? true
  }
}

/**
 * Registry refresh plus upgrade, per package manager. Never an OS release
 * upgrade, never a reboot, and never a `dist-upgrade`.
 */
function packageCommands(
  manager: OvenPackageManager,
  privilege: OvenPrivilege
): { commands: SetupCommand[]; notice?: string } {
  const elevated = privilege !== 'root'
  const releaseNotice =
    'Only packages are upgraded. CodeInOven never upgrades the operating-system release and never reboots the Oven.'
  switch (manager) {
    case 'apt':
      return {
        commands: [
          command('apt-get', ['update'], { elevated }),
          command('apt-get', ['upgrade', '-y'], { elevated })
        ],
        notice: `apt-get upgrade, not dist-upgrade. ${releaseNotice}`
      }
    case 'dnf':
      return {
        commands: [command('dnf', ['upgrade', '-y'], { elevated })],
        notice: releaseNotice
      }
    case 'yum':
      return {
        commands: [command('yum', ['update', '-y'], { elevated })],
        notice: releaseNotice
      }
    case 'pacman':
      return {
        commands: [command('pacman', ['-Syu', '--noconfirm'], { elevated })],
        notice: releaseNotice
      }
    case 'zypper':
      return {
        commands: [
          command('zypper', ['--non-interactive', 'refresh'], { elevated }),
          command('zypper', ['--non-interactive', 'update', '-y'], { elevated })
        ],
        notice: `zypper updates installed packages only. ${releaseNotice}`
      }
    case 'brew':
      return {
        commands: [
          command('brew', ['update'], { elevated: false }),
          command('brew', ['upgrade'], { elevated: false })
        ],
        notice: `Homebrew upgrades formulae only. ${releaseNotice}`
      }
    case 'winget':
      return {
        commands: [
          command(
            'winget',
            ['upgrade', '--all', '--accept-source-agreements', '--disable-interactivity'],
            {
              elevated: false
            }
          )
        ],
        notice: `winget upgrades packages only. ${releaseNotice}`
      }
    case 'choco':
      return {
        commands: [command('choco', ['upgrade', 'all', '-y'], { elevated: false })],
        notice: `Chocolatey upgrades packages only. ${releaseNotice}`
      }
    case 'scoop':
      return {
        commands: [
          command('scoop', ['update'], { elevated: false }),
          command('scoop', ['update', '*'], { elevated: false })
        ]
      }
    case 'unknown':
    default:
      return { commands: [] }
  }
}

/** Documented install command for git or curl, used only when the Oven lacks it. */
function toolInstallCommands(
  tool: 'git' | 'curl',
  platform: string,
  manager: OvenPackageManager,
  privilege: OvenPrivilege
): SetupCommand[] {
  const elevated = privilege !== 'root'
  switch (manager) {
    case 'apt':
      return [command('apt-get', ['install', '-y', tool], { elevated })]
    case 'dnf':
    case 'yum':
      return [command(manager, ['install', '-y', tool], { elevated })]
    case 'zypper':
      return [command('zypper', ['--non-interactive', 'install', '-y', tool], { elevated })]
    case 'pacman':
      return [command('pacman', ['-S', '--noconfirm', tool], { elevated })]
    case 'brew':
      return [command('brew', ['install', tool])]
    case 'winget':
      return tool === 'git'
        ? [command('winget', ['install', '--id', 'Git.Git', '-e', '--accept-source-agreements'])]
        : [command('winget', ['install', '--id', 'cURL.cURL', '-e', '--accept-source-agreements'])]
    case 'choco':
      return [command('choco', ['install', tool === 'git' ? 'git.install' : 'curl', '-y'])]
    case 'scoop':
      return [command('scoop', ['install', tool])]
    default:
      // curl is the only tool CodeInOven can bootstrap on an unmanaged Linux
      // host without a package manager, and only when already root.
      return platform === 'linux' && tool === 'curl' && privilege === 'root'
        ? [command('apt-get', ['install', '-y', 'curl'], { elevated: false })]
        : []
  }
}

/** Install npm when Node exists but its package manager does not. */
function npmInstallCommands(manager: OvenPackageManager, privilege: OvenPrivilege): SetupCommand[] {
  const elevated = privilege !== 'root'
  switch (manager) {
    case 'apt':
      return [command('apt-get', ['install', '-y', 'npm'], { elevated })]
    case 'dnf':
    case 'yum':
      return [command(manager, ['install', '-y', 'npm'], { elevated })]
    case 'pacman':
      return [command('pacman', ['-S', '--noconfirm', 'npm'], { elevated })]
    case 'zypper':
      return [command('zypper', ['--non-interactive', 'install', '-y', 'npm'], { elevated })]
    case 'brew':
      return [command('brew', ['install', 'node@22'])]
    case 'winget':
      return [command('winget', ['install', '--id', 'OpenJS.NodeJS.LTS', '-e'])]
    case 'choco':
      return [command('choco', ['install', 'nodejs-lts', '-y'])]
    case 'scoop':
      return [command('scoop', ['install', 'nodejs-lts'])]
    default:
      return []
  }
}

/** Documented in-place upgrade command, when the harness publishes one. */
function upgradeCommandsFor(
  harnessId: string,
  platform: NodeJS.Platform
): { command: string; args: string[] }[] | undefined {
  if (platform === 'win32' && harnessId === 'claude-code')
    return [{ command: 'winget', args: ['upgrade', '--id', 'Anthropic.ClaudeCode', '-e'] }]
  return undefined
}

export interface HarnessPlanResult {
  commands: SetupCommand[]
  channel: HarnessChannel | undefined
  skippedReason?: string
}

/**
 * Install or update one harness on the Oven using the same documented channels
 * the Local installer uses, so a harness can never be reported as supported by
 * preflight and then skipped by execution.
 */
export function harnessInstallCommands(input: {
  command: OvenHarnessCommand
  platform: string
  installedVersion: string | null
  shouldInstall: boolean
  shouldUpdate: boolean
}): HarnessPlanResult {
  const harnessId = ovenHarnessIdForCommand(input.command)
  if (!harnessId)
    return { commands: [], channel: undefined, skippedReason: 'not a registered harness' }
  if (!input.shouldInstall && !input.shouldUpdate)
    return { commands: [], channel: undefined, skippedReason: 'not selected for this setup' }
  const channel = preferredHarnessInstallChannel(harnessId, input.platform as NodeJS.Platform)
  if (!channel?.command || !channel.args)
    return {
      commands: [],
      channel,
      skippedReason: 'no one-command documented install channel for this platform'
    }
  if (input.installedVersion) {
    if (!input.shouldUpdate)
      return {
        commands: [],
        channel,
        skippedReason: `already installed (${input.installedVersion})`
      }
    const upgrade = upgradeCommandsFor(harnessId, input.platform as NodeJS.Platform)
    if (upgrade)
      return { commands: upgrade.map((entry) => command(entry.command, entry.args)), channel }
    // Most of these CLIs document their install channel as the update path, so
    // re-running it is the published upgrade rather than an invention.
  }
  return { commands: [command(channel.command, channel.args)], channel }
}

/** Documented uninstall command for one harness, used by harness management. */
export function harnessUninstallCommands(
  harnessId: string,
  method: string
): { command: string; args: string[]; destructive: boolean } | undefined {
  const entry = harnessUninstallCommand(
    harnessId,
    method as Parameters<typeof harnessUninstallCommand>[1]
  )
  if (!entry) return undefined
  return {
    command: entry.command,
    args: entry.args,
    // Native removals delete the harness's own configuration directory, which is
    // exactly why the UI requires an explicit confirmation before running one.
    destructive: method === 'native'
  }
}

function harnessStep(
  harnessId: string,
  assessment: OvenPreflightAssessment,
  configuration: OvenSetupConfiguration
): PlannedStep | undefined {
  const command_ = OVEN_HARNESS_COMMANDS.find(
    (candidate) => ovenHarnessIdForCommand(candidate) === harnessId
  )
  if (!command_) return undefined
  const selection = configuration.selectedHarnesses.find((entry) => entry.harnessId === harnessId)
  const observation = assessment.harnesses.find((entry) => entry.command === command_)
  const result = harnessInstallCommands({
    command: command_,
    platform: assessment.platform,
    installedVersion: observation?.installedVersion ?? null,
    shouldInstall: selection?.install !== false,
    shouldUpdate: selection?.update !== false
  })
  return {
    id: `harness:${command_}`,
    name: observation?.name ?? command_,
    phase: 'harnesses',
    requiresElevation: false,
    commands: result.commands,
    verify: { command: command_, args: ['--version'] },
    ...(result.channel?.pageUrl
      ? {
          detail: `Installed with ${result.channel.method}. Official instructions: ${result.channel.pageUrl}`
        }
      : {}),
    ...(result.skippedReason ? { skippedReason: result.skippedReason } : {})
  }
}

/**
 * Match the Oven's clock to this computer: its absolute time and its zone.
 *
 * The step is app-owned rather than a shell command because the zone has to be
 * read back from the Oven to be trusted, and because a platform that cannot
 * express the zone must be skipped with its reason rather than failing a setup
 * that is otherwise complete.
 *
 * A matching zone never skips this step: `apt` compares mirror release
 * timestamps against the Oven's absolute clock, so an Oven already on the right
 * zone can still be hours behind and reject every repository. The step reads the
 * clock and corrects it only when it is genuinely off, so running it always is
 * cheap and is the only thing that catches a clock that drifted under the zone.
 */
function timezoneStep(assessment: OvenPreflightAssessment, deviceZone: string | null): PlannedStep {
  const base = {
    id: 'timezone',
    name: 'Match the Oven clock',
    phase: 'prerequisites' as const,
    requiresElevation: stepRequiresElevation('timezone', assessment.privilege),
    commands: [],
    handledByApp: true
  }
  if (!deviceZone)
    return {
      ...base,
      requiresElevation: false,
      detail: 'This computer did not report a time zone.',
      skippedReason: 'This computer did not report a time zone.'
    }
  if (assessment.timezone.method === 'unsupported')
    return {
      ...base,
      requiresElevation: false,
      detail: 'The Oven reports no supported way to change its clock zone.',
      skippedReason: 'The Oven reports no supported way to change its clock zone.'
    }
  const zoneMatches = assessment.platform !== 'win32' && assessment.timezone.current === deviceZone
  return {
    ...base,
    timezoneZone: deviceZone,
    detail: zoneMatches
      ? `The Oven already runs on ${deviceZone}; checks its absolute clock against this computer.`
      : `Sets the Oven clock to ${deviceZone}, this computer's time zone.`
  }
}

/**
 * Build the whole setup plan for one oven.
 *
 * Pure by construction: the same assessment, configuration, and device time zone
 * always produce the same plan, which is what lets a resumed operation compare
 * its stored plan against the one it would build now and refuse to continue when
 * they differ.
 */
export function buildSetupPlan(
  assessment: OvenPreflightAssessment,
  configuration: OvenSetupConfiguration,
  deviceTimezone: string | null = null
): SetupPlan {
  const platform = assessment.platform
  const privilege = assessment.privilege
  const steps: PlannedStep[] = []
  const bootstrapSteps: PlannedStep[] = []
  const blockers: string[] = []
  const notices: string[] = []
  for (const issue of assessment.issues) {
    if (issue.blocking) blockers.push(issue.message)
    else if (issue.code === 'os-update-pending' || issue.code === 'reboot-required')
      notices.push(issue.message)
  }

  /* Phase: preflight. The only phase that never mutates anything. */
  steps.push({
    id: 'preflight',
    name: 'Confirm oven state',
    phase: 'preflight',
    requiresElevation: false,
    commands: [],
    detail:
      'Confirms the Oven state this setup was authorized against, re-reading it only when the check is no longer fresh.',
    handledByApp: true
  })

  /* Phase: bootstrap. A Node runtime must exist before the service can run. */
  const nodeMissing =
    !assessment.nodeVersion || !/^v?22\.|^v?(?:2[3-9]|[3-9]\d)\./u.test(assessment.nodeVersion)
  if (nodeMissing) {
    const plan = planNodeInstall(
      platform,
      assessment.architecture,
      assessment.packageManager,
      privilege
    )
    bootstrapSteps.push({
      id: 'node',
      name: `Install Node.js ${OVEN_MINIMUM_NODE_VERSION}+`,
      phase: 'bootstrap',
      requiresElevation: needsElevation(
        privilege,
        plan.commands.some((entry) => entry.elevated)
      ),
      commands: plan.commands.map((entry) =>
        command(entry.command, entry.args, { elevated: entry.elevated })
      ),
      verify: { command: 'node', args: ['--version'] },
      detail: plan.detail,
      ...(plan.commands.length === 0 ? { skippedReason: plan.detail } : {})
    })
    if (plan.commands.length === 0) blockers.push(plan.detail)
  } else {
    bootstrapSteps.push({
      id: 'node',
      name: 'Check Node.js',
      phase: 'bootstrap',
      requiresElevation: false,
      commands: [],
      verify: { command: 'node', args: ['--version'] },
      detail: `The Oven already runs Node.js ${assessment.nodeVersion}.`,
      skippedReason: `Node.js ${assessment.nodeVersion} meets the service requirement.`
    })
  }

  /* Phase: prerequisites. The clock is matched before any package work:
     `apt` compares mirror release timestamps against the Oven's absolute clock,
     so a clock running behind rejects the very repositories a refresh needs. */
  steps.push(timezoneStep(assessment, deviceTimezone))

  /* Phase: prerequisites. Package upgrades are authorized only by Start setup. */
  const packages = packageCommands(assessment.packageManager, privilege)
  if (configuration.packageUpgrades) {
    steps.push({
      id: 'packages',
      name: 'Upgrade oven packages',
      phase: 'prerequisites',
      requiresElevation: stepRequiresElevation('packages', privilege),
      commands: packages.commands,
      detail: packages.notice,
      ...(packages.commands.length === 0
        ? {
            skippedReason:
              'CodeInOven does not manage packages with this package manager. Install what the Oven needs yourself.'
          }
        : {})
    })
    if (packages.commands.length === 0)
      blockers.push('No supported package upgrade process was detected on this Oven.')
  } else {
    steps.push({
      id: 'packages',
      name: 'Upgrade oven packages',
      phase: 'prerequisites',
      requiresElevation: false,
      commands: [],
      skippedReason: 'Package upgrades were not requested for this setup.'
    })
  }
  if (packages.notice) notices.push(packages.notice)

  // Package registry refresh and package upgrades run after the clock is matched,
  // so a skewed Oven clock cannot reject the repositories they depend on.
  for (const tool of ['git', 'curl'] as const) {
    const missing = assessment.issues.some((issue) => issue.code === `missing-${tool}`)
    const commands = missing
      ? toolInstallCommands(tool, platform, assessment.packageManager, privilege)
      : []
    steps.push({
      id: tool,
      name: `Check ${tool}`,
      phase: 'prerequisites',
      requiresElevation: commands.some((entry) => entry.elevated),
      commands,
      verify: { command: tool, args: ['--version'] },
      detail: missing ? `${tool} is not installed on this Oven.` : `${tool} is installed.`,
      ...(missing ? {} : { skippedReason: `${tool} is installed.` })
    })
    if (missing && commands.length === 0)
      blockers.push(`Cannot install ${tool} automatically with the detected package manager.`)
  }

  steps.push(...bootstrapSteps)

  const npmMissing = assessment.issues.some((issue) => issue.code === 'npm-missing')
  if (npmMissing) {
    const commands = npmInstallCommands(assessment.packageManager, privilege)
    steps.push({
      id: 'npm',
      name: 'Install npm',
      phase: 'prerequisites',
      requiresElevation: commands.some((entry) => entry.elevated),
      commands,
      verify: { command: 'npm', args: ['--version'] },
      detail: 'npm is missing from this Node.js installation.',
      ...(commands.length === 0
        ? { skippedReason: 'Install npm on the Oven, then retry setup.' }
        : {})
    })
    if (commands.length === 0)
      blockers.push('npm is missing and cannot be installed with the detected package manager.')
  }

  /* Phase: harnesses. One step per selection so a retry resumes exactly. */
  for (const selection of configuration.selectedHarnesses) {
    const planned = harnessStep(selection.harnessId, assessment, configuration)
    if (planned) {
      steps.push(planned)
      if (planned.skippedReason)
        blockers.push(`${planned.name} cannot be installed: ${planned.skippedReason}.`)
    }
  }

  /* Phase: accounts. The app, not the Oven shell, owns this one. */
  const syncingAccounts =
    configuration.synchronizeAccounts || configuration.synchronizeConfiguration
  steps.push({
    id: 'accounts',
    name: 'Synchronize accounts and configuration',
    phase: 'accounts',
    requiresElevation: false,
    commands: [],
    handledByApp: true,
    detail: configuration.synchronizeConfiguration
      ? 'Selected harness credentials and portable settings, models, and tools are copied into the Oven.'
      : 'Only selected harness credentials are copied into the Oven.',
    ...(syncingAccounts ? {} : { skippedReason: 'Account synchronization is off for this setup.' })
  })

  /* Phase: git. The dedicated identity is transferred through the vault. */
  steps.push({
    id: 'git-identity',
    name: 'Configure the Git SSH identity',
    phase: 'git',
    requiresElevation: false,
    commands: [],
    handledByApp: true,
    detail: configuration.git.enabled
      ? 'The dedicated key is written to the Oven with owner-only permissions and verified against GitHub over SSH.'
      : 'Git identity setup is off for this setup.',
    ...(configuration.git.enabled ? {} : { skippedReason: 'Disabled for this setup.' })
  })

  /* Phase: finalize. Refresh the service, then read the result back. */
  steps.push({
    id: 'service',
    name: 'Refresh the Oven service',
    phase: 'finalize',
    requiresElevation: false,
    commands: [],
    handledByApp: true,
    detail: 'Installs the current CodeInOven service so the Oven matches this app version.'
  })
  steps.push({
    id: 'verify',
    name: 'Verify the oven',
    phase: 'finalize',
    requiresElevation: false,
    commands: [],
    handledByApp: true,
    detail: 'Reads every harness version back from the Oven and reports what is still missing.'
  })

  return {
    version: OVEN_SETUP_SCRIPT_VERSION,
    platform,
    architecture: assessment.architecture,
    packageManager: assessment.packageManager,
    privilege,
    steps,
    blockers,
    notices
  }
}

/** Convert a plan into the persisted, non-secret step list the renderer renders. */
export function plannedStepsToSetupSteps(plan: SetupPlan): OvenSetupStep[] {
  return plan.steps.map((planned) => ({
    id: planned.id,
    name: planned.name,
    status: planned.skippedReason ? 'skipped' : 'pending',
    ...(planned.skippedReason ? { skippedReason: planned.skippedReason } : {}),
    ...(planned.detail ? { detail: planned.detail } : {}),
    ...(planned.requiresElevation ? { requiresElevation: true } : {})
  }))
}
