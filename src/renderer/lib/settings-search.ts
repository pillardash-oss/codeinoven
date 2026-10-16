import CioBrowser from '$lib/components/icons/cio/CioBrowser.svelte'
import CioCloud from '$lib/components/icons/cio/CioCloud.svelte'
import CioDownload from '$lib/components/icons/cio/CioDownload.svelte'
import CioFiles from '$lib/components/icons/cio/CioFiles.svelte'
import CioMemory from '$lib/components/icons/cio/CioMemory.svelte'
import CioPalette from '$lib/components/icons/cio/CioPalette.svelte'
import CioPlug from '$lib/components/icons/cio/CioPlug.svelte'
import CioSearch from '$lib/components/icons/cio/CioSearch.svelte'
import CioServer from '$lib/components/icons/cio/CioServer.svelte'
import CioShieldCheck from '$lib/components/icons/cio/CioShieldCheck.svelte'
import CioSparkles from '$lib/components/icons/cio/CioSparkles.svelte'
import CioTabInfo from '$lib/components/icons/cio/CioTabInfo.svelte'
import CioVolume from '$lib/components/icons/cio/CioVolume.svelte'
import {
  ChartColumn,
  HeartPulse,
  Keyboard,
  MessageSquareCode,
  MonitorUp,
  Router,
  SlidersHorizontal,
  UsersRound
} from '@lucide/svelte'
import { feature } from '$lib/feature-registry'
import type { Component } from 'svelte'
import type { SettingsSection } from './stores/renderer-recovery'
import type { HarnessesTab } from './stores/settings-ui.svelte'

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
  /** Any glyph component: the canonical set draws every mark the settings pages list. */
  icon: Component
  /**
   * DOM id suffix of the block to reveal on the section page
   * (rendered as `settings-block-<blockId>`). Absent = the whole page.
   */
  blockId?: string
  /**
   * Inner tab to select before the block is revealed, for a section page that
   * splits its content into tabs. Without it a card inside a non-default tab
   * cannot be scrolled to, because it is not on screen when the reveal runs.
   */
  harnessesTab?: HarnessesTab
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
    id: 'ovens',
    section: 'ovens',
    title: 'Ovens',
    description: 'SSH connections, credentials, remote service setup, and harness discovery.',
    keywords: ['ssh', 'remote', 'container', 'server', 'keys'],
    icon: CioServer
  },
  {
    id: 'browser',
    section: 'browser',
    title: 'Browser',
    description: 'Link routing, the search engine, tab hibernation, and prototype previews.',
    keywords: ['search', 'address bar', 'duckduckgo', 'google', 'links', 'tabs', 'cdn'],
    icon: CioBrowser
  },
  {
    id: 'memory',
    section: 'memory',
    title: 'Memory',
    description: 'What the agent remembers across threads and projects.',
    keywords: ['remember', 'context'],
    icon: CioMemory
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
    id: 'design-work-folders',
    section: 'design',
    blockId: 'design-work-folders',
    title: 'Work folders',
    description: 'Where designs and videos are saved, and whether Git tracks them.',
    keywords: [
      'design folder',
      'video folder',
      'save path',
      'version control',
      'git',
      'commit',
      'move',
      'output'
    ],
    icon: CioFiles
  },
  {
    id: 'design-generation',
    section: 'design',
    blockId: 'design-generation',
    title: 'Generation backend',
    description: 'The provider that generates images, clips and sound.',
    keywords: ['replicate', 'generation', 'image', 'video', 'audio', 'token', 'api key', 'media'],
    icon: CioSparkles
  },
  {
    id: 'design-video-packages',
    section: 'design',
    blockId: 'design-video-packages',
    title: 'Video pack',
    description: 'The optional download that enables GPU background removal.',
    keywords: [
      'video pack',
      'background removal',
      'matting',
      'gpu',
      'onnxruntime',
      'mediabunny',
      'transformers',
      'install'
    ],
    icon: CioDownload
  },
  {
    id: 'design',
    section: 'design',
    title: 'Design and video',
    description:
      'Where design and video work is saved, who does each kind of it, and the optional video pack.',
    keywords: [
      'design',
      'video',
      'assignments',
      'copywriter',
      'illustrator',
      'video editor',
      'voice-over',
      'copy',
      'seo',
      'script',
      'storyboard',
      'delegate',
      'image generation',
      'background removal',
      'video pack'
    ],
    icon: CioPalette
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
    id: 'heartbeat',
    section: 'heartbeat',
    title: 'Heartbeat',
    description: 'Timed pings that keep a model’s usage window warm.',
    keywords: ['ping', 'pong', 'usage window', 'reset', 'schedule'],
    icon: HeartPulse
  },
  {
    id: 'harnesses',
    section: 'harnesses',
    title: 'Harnesses',
    description: 'Agent harness connections and model providers.',
    keywords: [
      'providers',
      'models',
      'api keys',
      'auxiliary agents',
      'background model',
      'cheap model'
    ],
    icon: CioPlug
  },
  {
    id: 'harnesses-typesafe',
    section: 'harnesses',
    blockId: 'harnesses-typesafe',
    harnessesTab: 'auxiliary',
    title: 'TypeSafe decisions',
    description: 'The API key CodeInOven uses for TypeSafe judgments, and its connection state.',
    keywords: ['typesafe', 'jev', 'api key', 'credits', 'decision', 'auxiliary'],
    icon: CioSparkles
  },
  {
    id: 'utilities',
    section: 'utilities',
    title: 'Utilities',
    description: 'Installed utilities and the skills marketplace.',
    keywords: ['skills', 'marketplace', 'plugins'],
    icon: feature('utilities').icon
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
    keywords: ['cua', 'bridge', 'automation', 'update'],
    icon: MonitorUp
  },
  {
    id: 'sound',
    section: 'sound',
    title: 'Sound',
    description: 'Local speech models, dictation, cleanup, history, and spoken responses.',
    keywords: ['microphone', 'voice', 'asr', 'tts', 'recording', 'models', 'import', 'cleanup'],
    icon: CioVolume
  },
  {
    id: 'search',
    section: 'search',
    title: 'Search',
    description:
      'Intent search: embed a local EmbeddingGemma model, index your threads, and find them by meaning.',
    keywords: [
      'semantic',
      'intent',
      'embedding',
      'gemma',
      'embeddinggemma',
      'vector',
      'hybrid',
      'threads',
      'index',
      'model',
      'import'
    ],
    icon: CioSearch
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
    id: 'cloud-deployments',
    section: 'cloud-deployments',
    title: 'Cloud Deployments',
    description: 'Cloud environments and deployments.',
    keywords: ['cloud', 'environments'],
    icon: CioCloud
  },
  {
    id: 'profile',
    section: 'profile',
    title: 'Usage',
    description: 'Local usage, cost, and model rankings.',
    keywords: ['quota', 'usage', 'spend', 'activity'],
    icon: ChartColumn
  },
  {
    id: 'about',
    section: 'about',
    title: 'About',
    description: 'Build information, storage, diagnostics, and updates.',
    keywords: ['version', 'build'],
    icon: CioTabInfo
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
    description: 'System notification alerts, in-app notification sounds, and permission status.',
    keywords: ['alerts', 'permission', 'test', 'sound', 'in-app', 'toast'],
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
    description: 'Default pull strategy, merge method, maximum diff lines, and merge editor limit.',
    keywords: [
      'pull',
      'merge',
      'squash',
      'rebase',
      'fast-forward',
      'diff',
      'conflict',
      'merge editor',
      'file size',
      'too large'
    ],
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
  {
    id: 'general-cio-cleanup',
    section: 'general',
    blockId: 'general-cio-cleanup',
    title: 'CIO Cleanup',
    description:
      'Daily removal of stale scratch content from every workspace .cio folder, with the folders you exclude kept whole.',
    keywords: [
      'cleanup',
      'scratch',
      'retention',
      'exclusions',
      'stale',
      'cio',
      'folders',
      'designs',
      'videos',
      'utilities'
    ],
    icon: SlidersHorizontal
  },
  {
    id: 'general-cio-cleanup-retention',
    section: 'general',
    blockId: 'general-cio-cleanup',
    title: 'CIO Cleanup retention',
    description: 'How many days scratch content is kept before CIO Cleanup removes it.',
    keywords: ['cleanup', 'scratch', 'retention', 'days', 'stale'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-background',
    section: 'general',
    blockId: 'general-threads',
    title: 'Run in the background',
    description: 'Keep Assistants on schedule after the window closes.',
    keywords: ['background', 'menu bar', 'tray', 'scheduled', 'close', 'quit'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-background-mode',
    section: 'general',
    blockId: 'general-threads',
    title: 'Background mode',
    description: 'Park only when work is running or due, or never quit on close.',
    keywords: ['scheduled', 'always', 'background', 'close', 'quit'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-launch-at-login',
    section: 'general',
    blockId: 'general-threads',
    title: 'Start at login',
    description: 'Launch CodeInOven at login so a schedule can fire after a restart.',
    keywords: ['login', 'autostart', 'startup', 'boot'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-missed-runs',
    section: 'general',
    blockId: 'general-threads',
    title: 'Run missed scheduled work on return',
    description: 'Catch up on assistant slots missed to sleep or a closed app.',
    keywords: ['missed', 'catch up', 'scheduled', 'sleep', 'resume'],
    icon: SlidersHorizontal
  },
  {
    id: 'general-wake-lead',
    section: 'general',
    blockId: 'general-threads',
    title: 'Wake lead',
    description: 'How long before a due run the device is held awake.',
    keywords: ['wake', 'sleep', 'lead', 'prevent sleep', 'battery'],
    icon: SlidersHorizontal
  },
  // ── Blocks on Browser ─────────────────────────────────────────────────
  {
    id: 'browser-links',
    section: 'browser',
    blockId: 'browser-links',
    title: 'Link routing',
    description: 'Which links open in CIO’s browser instead of your default browser.',
    keywords: ['localhost', 'links', 'open', 'system browser', 'workspace'],
    icon: CioBrowser
  },
  {
    id: 'browser-search',
    section: 'browser',
    blockId: 'browser-search',
    title: 'Search engine',
    description: 'The engine typed text searches with, plus your own engines.',
    keywords: [
      'search',
      'query',
      'address bar',
      'duckduckgo',
      'google',
      'custom engine',
      'template'
    ],
    icon: CioSearch
  },
  {
    id: 'browser-tabs',
    section: 'browser',
    blockId: 'browser-tabs',
    title: 'Tab hibernation and page shortcuts',
    description:
      'Free a browser tab’s memory after it sits unused, and choose whether a website may override the app’s shortcuts.',
    keywords: ['tab', 'memory', 'hibernate', 'idle', 'shortcut', 'keyboard', 'keymap', 'page'],
    icon: CioBrowser
  },
  {
    id: 'browser-prototype-cdn',
    section: 'browser',
    blockId: 'browser-prototype-cdn',
    title: 'Prototype previews',
    description: 'Approve the external CDNs prototype previews may load.',
    keywords: ['prototype', 'preview', 'cdn', 'fonts', 'allowlist'],
    icon: CioBrowser
  },
  // ── Blocks on About ──────────────────────────────────────────────────────
  {
    id: 'about-storage',
    section: 'about',
    blockId: 'about-storage',
    title: 'Storage',
    description: 'Where all projects, threads, and history are stored.',
    keywords: ['data directory', 'disk'],
    icon: CioTabInfo
  },
  {
    id: 'about-diagnostics',
    section: 'about',
    blockId: 'about-diagnostics',
    title: 'Diagnostics',
    description: 'Export a redacted failure report.',
    keywords: ['export', 'failure report', 'logs'],
    icon: CioTabInfo
  },
  {
    id: 'about-updates',
    section: 'about',
    blockId: 'about-updates',
    title: 'Updates',
    description: 'Update channel, nightly builds, and auto-install.',
    keywords: ['nightly', 'auto-download', 'auto-install', 'channel'],
    icon: CioTabInfo
  },
  {
    id: 'about-changelog',
    section: 'about',
    blockId: 'about-changelog',
    title: 'Changelog',
    description: 'Release notes for the latest published build.',
    keywords: ['release notes', 'what’s new', 'changes'],
    icon: CioTabInfo
  },
  {
    id: 'about-community',
    section: 'about',
    blockId: 'about-community',
    title: 'Community',
    description: 'Report a bug, send feedback, or contribute on GitHub.',
    keywords: ['feedback', 'bug report', 'contribute', 'github', 'issue'],
    icon: UsersRound
  },
  {
    id: 'about-privacy',
    section: 'about',
    blockId: 'about-privacy',
    title: 'Share anonymous daily active ping',
    description: 'Share one anonymous daily active ping.',
    keywords: ['privacy', 'analytics', 'telemetry', 'posthog', 'usage statistics'],
    icon: CioShieldCheck
  }
]
