import {
  BrainCircuit,
  ChartColumn,
  Cloud,
  Globe,
  Info,
  Keyboard,
  MessageSquareCode,
  MonitorUp,
  Plug,
  Puzzle,
  Router,
  SlidersHorizontal,
  UsersRound,
  Volume2
} from '@lucide/svelte'
import type { SettingsSection } from './stores/renderer-recovery'

/**
 * A searchable destination inside Settings — either a whole section page
 * (the sidebar tabs) or a named block on one (e.g. the Git card on General).
 * This registry is the single source for the sidebar tab list and the
 * settings search spotlight.
 */
export interface SettingsSearchEntry {
  /** Unique entry id, used as the palette action id suffix (`settings:<id>`). */
  id: string
  /** The section page this destination lives on. */
  section: SettingsSection
  title: string
  description: string
  keywords: readonly string[]
  icon: typeof SlidersHorizontal
  /**
   * DOM id suffix of the block to reveal on the section page
   * (rendered as `settings-block-<blockId>`). Absent = the whole page.
   */
  blockId?: string
}

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  {
    id: 'general',
    section: 'general',
    title: 'General',
    description: 'Appearance, notifications, git, threads, and power defaults.',
    keywords: ['settings', 'preferences'],
    icon: SlidersHorizontal
  },
  {
    id: 'memory',
    section: 'memory',
    title: 'Memory',
    description: 'What the agent remembers across threads and projects.',
    keywords: ['remember', 'context'],
    icon: BrainCircuit
  },
  {
    id: 'audits',
    section: 'audits',
    title: 'Agents',
    description: 'Agent names, audits, and per-agent behavior.',
    keywords: ['workers', 'audit'],
    icon: UsersRound
  },
  {
    id: 'cio-prompts',
    section: 'cio-prompts',
    title: 'CIO Prompts',
    description: 'Prompts CodeInOven injects into agent sessions.',
    keywords: ['prompts', 'instructions'],
    icon: MessageSquareCode
  },
  {
    id: 'harnesses',
    section: 'harnesses',
    title: 'Harnesses',
    description: 'Agent harness connections and model providers.',
    keywords: ['providers', 'models', 'api keys'],
    icon: Plug
  },
  {
    id: 'utilities',
    section: 'utilities',
    title: 'Utilities',
    description: 'Installed utilities and the skills marketplace.',
    keywords: ['skills', 'marketplace', 'plugins'],
    icon: Puzzle
  },
  {
    id: 'gateways',
    section: 'gateways',
    title: 'Gateways',
    description: 'Gateway routing and endpoints.',
    keywords: ['routing', 'endpoints'],
    icon: Router
  },
  {
    id: 'computer-use',
    section: 'computer-use',
    title: 'Computer use',
    description: 'Bridge settings for computer-control agents.',
    keywords: ['cua', 'bridge', 'automation'],
    icon: MonitorUp
  },
  {
    id: 'sound',
    section: 'sound',
    title: 'Sound',
    description: 'Local speech models, dictation, cleanup, history, and spoken responses.',
    keywords: ['microphone', 'voice', 'asr', 'tts', 'recording', 'models', 'import', 'cleanup'],
    icon: Volume2
  },
  {
    id: 'keymap',
    section: 'keymap',
    title: 'Keymap',
    description: 'Keyboard shortcuts for every app action.',
    keywords: ['shortcuts', 'hotkeys', 'keyboard'],
    icon: Keyboard
  },
  {
    id: 'remote',
    section: 'remote',
    title: 'Remote',
    description: 'Remote access and pairing.',
    keywords: ['pairing', 'access'],
    icon: Globe
  },
  {
    id: 'cloud-deployments',
    section: 'cloud-deployments',
    title: 'Cloud Deployments',
    description: 'Cloud environments and deployments.',
    keywords: ['cloud', 'environments'],
    icon: Cloud
  },
  {
    id: 'profile',
    section: 'profile',
    title: 'Usage',
    description: 'Usage, quotas, and account profile.',
    keywords: ['quota', 'account', 'billing'],
    icon: ChartColumn
  },
  {
    id: 'about',
    section: 'about',
    title: 'About',
    description: 'Build information, storage, diagnostics, and updates.',
    keywords: ['version', 'build'],
    icon: Info
  },
  // ── Blocks on General ────────────────────────────────────────────────────
  {
    id: 'general-appearance',
    section: 'general',
    blockId: 'general-appearance',
    title: 'Appearance',
    description: 'Theme — follow the system or pick light or dark.',
    keywords: ['theme', 'light', 'dark', 'system'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-notifications',
    section: 'general',
    blockId: 'general-notifications',
    title: 'Notifications',
    description: 'System notification alerts and permission status.',
    keywords: ['alerts', 'permission', 'test'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-browser',
    section: 'general',
    blockId: 'general-browser',
    title: 'Browser',
    description: 'Open localhost links in CIO’s browser.',
    keywords: ['localhost', 'links'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-power',
    section: 'general',
    blockId: 'general-power',
    title: 'Power',
    description: 'Keep the device awake while work is in progress.',
    keywords: ['sleep', 'keep awake', 'battery'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-recovery',
    section: 'general',
    blockId: 'general-recovery',
    title: 'Recovery',
    description: 'Resume interrupted work and auto-resume after usage resets.',
    keywords: ['resume', 'restart', 'auto-resume', 'rate limit'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-git',
    section: 'general',
    blockId: 'general-git',
    title: 'Git',
    description: 'Default pull strategy, merge method, and maximum diff lines.',
    keywords: ['pull', 'merge', 'squash', 'rebase', 'fast-forward', 'diff'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-threads',
    section: 'general',
    blockId: 'general-threads',
    title: 'Threads',
    description: 'Thread limits, slash command behavior, and question timeout.',
    keywords: ['limit', 'slash commands', 'timeout'],
    icon: SlidersHorizontal
  },
  // ── Blocks on About ──────────────────────────────────────────────────────
  {
    id: 'about-storage',
    section: 'about',
    blockId: 'about-storage',
    title: 'Storage',
    description: 'Where all projects, threads, and history are stored.',
    keywords: ['data directory', 'disk'],
    icon: Info
  },
  {
    id: 'about-diagnostics',
    section: 'about',
    blockId: 'about-diagnostics',
    title: 'Diagnostics',
    description: 'Export a redacted failure report.',
    keywords: ['export', 'failure report', 'logs'],
    icon: Info
  },
  {
    id: 'about-updates',
    section: 'about',
    blockId: 'about-updates',
    title: 'Updates',
    description: 'Update channel, nightly builds, and auto-install.',
    keywords: ['nightly', 'auto-download', 'auto-install', 'channel'],
    icon: Info
  }
]
