<script lang="ts">
  import { Trash2 } from '@lucide/svelte'
  import type { UtilityDefinition } from '$shared/types'
  import type { UtilityDraft } from './utility-editor-modal-helpers'

  interface Props {
    draft: UtilityDraft
    utilities: UtilityDefinition[]
    secureStorageAvailable: boolean
    credentialEnvironmentVariable: string
    credentialValue: string
    onRemoveCredential: (utilityId: string, credentialId: string) => void
  }

  let {
    draft,
    utilities,
    secureStorageAvailable,
    credentialEnvironmentVariable = $bindable(),
    credentialValue = $bindable(),
    onRemoveCredential
  }: Props = $props()
</script>

<fieldset class="space-y-3 rounded-xl border p-3">
  <legend class="px-1 text-xs font-semibold">
    {draft.kind === 'mcp' ? 'MCP secret' : 'API key'}
  </legend>
  {#if draft.id}
    {@const utility = utilities.find((candidate) => candidate.id === draft.id)}
    {#each utility?.credentials ?? [] as credential (credential.id)}
      <div class="flex items-center justify-between rounded-lg bg-elevated px-2 py-1.5">
        <div class="min-w-0">
          <p class="truncate text-xs font-medium">{credential.label}</p>
          <p class="truncate text-[0.625rem] text-dimmed">
            Stored securely · {credential.environmentVariable ?? credential.id}
          </p>
        </div>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
          type="button"
          aria-label="Remove {credential.label}"
          title="Remove {credential.label}"
          onclick={() => onRemoveCredential(utility?.id ?? '', credential.id)}
        >
          <Trash2 size={13} />
        </button>
      </div>
    {/each}
  {/if}
  <div class="grid gap-2 sm:grid-cols-2">
    <label class="space-y-1 text-xs font-medium">
      <span>Environment variable</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
        placeholder="API_TOKEN"
        bind:value={credentialEnvironmentVariable}
      />
    </label>
    <label class="space-y-1 text-xs font-medium">
      <span>Secret value</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
        type="password"
        autocomplete="off"
        placeholder={draft.id ? 'Leave blank to keep stored secret' : 'Paste secret'}
        disabled={!secureStorageAvailable}
        bind:value={credentialValue}
      />
    </label>
  </div>
  <p class="text-[0.6875rem] text-dimmed">
    Saved to encrypted device storage and injected only while this capability is active.
  </p>
</fieldset>
