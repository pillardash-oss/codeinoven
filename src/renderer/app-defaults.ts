import { DEFAULT_AGENT_BEHAVIOR_PROMPT } from '$shared/agent-behavior'
import { DEFAULT_SPEECH_SETTINGS } from '$shared/speech/types'
import type { AppConfig } from '$shared/types'

/** Baseline configuration used until the main process returns the persisted one. */
export const defaultConfig: AppConfig = {
  theme: 'system',
  fontFamily: 'jetbrains-mono',
  appFontSize: 15,
  fontWeight: 200,
  zoomLevel: 1,
  onboardingCompleted: false,
  threadLimit: 70,
  questionTimeoutMs: 300_000,
  keybindings: {},
  slashCommandMode: 'app',
  preferredEditor: 'system',
  memory: { enabled: true, chatEnabled: true, entries: [] },
  agentDefaults: { syncFromThreadChanges: false },
  auxiliaryAgents: {},
  agentBehaviorPrompt: DEFAULT_AGENT_BEHAVIOR_PROMPT,
  autoDownloadUpdates: true,
  autoInstallUpdates: true,
  updateChannel: 'stable',
  keepAwakeWhileWorking: false,
  keepAwakeWhileRemoteConnected: true,
  imageDescriptorAskAgain: false,
  autoRetryAfterReset: true,
  resumeWorkOnRestart: true,
  defaultMergeMethod: 'squash',
  defaultPullStrategy: 'ask',
  maxDiffLines: 100,
  openLocalhostInCioBrowser: true,
  sound: structuredClone(DEFAULT_SPEECH_SETTINGS)
}
