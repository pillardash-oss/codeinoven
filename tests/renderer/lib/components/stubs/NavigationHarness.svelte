<script lang="ts">
  import { AppHeaderNavigationController } from '$lib/components/layout/AppHeaderNavigationController.svelte'
  import type { MainView } from '$lib/stores/renderer-recovery'

  /**
   * Constructs the real view-navigation controller inside a component root, so
   * its reactive effects run and the test can drive the class the app shell
   * drives. The controller owns the rail's primary navigation, so testing it
   * directly is testing what a rail click does.
   */
  interface Props {
    /** The view the fake shell is showing for the whole test. */
    activeView: MainView
    onNavigate: (view: MainView) => void
    onReady: (controller: AppHeaderNavigationController) => void
  }

  let { activeView, onNavigate, onReady }: Props = $props()

  const controller = new AppHeaderNavigationController({
    getActiveView: () => activeView,
    navigate: (view) => onNavigate(view)
  })

  // Hand the mounted controller to the test through the prop, so the read stays
  // inside a closure instead of capturing the prop's initial value.
  const reportReady = (): void => onReady(controller)
  reportReady()
</script>
