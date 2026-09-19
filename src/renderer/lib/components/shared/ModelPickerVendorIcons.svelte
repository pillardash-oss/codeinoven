<script lang="ts">
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import ModelPickerHarnessIcon from './ModelPickerHarnessIcon.svelte'
  import { vendorMatches } from './model-picker-helpers'

  interface Props {
    harnessId: string
    providerName: string
    providerId?: string
  }

  let { harnessId, providerName, providerId }: Props = $props()
</script>

<ModelPickerHarnessIcon {harnessId} />
{#if !vendorMatches(harnessId, providerId ?? providerName)}
  <VendorIcon name={providerName} id={providerId} size={12} />
{/if}
