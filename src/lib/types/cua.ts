import type { ProviderStatus } from './provider'

export type CuaPermissionStatus = 'granted' | 'missing' | 'unknown' | 'not_required'

export type CuaInstallationSource =
  'environment' | 'application' | 'canonical' | 'homebrew' | 'path'

export interface CuaInstallation {
  path: string
  realPath: string
  aliases: string[]
  source: CuaInstallationSource
  version?: string
  compatible: boolean
  appBundle: boolean
  selected: boolean
}

/**
 * A newer Cua Driver release, as reported by the installed driver's own release
 * check (`cua-driver check-update --json`). The driver owns the GitHub round
 * trip and caches the answer on disk for 20 hours, so this stays cheap to ask.
 */
export interface CuaUpdateCheck {
  /** Version the selected installation reports right now. */
  currentVersion: string
  /** Newest release on the update channel the driver follows. */
  latestVersion: string
  updateAvailable: boolean
  /** True when the driver answered from its own cache instead of GitHub. */
  cached: boolean
  /** Update channel the driver follows, e.g. `stable`. */
  channel?: string
  /** When the driver last asked GitHub, not when the app last asked the driver. */
  checkedAt?: string
  releaseNotesUrl?: string
  /** The installer command Cua publishes, kept as a manual fallback. */
  installCommand?: string
}

/** Live progress of an in-app Cua Driver update. */
export interface CuaUpdateProgress {
  state: 'updating' | 'installed' | 'failed'
  /** Milestone the update is on, straight from Cua's own installer. */
  detail?: string
  /** Human-readable failure reason, set only when `state` is `failed`. */
  error?: string
  /** Version now on disk, set only when `state` is `installed`. */
  version?: string
}

/** Renderer-safe state for the optional, externally installed Cua Driver bridge. */
export interface CuaBridgeStatus {
  enabled: boolean
  installed: boolean
  compatible: boolean
  ready: boolean
  mcpAvailable: boolean
  daemonRunning: boolean
  targetVersion: string
  supportedVersionRange: string
  architecture: 'arm64' | 'x64' | 'unsupported'
  downloadLabel: string
  downloadName?: string
  version?: string
  binaryPath?: string
  updateCommand?: string
  installations: CuaInstallation[]
  platform: 'macos' | 'windows' | 'linux' | 'unsupported'
  permissionStatus: CuaPermissionStatus
  installUrl: string
  documentationUrl: string
  updateUrl: string
  permissionsUrl: string
  repositoryUrl: string
  detail?: string
}

/** Cursor position projected into the dimensions of a computer-use PiP frame. */
export interface ComputerUsePipCursor {
  visible: boolean
  x: number
  y: number
}

/** One rendered frame of the app an agent is driving, pushed to the renderer. */
export interface ComputerUsePipFrame {
  pid: number
  appName: string
  windowId: number
  dataUrl: string
  width: number
  height: number
  timestamp: number
  cursor?: ComputerUsePipCursor
}

/** Live state of the computer-use PiP monitor. */
export interface ComputerUsePipState {
  active: boolean
  pid?: number
  appName?: string
  /** Id of the thread whose agent is driving the tracked app, when active. */
  threadId?: string
}

/**
 * One thread's computer-use activity, mirrored to the renderer so a thread row
 * can show the cursor indicator while its agent drives an app.
 *
 * Deliberately independent of the PiP: the PiP needs a window to track, while
 * an agent that escalated to desktop scope (`get_desktop_state`,
 * `escalate_session`, a desktop `hotkey`) has no pid at all yet is still very
 * much using the computer. A `ComputerUseActivity` is therefore emitted for
 * every computer-use operation, pid or not.
 */
export interface ComputerUseActivity {
  threadId: string
  /** Whether the thread's agent is still driving the computer. */
  active: boolean
  /** Wall-clock time of this thread's most recent computer-use action. */
  at: number
  /** Target process, when the action named one. */
  pid?: number
  /** Driver operation that most recently ran, e.g. `drag`. */
  operation?: string
}

export interface SessionConfig {
  command: string
  args: string[]
  projectPath: string
  env?: Record<string, string>
}

export interface AdapterSession {
  id: string
  providerId: string
  status: ProviderStatus
  createdAt: number
}
