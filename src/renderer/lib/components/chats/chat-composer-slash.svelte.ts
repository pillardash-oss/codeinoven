import { APP_NAME } from '$shared/brand'
import { isPermissionLevelAction, permissionLevelActions } from '$lib/actions'
import type { ActionDefinition, ActionSource } from '$lib/actions'
import type { ThinkingPreset } from '$shared/types'

export interface ComposerSlashActionsOptions {
  getShowChatModes: () => boolean
  getFileSystemMode: () => boolean | undefined
  getSupportsThinking: () => boolean
  getAccountPickerVisible: () => boolean
  /** The scope shoe's picker is live (project mode, new thread). */
  getScopePickerVisible: () => boolean
  getThinkingPresets: () => ThinkingPreset[]
  getActions: () => readonly ActionDefinition[]
}

/**
 * The slash-menu action set: the composer's own selector/mode entries plus the
 * host's thread-scoped actions (minus the ones the selectors already cover).
 */
export function createComposerSlashActions(options: ComposerSlashActionsOptions) {
  const composerActionSource = {
    id: 'composer',
    label: APP_NAME,
    kind: 'app'
  } satisfies ActionSource

  const available = $derived.by((): ActionDefinition[] => {
    /** Chats stay pinned to auto review until File System is turned on, so the
     *  permission levels are only offered once this chat can touch files. */
    const chatFileSystemEnabled = options.getShowChatModes() && options.getFileSystemMode() === true
    /** A host that already publishes the permission levels (a thread's action
     *  list) keeps ownership, so the menu never renders two copies of a level. */
    const hostPublishesPermissionLevels = options
      .getActions()
      .some((action) => isPermissionLevelAction(action))

    return [
      {
        id: 'selector:models',
        title: '/models',
        description: 'Open the full model selector and search',
        category: 'model',
        source: composerActionSource,
        keywords: ['model', 'favorites', 'provider']
      },
      ...(options.getSupportsThinking()
        ? [
            {
              id: 'selector:thinking' as const,
              title: '/thinking',
              description: 'Open the thinking selector and search',
              category: 'reasoning' as const,
              source: composerActionSource,
              keywords: ['reasoning', 'effort', ...options.getThinkingPresets().map((p) => p.id)]
            }
          ]
        : []),
      ...(options.getAccountPickerVisible()
        ? [
            {
              id: 'selector:account' as const,
              title: '/account',
              description: 'Open the account selector and search',
              category: 'model' as const,
              source: composerActionSource,
              keywords: ['account', 'user', 'profile', 'login', 'credential']
            }
          ]
        : []),
      ...(options.getScopePickerVisible()
        ? [
            {
              id: 'selector:scope' as const,
              title: '/scope',
              description: 'Open the scope picker and search',
              category: 'mode' as const,
              source: composerActionSource,
              keywords: ['scope', 'worktree', 'environment', 'branch', 'isolate', 'board']
            }
          ]
        : []),
      ...(options.getShowChatModes()
        ? ([
            {
              id: 'mode:file-system',
              title:
                options.getFileSystemMode() === true ? 'Disable file system' : 'Enable file system',
              description:
                options.getFileSystemMode() === true
                  ? 'Turn this chat web-only: questions and research, no file operations'
                  : 'Grant this chat file operations and unlock the permission levels',
              category: 'mode',
              source: composerActionSource,
              keywords: ['file system', 'filesystem', 'files', 'fs', 'workspace', 'tools', 'access']
            }
          ] satisfies ActionDefinition[])
        : []),
      ...(chatFileSystemEnabled && !hostPublishesPermissionLevels
        ? permissionLevelActions(composerActionSource)
        : []),
      ...options
        .getActions()
        .filter((action) => action.category !== 'model' && action.category !== 'reasoning')
    ]
  })

  return {
    get available() {
      return available
    }
  }
}

/** Actions whose selection inserts `/title ` into the composer and whose
 *  typed `/title args` submit is routed through `onSlashCommand`. Harness
 *  command/skill/mcp actions qualify natively; app-owned actions opt in via
 *  the `slashCommand` flag. */
export function isSlashRoutedAction(action: ActionDefinition): boolean {
  if (action.slashCommand === true) return true
  return (
    action.source.kind === 'harness' &&
    (action.category === 'command' || action.category === 'skill' || action.category === 'mcp') &&
    action.title.startsWith('/')
  )
}
