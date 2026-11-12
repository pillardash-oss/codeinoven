import type { MainView } from './renderer-recovery.svelte'

/**
 * Which project, directory or thread the Secrets page should open on.
 *
 * The page is reachable from Settings, from a project row's key button and from
 * the file explorer's Secrets action, and those entry points know the context the
 * page needs. Keeping the request here means the page does not have to guess and no
 * entry point has to thread props through the shell.
 */
class SecretsPageState {
  target = $state<{
    projectId?: string
    directory?: string
    threadId?: string
    sequence: number
  } | null>(null)

  /**
   * The shell's navigation, registered once.
   *
   * A key button sits deep inside the project tree or the file explorer, and
   * drilling a navigate callback through both would couple every tree row to the
   * settings shell. The shell registers itself here instead.
   */
  private navigator: ((view: MainView) => void) | null = null

  /** Called by the shell once the navigation function exists. */
  setNavigator(navigate: (view: MainView) => void): void {
    this.navigator = navigate
  }

  /** Ask the page to show one context. */
  show(target: { projectId?: string; directory?: string; threadId?: string }): void {
    this.target = { ...target, sequence: (this.target?.sequence ?? 0) + 1 }
  }

  /** Open the Secrets page on one context. */
  open(target: { projectId?: string; directory?: string; threadId?: string }): void {
    this.show(target)
    this.navigator?.('settings-secrets')
  }

  /** Forget the last request, e.g. when the page is left behind. */
  clear(): void {
    this.target = null
  }
}

export const secretsPageState = new SecretsPageState()
