export interface Props {
  projectId: string
  threadId: string
  scopeBucketId?: string
}

export type RepoState = 'loading' | 'git_unavailable' | 'not_git' | 'git'

/** The working tree's state as a badge names it, most urgent first. */
export type WorktreeState = 'clean' | 'dirty' | 'conflicted'
/**
 * The surface props as the units read them.
 *
 * A prop the component destructures with a default (`active = true`) is never
 * `undefined` inside the surface, so those keys are required here and lose
 * `undefined`; every other prop keeps the optionality the surface declared.
 */
export type GitStatusPanelSurfaceProps = {
  [K in 'scopeBucketId']-?: Exclude<Props[K], undefined>
} & Omit<Props, 'scopeBucketId'>
