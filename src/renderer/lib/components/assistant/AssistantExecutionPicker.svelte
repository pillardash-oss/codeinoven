<script lang="ts">
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import type { AssistantExecution } from '$shared/types'
  import { assistants } from '$lib/stores/assistants.svelte'
  import OvenPickerMenu from '../threads/OvenPickerMenu.svelte'

  interface Props {
    assistantId: string
    execution?: AssistantExecution
  }
  let { assistantId, execution }: Props = $props()

  /**
   * Persist the chosen target. Local clears the target, so the assistant's runs
   * return to this computer; any other Oven is stored as the run environment.
   */
  async function select(ovenId: string, ovenPath: string): Promise<void> {
    const next: AssistantExecution | null =
      ovenId === LOCAL_OVEN_ID ? null : { ovenId, ...(ovenPath ? { ovenPath } : {}) }
    await assistants.updateAssistant(assistantId, { execution: next })
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center justify-between gap-2">
    <h2 class="text-[0.6875rem] font-medium text-muted">Runs on</h2>
    <OvenPickerMenu
      selectedId={execution?.ovenId ?? LOCAL_OVEN_ID}
      selectedPath={execution?.ovenPath}
      label="Choose the Oven this assistant runs on"
      onSelect={select}
    />
  </div>
  <p class="text-[0.6875rem] leading-relaxed text-dimmed">
    {execution
      ? 'Tasks use this Oven by default. A task can override this choice.'
      : 'Tasks use this computer by default. Choose an Oven to run them on another machine.'}
  </p>
</div>
