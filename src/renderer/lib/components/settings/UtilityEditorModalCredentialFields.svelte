<script lang="ts">
  import { KeyRound, Plus, Trash2 } from '@lucide/svelte'
  import type { UtilityDefinition, UtilityCredentialMetadata } from '$shared/types'
  import type { UtilityDraft } from './utility-editor-modal-helpers'

  interface Props {
    draft: UtilityDraft
    utilities: UtilityDefinition[]
    secureStorageAvailable: boolean
    /** Credential the value form writes to; `null` means a brand-new secret. */
    targetId: string | null
    environmentVariable: string
    value: string
    onSelectCredential: (credential: UtilityCredentialMetadata) => void
    onAddCredential: () => void
    onRemoveCredential: (utilityId: string, credentialId: string) => void
  }

  let {
    draft,
    utilities,
    secureStorageAvailable,
    targetId,
    environmentVariable = $bindable(),
    value = $bindable(),
    onSelectCredential,
    onAddCredential,
    onRemoveCredential
  }: Props = $props()

  /**
   * A utility may need more than one secret (an OAuth client id *and* its
   * secret, for example), so the list is the declaration of record and the
   * value form only ever writes to the one credential the user picked.
   */
  let credentials = $derived(
    (draft.id ? utilities.find((utility) => utility.id === draft.id)?.credentials : undefined) ?? []
  )
  let target = $derived(credentials.find((credential) => credential.id === targetId) ?? null)
  /** The variable name typed for a new secret, matched against what is stored. */
  let typedVariable = $derived(environmentVariable.trim())
  let storedForTyped = $derived(
    credentials.find(
      (credential) =>
        credential.environmentVariable === typedVariable || credential.id === typedVariable
    ) ?? null
  )
</script>

<fieldset class="space-y-3 rounded-xl border p-3">
  <legend class="px-1 text-xs font-semibold">
    {draft.kind === 'mcp' ? 'MCP secrets' : 'API key'}
  </legend>
  {#each credentials as credential (credential.id)}
    {@const selected = credential.id === targetId}
    <div
      class="flex items-center justify-between gap-2 rounded-lg bg-elevated px-2 py-1.5 {selected
        ? 'ring-1 ring-primary/40'
        : ''}"
    >
      <div class="min-w-0">
        <p class="truncate text-xs font-medium">{credential.label}</p>
        <p class="truncate text-[0.625rem] text-dimmed">
          Stored securely · {credential.environmentVariable ?? credential.id}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          disabled={selected}
          aria-label={selected
            ? `Editing ${credential.label}`
            : `Set the value for ${credential.label}`}
          title={selected ? `Editing ${credential.label}` : `Set the value for ${credential.label}`}
          onclick={() => onSelectCredential(credential)}
        >
          <KeyRound size={13} />
        </button>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
          type="button"
          aria-label="Remove {credential.label}"
          title="Remove {credential.label}"
          onclick={() => onRemoveCredential(draft.id ?? '', credential.id)}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  {/each}
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-xs font-medium">
      {target
        ? `Replace ${target.label}`
        : credentials.length
          ? 'Add another secret'
          : 'Add a secret'}
    </p>
    {#if target}
      <button
        class="flex h-7 items-center gap-1 rounded-lg border px-2 text-[0.6875rem] font-medium text-muted hover:bg-overlay hover:text-foreground"
        type="button"
        title="Add another secret to this capability"
        onclick={onAddCredential}
      >
        <Plus size={12} />
        Add secret
      </button>
    {/if}
  </div>
  <div class="grid gap-2 sm:grid-cols-2">
    <label class="space-y-1 text-xs font-medium">
      <span>Environment variable</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
        placeholder="API_TOKEN"
        bind:value={environmentVariable}
      />
    </label>
    <label class="space-y-1 text-xs font-medium">
      <span>Secret value</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
        type="password"
        autocomplete="off"
        placeholder={target ? 'Leave blank to keep stored secret' : 'Paste secret'}
        disabled={!secureStorageAvailable}
        bind:value
      />
    </label>
  </div>
  {#if !target && typedVariable && !value.trim()}
    <p class="text-[0.6875rem] text-muted">
      {storedForTyped
        ? `Add a value to replace the stored ${typedVariable}.`
        : `Add a value to register ${typedVariable}.`}
    </p>
  {/if}
  <p class="text-[0.6875rem] text-dimmed">
    Saved to encrypted device storage and injected only while this capability is active.
  </p>
</fieldset>
