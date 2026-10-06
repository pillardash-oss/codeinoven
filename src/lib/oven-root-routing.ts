/** Repository operations that must follow the selected thread's Oven root. */
export const OVEN_ROOT_GIT_CHANNELS = new Set<string>([
  'git:status',
  'git:diff',
  'git:analyzeConflict',
  'git:prepareConflictWorkFile',
  'git:saveConflictDraft',
  'git:saveConflictResolution',
  'git:stage',
  'git:resolveConflicted',
  'git:acceptConflictSide',
  'git:unstage',
  'git:restoreFiles',
  'git:commit',
  'git:init',
  'git:branches',
  'git:defaultBranch',
  'git:checkout',
  'git:createBranch',
  'git:createTrackingBranch',
  'git:deleteBranch',
  'git:deleteRemoteBranch',
  'git:log',
  'git:remoteUpdates',
  'git:commitDiff',
  'git:commitFileDiff',
  'git:amend',
  'git:removeCommitChanges',
  'git:reset',
  'git:deleteCommit',
  'git:getIdentity',
  'git:setIdentity',
  'git:remotes',
  'git:addRemote',
  'git:setRemoteUrl',
  'git:removeRemote',
  'git:fetch',
  'git:fetchBranch',
  'git:pull',
  'git:pullIntegrate',
  'git:syncWith',
  'git:syncPeers',
  'git:push',
  'git:merge',
  'git:rebase',
  'git:preparePrResolve',
  'git:finishPrResolve',
  'git:stash',
  'git:ignore',
  'git:discard',
  'git:stashList',
  'git:stashPop',
  'git:stashDrop',
  'git:stashDiff',
  'git:stashFileDiff',
  'git:abortMerge',
  'git:abortRebase',
  'git:rebaseAction'
])

/** Filesystem and repository channels that follow the thread's Oven root too. */
const OVEN_ROOT_FILE_CHANNELS = new Set<string>([
  'projectFiles:list',
  'projectFiles:search',
  'projectFiles:resolveCitationPaths',
  'projectFiles:resolveExternalCitationPaths',
  'projectFiles:create',
  'projectFiles:createDirectory',
  'projectFiles:delete',
  'projectFiles:info',
  'projectFiles:read',
  'projectFiles:rename',
  'projectFiles:save',
  'projectFiles:paste',
  'projectFiles:saveAs',
  'projectFiles:importPaths',
  'projectFiles:dropPaths',
  'projectFiles:openInEditor',
  'projectFiles:openInEditorWith',
  'repository:preflight',
  'repository:initialize',
  'repository:currentBranch',
  'directoryPreview:open'
])

/**
 * Position of the scope argument in each channel's existing typed tuple.
 *
 * A remote panel passes the Oven scope key where a local scope bucket id goes,
 * and this table is how the invoke boundary finds that key without every store
 * having to learn about remote mapping. Channels with no scope argument are
 * absent, which is also how a key-less remote call stays bound to the thread
 * that issued it.
 */
export const OVEN_ROOT_SCOPE_ARGUMENTS: Readonly<Record<string, number>> = {
  'git:status': 1,
  'git:diff': 3,
  'git:analyzeConflict': 2,
  'git:prepareConflictWorkFile': 2,
  'git:saveConflictDraft': 4,
  'git:saveConflictResolution': 3,
  'git:stage': 2,
  'git:resolveConflicted': 2,
  'git:acceptConflictSide': 2,
  'git:unstage': 2,
  'git:restoreFiles': 4,
  'git:commit': 2,
  'git:init': 1,
  'git:branches': 1,
  'git:defaultBranch': 1,
  'git:checkout': 2,
  'git:createBranch': 2,
  'git:createTrackingBranch': 4,
  'git:deleteBranch': 3,
  'git:deleteRemoteBranch': 3,
  'git:log': 4,
  'git:remoteUpdates': 1,
  'git:commitDiff': 2,
  'git:commitFileDiff': 3,
  'git:amend': 2,
  'git:removeCommitChanges': 3,
  'git:reset': 3,
  'git:deleteCommit': 2,
  'git:getIdentity': 1,
  'git:setIdentity': 2,
  'git:remotes': 1,
  'git:addRemote': 3,
  'git:setRemoteUrl': 3,
  'git:removeRemote': 2,
  'git:fetch': 1,
  'git:fetchBranch': 3,
  'git:pull': 1,
  'git:pullIntegrate': 2,
  'git:syncWith': 2,
  'git:syncPeers': 1,
  'git:push': 2,
  'git:merge': 2,
  'git:rebase': 2,
  'git:preparePrResolve': 2,
  'git:finishPrResolve': 2,
  'git:stash': 3,
  'git:ignore': 2,
  'git:discard': 2,
  'git:stashList': 1,
  'git:stashPop': 2,
  'git:stashDrop': 2,
  'git:stashDiff': 2,
  'git:stashFileDiff': 3,
  'git:abortMerge': 1,
  'git:abortRebase': 1,
  'git:rebaseAction': 2,
  'projectFiles:list': 2,
  'projectFiles:search': 3,
  'projectFiles:resolveCitationPaths': 2,
  'projectFiles:create': 3,
  'projectFiles:createDirectory': 3,
  'projectFiles:delete': 2,
  'projectFiles:info': 2,
  'directoryPreview:open': 2,
  'projectFiles:openInEditor': 2,
  'projectFiles:openInEditorWith': 3,
  'projectFiles:saveAs': 2,
  'projectFiles:importPaths': 3,
  'projectFiles:dropPaths': 3,
  'projectFiles:read': 2,
  'projectFiles:rename': 3,
  'projectFiles:save': 4
}

export function isOvenRootChannel(channel: string): boolean {
  return OVEN_ROOT_GIT_CHANNELS.has(channel) || OVEN_ROOT_FILE_CHANNELS.has(channel)
}

/**
 * The scope key a remote panel passes where a local scope bucket id goes.
 *
 * One shape, minted by the renderer and parsed by the main process, so the two
 * ends can never disagree about it: the renderer builds the key a panel's calls
 * carry, and main reads back the thread and Oven a routed call belongs to.
 */
export function ovenRootKeyFor(threadId: string, ovenId: string): string {
  return `oven.${threadId}.${ovenId}`
}

/** Matches exactly the keys {@link ovenRootKeyFor} mints. */
const OVEN_ROOT_KEY = /^oven\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u

/** The thread and Oven a remote scope key names, or null for anything else. */
export function parseOvenRootKey(value: unknown): { threadId: string; ovenId: string } | null {
  if (typeof value !== 'string') return null
  const match = OVEN_ROOT_KEY.exec(value)
  return match ? { threadId: match[1], ovenId: match[2] } : null
}
