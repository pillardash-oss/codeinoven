import { DEFAULT_AGENT_BEHAVIOR_PROMPT } from '$shared/agent-behavior'
import { DEFAULT_SPEECH_SETTINGS } from '$shared/speech/types'
import {
  DEFAULT_MAX_CONFLICT_FILE_BYTES,
  DEFAULT_IN_APP_NOTIFICATION_SOUND,
  type AppConfig
} from '$shared/types'

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
  agentQuestionCap: 3,
  keybindings: {},
  slashCommandMode: 'app',
  preferredEditor: 'system',
  memory: { enabled: true, chatEnabled: true, entries: [] },
  agentDefaults: { syncFromThreadChanges: false },
  auxiliaryAgents: {},
  rankingJudge: { kind: 'automatic' },
  agentBehaviorPrompt: DEFAULT_AGENT_BEHAVIOR_PROMPT,
  autoDownloadUpdates: true,
  autoInstallUpdates: true,
  updateChannel: 'stable',
  keepAwakeWhileWorking: false,
  imageDescriptorAskAgain: false,
  autoRetryAfterReset: true,
  resumeWorkOnRestart: true,
  defaultMergeMethod: 'squash',
  defaultPullStrategy: 'ask',
  maxDiffLines: 100,
  maxConflictFileBytes: DEFAULT_MAX_CONFLICT_FILE_BYTES,
  openLocalhostInCioBrowser: true,
  inAppNotificationSound: { ...DEFAULT_IN_APP_NOTIFICATION_SOUND },
  sound: structuredClone(DEFAULT_SPEECH_SETTINGS)
}
