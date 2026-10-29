import { onMount } from 'svelte'
import { invoke } from '$lib/ipc.svelte'
import { initComposerFocusShortcut } from '$lib/focus/composer-focus-shortcut'
import { startAppControlResponder } from '$lib/app-control/app-control-responder'
import { registerShellNavigationActions } from '$lib/app-control/app-control-actions'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { navigationHistoryState } from '$lib/stores/navigation-history.svelte'
import { settingsRouteState } from '$lib/stores/settings-route.svelte'
import { loadBrowser } from '$lib/stores/browser-access.svelte'
import { layoutPanelState } from '$lib/stores/layout-panel.svelte'
import { keymapState } from '$lib/keymap/keymap-state.svelte'
import { installBrowserShortcutPublishing } from '$lib/keymap/browser-shortcuts'
import { visionModels } from '$lib/stores/vision-models.svelte'
import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
import { providerStore } from '$lib/stores/providers.svelte'
import { harnessAccountCache } from '$lib/stores/harness-accounts'
import { harnessLifecycleStore } from '$lib/stores/harness-lifecycle.svelte'
import { warmSidebarPanels } from '$lib/sidebar-panel-preload'
import { warmAppPanels } from '$lib/app-panel-preload'
import { scheduleDeferredWork } from '$lib/deferred-work'
import { initVoiceShortcutListener } from '$lib/speech/voice-shortcut'
import { handleOpenedPaths } from '../app-os-handoff'
import { installAppIpcSubscriptions } from '../app-ipc-subscriptions'
import { guideState } from '$lib/guide/guide-state.svelte'
import type { View } from './App-types'
import type { App } from './App-board.svelte'
/** One concern of the App board. */
export class AppEffects {
  #root: App | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): App {
    if (!this.#root) throw new Error('AppEffects read its board before it was bound')
    return this.#root
  }
  constructor(root: App) {
    this.#root = root
  }
  /**
   * The work the surface used to do as it set itself up: effects, the
   * subscriptions it opened and the first load it kicked off. It runs from
   * the board's constructor, which the component calls during its own setup,
   * so every effect here is owned by the component.
   */
  init(): void {
    /* The header aligns the thread title to the conversation's page column, and the
     shell that owns that column stays mounted while another view is on screen. Tell
     the header when the column is actually the page being looked at. */
    $effect(() => {
      layoutPanelState.contentVisible = this.root.openAssistantFromSearch.showsContentView
    })

    // The file surface changes shells through lazy imports. Its visibility lease
    // belongs to this stable owner, so neither the import gap nor an outro can
    // reveal the page between the docked and fullscreen modes.
    $effect(() =>
      browserVisibility.hideWhile(
        'standalone-file-surface',
        'fullscreen-surface',
        standaloneFiles.open && !standaloneFiles.minimized
      )
    )

    /** A view's empty state, or the palette, can request that view's own guide. */
    $effect(() => {
      const view = workspaceState.consumeViewTourRequest()
      if (!view) return
      guideState.start(view)
    })

    /**
     * Walking the Projects guide to its end is what finishes the first run. There
     * is no separate setup tour: the guide is the sequence, so a user who closes
     * it half way is offered it again on the next launch, and one who walks it
     * through is done for good.
     */
    $effect(() => {
      if (!this.root.updateConfig.config.onboardingCompleted && guideState.hasSeen('projects')) {
        void this.root.updateConfig.updateConfig({ onboardingCompleted: true })
      }
    })

    /** The dock's own button asks for the step the stop is about. */
    $effect(() => {
      const request = guideState.consumeActionRequest()
      if (!request) return
      void this.root.spotlightPalette.runGuideAction(request.run).then((done) => {
        // A control inside a stop does its work where the user already is, so it
        // never moves the guide on: only the stop's own step button advances.
        if (done && request.advance) guideState.completeAction()
      })
    })

    /**
     * The agent step's gate: the guide walks on once this machine has an agent it
     * can actually run, or once the user has an account connected to one. Both
     * halves come from state the guide cannot fake: the harness probe the settings
     * page reads, and the account registry the model picker reads. A harness that
     * finishes installing, or an account connected mid-step, therefore opens the
     * gate by itself, and a user who arrives with either is never held.
     */
    $effect(() => {
      const installed = providerStore.providers.some(
        (provider) => provider.status === 'available' && provider.integration === 'ready'
      )
      const connected = providerStore.providers.some(
        (provider) => (harnessAccountCache.cached(provider.id)?.length ?? 0) > 0
      )
      guideState.setStepReady(installed || connected)
    })

    /**
     * A guide explains one view's own app, so it may only run while that view is
     * the one on screen. Leaving the view ends it right here, which is what keeps
     * a tip from ever pointing at something the user is no longer looking at.
     */
    $effect(() => {
      guideState.syncView(this.root.onKeydown.activeView)
    })

    settingsRouteState.onUtilitiesChange =
      this.root.openAssistantFromSearch.observeNavigationLocation

    navigationHistoryState.init({
      view: rendererRecovery.activeView,
      thread: rendererRecovery.selectedThread,
      utilities:
        rendererRecovery.activeView === 'settings-utilities' ? settingsRouteState.utilities : null
    })

    onMount(() => {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      this.root.updateConfig.systemDark = mq.matches
      this.root.updateConfig.applyTheme()
      const onColorSchemeChange = (event: MediaQueryListEvent): void => {
        this.root.updateConfig.systemDark = event.matches
        this.root.updateConfig.applyTheme()
      }
      mq.addEventListener('change', onColorSchemeChange)
      window.addEventListener('keydown', this.root.onKeydown.onKeydown)
      window.addEventListener('mousedown', this.root.openAssistantFromSearch.onMouseHistoryButton)
      window.addEventListener('auxclick', this.root.openAssistantFromSearch.onMouseHistoryButton)
      const uninstallVoiceShortcut = initVoiceShortcutListener()
      const uninstallComposerFocusShortcut = initComposerFocusShortcut()

      // The renderer half of the app-control bridge, plus the shell-owned
      // navigation actions. Both are idempotent: a remount re-registers nothing.
      startAppControlResponder()
      registerShellNavigationActions((view) => this.root.onKeydown.navigate(view as View))

      const restoreWorkspaceCallbacks = this.root.onKeydown.installWorkspaceCallbacks()
      const unsubscribeIpc = installAppIpcSubscriptions({
        openThreadFromNotification: this.root.onKeydown.openThreadFromNotification,
        setCloseConfirmation: (payload) =>
          (this.root.settleCloseConfirmationThread.closeConfirmation = payload),
        confirmForceClose: this.root.settleCloseConfirmationThread.confirmForceClose,
        parkWindow: this.root.settleCloseConfirmationThread.parkWindow,
        setInstanceRole: (role) => (this.root.state.instanceRole = role),
        settleCloseConfirmationThread:
          this.root.settleCloseConfirmationThread.settleCloseConfirmationThread,
        showStartAtLoginOffer: () => (this.root.updateConfig.startAtLoginOfferOpen = true),
        handleCloseShortcut: this.root.onKeydown.handleCloseShortcut,
        handleNewTerminalShortcut: this.root.state.handleNewTerminalShortcut,
        goBack: () => this.root.openAssistantFromSearch.handleMouseHistoryNavigation('back'),
        goForward: () => this.root.openAssistantFromSearch.handleMouseHistoryNavigation('forward'),
        handleOpenedPaths: (paths) =>
          handleOpenedPaths(paths, this.root.spotlightPalette.osHandoffDeps),
        applyThreadSearchIntent: this.root.spotlightPalette.applyThreadSearchIntent
      })
      // Hydrate the instance role: the push fires before this renderer mounts, so
      // this read is what shows the "running in another instance" notice on load.
      void invoke('app:instanceRole')
        .then((role) => (this.root.state.instanceRole = role))
        .catch(() => undefined)
      const unsubscribeShutdown = this.root.state.installShutdownSubscription()
      const unsubscribeConfig = this.root.updateConfig.installConfigSubscription()
      const originalOpenThread = workspaceState.openThread.bind(workspaceState)
      const originalClearThread = workspaceState.clearThread.bind(workspaceState)
      workspaceState.openThread = (thread, project, iconUrl) => {
        originalOpenThread(thread, project, iconUrl)
        this.root.openAssistantFromSearch.observeNavigationLocation()
      }
      workspaceState.clearThread = (rememberEmpty = true) => {
        originalClearThread(rememberEmpty)
        this.root.openAssistantFromSearch.observeNavigationLocation()
      }
      this.root.openAssistantFromSearch.observeNavigationLocation()
      void this.root.updateConfig.loadConfig()
      // The keymap pushes the browser's chords whenever the config loads, but main's
      // window-bound browser handlers are registered after the first paint, so that
      // push can land before they exist and be dropped. The browser would then claim
      // none of its own keys (Cmd/Ctrl+T, Cmd/Ctrl+W, find) until the next keymap
      // change. This publishes now and again on every `app:featuresReady`, which
      // main sends once those handlers are up.
      installBrowserShortcutPublishing(keymapState)
      // Every launch leaves the browser alone: no chunk fetched, no store built,
      // no stored tab list read, no listener registered. The one exception is a
      // session that restores straight onto the browser view, where the page the
      // user was reading is what they came back to, so its runtime is asked for at
      // boot instead of on the first reach.
      if (this.root.onKeydown.activeView === 'browser') void loadBrowser()
      // Fire-and-forget: the app's own record of models reported as
      // vision-capable, consulted before any vision-capability gate.
      void visionModels.load().catch(() => {})
      // Fire-and-forget: probes opted-in harnesses and docks quiet auto-updates.
      // Nothing on the first frame reads it (the update badges live in Settings and
      // in the rail's control), so it waits for the renderer to go idle rather than
      // starting its harness probes while the thread list is still hydrating.
      scheduleDeferredWork(
        'harness:autoUpdate',
        () => void harnessLifecycleStore.autoUpdateOnStartup()
      )
      // The context sidebar's panels are all dynamic imports, and the rail's tab
      // strip, the terminal chords and a restored session reach them without the
      // hover that `page-preload` relies on. Warming every panel once here, after
      // the first paint and while the renderer is idle, is what makes the first
      // open of the Git, files, diff or terminal panel instant instead of a cold
      // chunk fetch on the click.
      scheduleDeferredWork('sidebar:panels', warmSidebarPanels)
      // The global panels (notifications, sticky notes) are dynamic imports in
      // `AppPanelHost`, reached only from the rail's tab strip with no hover in
      // front of the click. Warming their chunks here is what keeps the first
      // open of the notification panel from painting blank while its module is
      // fetched.
      scheduleDeferredWork('app:panels', warmAppPanels)
      // Workspace owns the initial project/thread hydration. Keeping this signal
      // there prevents App and Workspace from issuing the same startup queries.

      return () => {
        mq.removeEventListener('change', onColorSchemeChange)
        window.removeEventListener('keydown', this.root.onKeydown.onKeydown)
        window.removeEventListener(
          'mousedown',
          this.root.openAssistantFromSearch.onMouseHistoryButton
        )
        window.removeEventListener(
          'auxclick',
          this.root.openAssistantFromSearch.onMouseHistoryButton
        )
        uninstallVoiceShortcut()
        uninstallComposerFocusShortcut()
        restoreWorkspaceCallbacks()
        unsubscribeIpc()
        unsubscribeShutdown()
        unsubscribeConfig()
        workspaceState.openThread = originalOpenThread
        workspaceState.clearThread = originalClearThread
      }
    })
  }
}
