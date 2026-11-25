/**
 * Where a shortcut's handler is listening.
 *
 * Two shortcuts can share a chord without fighting as long as their handlers can
 * never be listening at the same moment: `Escape` closes the settings view and
 * also the mention menu, and neither can be on screen while the other is. A
 * user rebinding a key needs the opposite answer, so the registry states the
 * condition per entry and this table states which conditions coexist.
 *
 * Overlaps are read both ways when a conflict is decided, and either side being
 * `all` makes the pair overlap, which is why the overlays and the two global
 * scopes never have to list their partners.
 */

export type KeymapContextId =
  | 'global'
  | 'system'
  | 'app-views'
  | 'thread'
  | 'conversation'
  | 'composer'
  | 'composer-overlay'
  | 'comment-editor'
  | 'rich-editor'
  | 'notifications'
  | 'assistant'
  | 'settings'
  | 'browser'
  | 'browser-canvas'
  | 'terminal'
  | 'file-tree'
  | 'file-editor'
  | 'find-bar'
  | 'deployment'
  | 'ide'
  | 'git'
  | 'studios'
  | 'video-editor'
  | 'video-controls'
  | 'video-player'
  | 'video-annotation'
  | 'palette'
  | 'modal'
  | 'media-preview'
  | 'guide'
  | 'accessibility'

/** A context other than the shortcut's own that its handler can run beside. */
export type KeymapContextOverlaps = 'all' | readonly KeymapContextId[]

export interface KeymapContext {
  /** Short surface name, for the conflict explanation in the rebind dialog. */
  label: string
  overlaps: KeymapContextOverlaps
}

export const KEYMAP_CONTEXTS: Readonly<Record<KeymapContextId, KeymapContext>> = {
  /** "Anywhere in the app": navigation, find, quit. Always listening. */
  global: { label: 'Anywhere in the app', overlaps: 'all' },
  /** A chord claimed by the operating system, so it fires over any surface. */
  system: { label: 'System-wide', overlaps: 'all' },
  /** Projects, Threads, Chats, Scope, Assistant as view-level actions. */
  'app-views': {
    label: 'A main view',
    overlaps: ['thread', 'assistant', 'settings', 'browser', 'studios', 'deployment', 'git']
  },
  thread: {
    label: 'An open thread',
    overlaps: ['app-views', 'conversation', 'composer', 'studios', 'video-editor']
  },
  conversation: {
    label: 'The conversation area',
    overlaps: ['thread', 'composer', 'rich-editor', 'find-bar', 'comment-editor']
  },
  composer: {
    label: 'The chat composer',
    overlaps: [
      'thread',
      'conversation',
      'composer-overlay',
      'rich-editor',
      'notifications',
      'comment-editor'
    ]
  },
  'composer-overlay': { label: 'A composer menu or popover', overlaps: ['composer'] },
  'comment-editor': {
    label: 'A selection comment',
    overlaps: ['composer', 'conversation', 'studios', 'rich-editor']
  },
  'rich-editor': {
    label: 'A rich text editor',
    overlaps: ['composer', 'conversation', 'studios', 'comment-editor']
  },
  notifications: { label: 'The notifications panel', overlaps: ['composer', 'app-views'] },
  assistant: { label: 'The Assistant view', overlaps: ['app-views'] },
  settings: { label: 'Settings', overlaps: ['app-views'] },
  browser: { label: 'The browser chrome', overlaps: ['app-views', 'browser-canvas'] },
  'browser-canvas': { label: 'The browser canvas editor', overlaps: ['browser'] },
  terminal: { label: 'A terminal', overlaps: ['app-views', 'file-editor'] },
  'file-tree': { label: 'The file tree', overlaps: ['file-editor', 'find-bar', 'git'] },
  'file-editor': {
    label: 'A file tab',
    overlaps: ['file-tree', 'find-bar', 'ide', 'deployment', 'terminal']
  },
  'find-bar': {
    label: 'A find or go-to bar',
    overlaps: ['file-editor', 'file-tree', 'conversation']
  },
  deployment: { label: 'A cloud deployment detail', overlaps: ['file-editor', 'app-views'] },
  ide: { label: 'IDE Mode', overlaps: ['file-editor'] },
  git: { label: 'The Git panel', overlaps: ['file-tree', 'app-views'] },
  studios: {
    label: 'A studio',
    overlaps: ['app-views', 'rich-editor', 'thread', 'comment-editor']
  },
  'video-editor': {
    label: 'The video editor',
    overlaps: ['video-controls', 'video-player', 'video-annotation', 'thread']
  },
  'video-controls': { label: 'The video controls', overlaps: ['video-editor', 'video-player'] },
  'video-player': {
    label: 'The composition player',
    overlaps: ['video-editor', 'video-controls', 'video-annotation']
  },
  'video-annotation': {
    label: 'Video annotation',
    overlaps: ['video-editor', 'video-player']
  },
  /**
   * An overlay that covers its surface and owns the keyboard while it is up.
   *
   * Its neighbours are deliberately empty: an overlay suppresses the handlers
   * under it, so the same chord there is two separate lifetimes rather than one
   * press reaching both. Only the global and system scopes keep listening
   * through it, which the `global`/`system` sides of the relation already say.
   */
  palette: { label: 'A palette or picker', overlaps: [] },
  modal: { label: 'A modal overlay', overlaps: [] },
  'media-preview': { label: 'A media preview', overlaps: [] },
  guide: { label: 'A view guide', overlaps: [] },
  /** Native activation on a focused control: the control answers first, and the
   *  app's own handler only sees keys the control left alone. */
  accessibility: { label: 'Any focusable control', overlaps: [] }
}

/** True when the two contexts can be listening at the same moment. */
export function keymapContextsOverlap(a: KeymapContextId, b: KeymapContextId): boolean {
  if (a === b) return true
  const left = KEYMAP_CONTEXTS[a]
  const right = KEYMAP_CONTEXTS[b]
  if (left.overlaps === 'all' || right.overlaps === 'all') return true
  return left.overlaps.includes(b) || right.overlaps.includes(a)
}

/** The surface name shown when a conflict is explained to the user. */
export function keymapContextLabel(id: KeymapContextId): string {
  return KEYMAP_CONTEXTS[id].label
}
