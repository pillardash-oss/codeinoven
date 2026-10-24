import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
import CioBrowser from '@pdslng/cio-icon/CioBrowser.svelte'
import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
import CioCloud from '@pdslng/cio-icon/CioCloud.svelte'
import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
import CioHeartPulse from '@pdslng/cio-icon/CioHeartPulse.svelte'
import CioKeyboard from '@pdslng/cio-icon/CioKeyboard.svelte'
import CioMemory from '@pdslng/cio-icon/CioMemory.svelte'
import CioPalette from '@pdslng/cio-icon/CioPalette.svelte'
import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
import CioServer from '@pdslng/cio-icon/CioServer.svelte'
import CioShieldCheck from '@pdslng/cio-icon/CioShieldCheck.svelte'
import CioSparkles from '@pdslng/cio-icon/CioSparkles.svelte'
import CioTabInfo from '@pdslng/cio-icon/CioTabInfo.svelte'
import CioTabSettings from '@pdslng/cio-icon/CioTabSettings.svelte'
import CioTeam from '@pdslng/cio-icon/CioTeam.svelte'
import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
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
    id: 'general-bundled-pi-files',
    section: 'general',
    title: 'Sensitive files · Bundled Pi only',
    description:
      'Protected file block list and per-tool approval for bundled Pi, including Full Access.',
    keywords: ['sensitive', 'files', 'env', 'pub', 'secrets', 'blocklist', 'permissions', 'pi'],
    icon: CioShieldCheck,
    blockId: 'general-bundled-pi-files'
  },
  {
    id: 'general',
    section: 'general',
    title: 'General',
    description: 'Appearance, notifications, git, threads, and power defaults.',
    keywords: ['settings', 'preferences'],
    icon: CioTabSettings
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
    icon: CioTeam
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
    icon: CioMessage
  },
  {
    id: 'heartbeat',
    section: 'heartbeat',
    title: 'Heartbeat',
    description: 'Timed pings that keep a model’s usage window warm.',
    keywords: ['ping', 'pong', 'usage window', 'reset', 'schedule'],
    icon: CioHeartPulse
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
    id: 'computer-use',
    section: 'computer-use',
    title: 'Computer use',
    description: 'Bridge settings for computer-control agents.',
    keywords: ['cua', 'bridge', 'automation', 'update'],
    icon: CioDisplay
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
    icon: CioKeyboard
  },
  {
    id: 'ide-mode',
    section: 'ide-mode',
    title: 'IDE Mode',
    description: 'Configure language servers for project tree editing.',
    keywords: [
      'lsp',
      'language server',
      'typescript',
      'javascript',
      'python',
      'golang',
      'php',
      'definitions',
      'intelephense'
    ],
    icon: CioServer
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
    icon: CioMessage
  },
  {
    id: 'archives',
    section: 'archives',
    title: 'Archives',
    description: 'Archived projects, threads, chats, and assistants.',
    keywords: ['archive', 'restore', 'unarchive'],
    icon: CioArchive
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
    description: 'Theme, contrast, font, size, weight, and zoom.',
    keywords: ['theme', 'light', 'dark', 'system', 'contrast', 'accessibility', 'readability'],
    icon: CioTabSettings
  },
  {
    id: 'general-notifications',
    section: 'general',
    blockId: 'general-notifications',
    title: 'Notifications',
    description: 'System notification alerts, in-app notification sounds, and permission status.',
    keywords: ['alerts', 'permission', 'test', 'sound', 'in-app', 'toast'],
    icon: CioTabSettings
  },
  {
    id: 'general-power',
    section: 'general',
    blockId: 'general-power',
    title: 'Power',
    description: 'Keep the device awake while work is in progress.',
    keywords: ['sleep', 'keep awake', 'battery'],
    icon: CioTabSettings
  },
  {
    id: 'general-recovery',
    section: 'general',
    blockId: 'general-recovery',
    title: 'Recovery',
    description: 'Resume interrupted work and auto-resume after usage resets.',
    keywords: ['resume', 'restart', 'auto-resume', 'rate limit'],
    icon: CioTabSettings
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
    icon: CioTabSettings
  },
  {
    id: 'general-threads',
    section: 'general',
    blockId: 'general-threads',
    title: 'Threads',
    description:
      'Thread limits, slash command behavior, question timeout, and which panel tabs the switcher lists.',
    keywords: [
      'limit',
      'slash commands',
      'timeout',
      'switcher',
      'ctrl+tab',
      'terminal tabs',
      'file tabs',
      'browser tabs'
    ],
    icon: CioTabSettings
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
    icon: CioTabSettings
  },
  {
    id: 'general-cio-cleanup-retention',
    section: 'general',
    blockId: 'general-cio-cleanup',
    title: 'CIO Cleanup retention',
    description: 'How many days scratch content is kept before CIO Cleanup removes it.',
    keywords: ['cleanup', 'scratch', 'retention', 'days', 'stale'],
    icon: CioTabSettings
  },
  {
    id: 'general-background',
    section: 'general',
    blockId: 'general-threads',
    title: 'Run in the background',
    description: 'Keep Assistants on schedule after the window closes.',
    keywords: ['background', 'menu bar', 'tray', 'scheduled', 'close', 'quit'],
    icon: CioTabSettings
  },
  {
    id: 'general-background-mode',
    section: 'general',
    blockId: 'general-threads',
    title: 'Background mode',
    description: 'Park only when work is running or due, or never quit on close.',
    keywords: ['scheduled', 'always', 'background', 'close', 'quit'],
    icon: CioTabSettings
  },
  {
    id: 'general-launch-at-login',
    section: 'general',
    blockId: 'general-threads',
    title: 'Start at login',
    description: 'Launch CodeInOven at login so a schedule can fire after a restart.',
    keywords: ['login', 'autostart', 'startup', 'boot'],
    icon: CioTabSettings
  },
  {
    id: 'general-missed-runs',
    section: 'general',
    blockId: 'general-threads',
    title: 'Run missed scheduled work on return',
    description: 'Catch up on assistant slots missed to sleep or a closed app.',
    keywords: ['missed', 'catch up', 'scheduled', 'sleep', 'resume'],
    icon: CioTabSettings
  },
  {
    id: 'general-wake-lead',
    section: 'general',
    blockId: 'general-threads',
    title: 'Wake lead',
    description: 'How long before a due run the device is held awake.',
    keywords: ['wake', 'sleep', 'lead', 'prevent sleep', 'battery'],
    icon: CioTabSettings
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
    icon: CioTeam
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
