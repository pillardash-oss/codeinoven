<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { Thread, ThreadSettings } from '$shared/types'
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import OvenPickerMenu from './OvenPickerMenu.svelte'

  interface Props {
    thread: Thread
    settings: ThreadSettings
    busy: boolean
    onSettingsChange: (settings: ThreadSettings) => void
  }
  let { thread, settings, busy, onSettingsChange }: Props = $props()
  let menu: OvenPickerMenu | undefined = $state(undefined)

  onMount(() => {
    void invoke('oven:state')
      .then(() => {
        if (!settings.ovenId && !thread.sessionId && thread.status === 'created') {
          onSettingsChange({ ...settings, ovenId: LOCAL_OVEN_ID, ovenPath: undefined })
        }
      })
      .catch(() => {
        // The picker surfaces its own load error when the user opens it.
      })
  })

  export async function openPicker(): Promise<void> {
    await menu?.openPicker()
  }

  async function select(ovenId: string, ovenPath: string): Promise<void> {
    await invoke('thread:updateSettings', thread.projectId, thread.id, settings)
    const updated = await invoke(
      'oven:selectThread',
      thread.projectId,
      thread.id,
      ovenId,
      ovenPath || undefined
    )
    if (updated.settings) onSettingsChange(updated.settings)
  }
</script>

<OvenPickerMenu
  bind:this={menu}
  selectedId={settings.ovenId ?? LOCAL_OVEN_ID}
  selectedPath={settings.ovenPath}
  {busy}
  label="Choose the Oven for this chat"
  onSelect={select}
/>
