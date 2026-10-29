import { type MainView } from '$lib/stores/renderer-recovery.svelte'
import type { AppConfig, AppConfigPatch } from '$shared/types'
import type { ProjectFamilyLanding } from '../../layout/AppHeaderNavigationController.svelte'

export interface Props {
  /** Which sidebar the shell shows   the main content stays mounted across modes. */
  mode: 'projects' | 'chats' | 'threads' | 'assistant'
  /** Whether the shell is the on-screen view (hidden while in Settings/Scope). */
  active?: boolean
  /** True while the Scope page is on screen   thread switches must keep the
   *  scope store's active project in sync with the selected thread. */
  scopeViewActive?: boolean
  navigate: (view: MainView) => void
  /** The project view a Ctrl+Tab return to the project family lands on: the
   *  view the user last used for the family, which is also the one the rail's
   *  project badge rides. Read per call, because the browser can be left long
   *  after the value last changed. */
  lastProjectViewLanding?: () => ProjectFamilyLanding
  /** Global app config   drives the image-descriptor default + ask-again flag. */
  config?: AppConfig
  updateConfig?: (patch: AppConfigPatch) => Promise<void>
}
/**
 * The surface props as the units read them.
 *
 * A prop the component destructures with a default (`active = true`) is never
 * `undefined` inside the surface, so those keys are required here and lose
 * `undefined`; every other prop keeps the optionality the surface declared.
 */
export type WorkspaceSurfaceProps = {
  [K in 'active' | 'scopeViewActive' | 'lastProjectViewLanding']-?: Exclude<Props[K], undefined>
} & Omit<Props, 'active' | 'scopeViewActive' | 'lastProjectViewLanding'>
