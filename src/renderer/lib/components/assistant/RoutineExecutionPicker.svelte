<script lang="ts">
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import type { RoutineExecution } from '$shared/types'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import OvenPickerMenu from '../threads/OvenPickerMenu.svelte'

  interface Props {
    routineId: string
    execution?: RoutineExecution
  }
  let { routineId, execution }: Props = $props()

  /**
   * Persist the chosen target. Local clears the target, so the routine's runs
   * return to this computer; any other Oven is stored as the run environment.
   */
  async function select(ovenId: string, ovenPath: string): Promise<void> {
    const next: RoutineExecution | null =
      ovenId === LOCAL_OVEN_ID ? null : { ovenId, ...(ovenPath ? { ovenPath } : {}) }
    await assistantRoutines.updateRoutine(routineId, { execution: next })
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center justify-between gap-2">
    <h2 class="text-[0.6875rem] font-medium text-muted">Runs on</h2>
    <OvenPickerMenu
      selectedId={execution?.ovenId ?? LOCAL_OVEN_ID}
      selectedPath={execution?.ovenPath}
      label="Choose the Oven this routine runs on"
      onSelect={select}
    />
  </div>
  <p class="text-[0.6875rem] leading-relaxed text-dimmed">
    {execution
      ? 'Every run of this routine executes on this Oven. A task that picks its own Oven overrides it.'
      : 'Runs execute on this computer. Pick an Oven to keep scheduled work off your device.'}
  </p>
</div>
