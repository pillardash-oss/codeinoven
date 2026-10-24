<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import type { IdeLanguageServer } from '$shared/ide-language-servers'
  import { validateIdeLanguageServers } from '$shared/ide-language-servers'
  interface Props {
    server: IdeLanguageServer
    onClose: () => void
    onSave: (server: IdeLanguageServer) => Promise<void>
  }
  let { server, onClose, onSave }: Props = $props()
  function initialFields() {
    return {
      name: server.name,
      command: server.command,
      args: server.args.join('\n'),
      markers: server.rootMarkers.join('\n'),
      env: JSON.stringify(server.env, null, 2),
      initializationOptions: JSON.stringify(server.initializationOptions, null, 2),
      settings: JSON.stringify(server.settings, null, 2)
    }
  }
  function initialMappings() {
    const groups: { id: string; languageId: string; extensions: string }[] = []
    for (const mapping of server.languages) {
      const group = groups.find((item) => item.languageId === mapping.languageId)
      if (group) group.extensions += `, ${mapping.extension}`
      else
        groups.push({
          id: crypto.randomUUID(),
          languageId: mapping.languageId,
          extensions: mapping.extension
        })
    }
    return groups.length ? groups : [{ id: crypto.randomUUID(), languageId: '', extensions: '' }]
  }
  let mappings = $state(initialMappings())
  let fields = $state(initialFields())
  let error = $state('')
  let saving = $state(false)
  const inputClass =
    'mt-1 w-full border border-border bg-app px-3 py-2 text-sm text-foreground outline-none focus:border-primary'
  async function save(): Promise<void> {
    if (saving) return
    saving = true
    error = ''
    try {
      const languages = mappings.flatMap((mapping) => {
        const extensions = mapping.extensions.split(/[\s,]+/).filter(Boolean)
        if (!extensions.length) return []
        if (!mapping.languageId.trim())
          throw new Error('Enter a language ID for each set of file extensions')
        return extensions.map((extension) => ({ extension, languageId: mapping.languageId.trim() }))
      })
      const [result] = validateIdeLanguageServers([
        {
          ...server,
          name: fields.name,
          command: fields.command,
          args: fields.args.split('\n').filter((line) => line.length),
          languages,
          rootMarkers: fields.markers
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          env: JSON.parse(fields.env),
          initializationOptions: JSON.parse(fields.initializationOptions),
          settings: JSON.parse(fields.settings)
        }
      ])
      await onSave(result)
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason)
    } finally {
      saving = false
    }
  }
</script>

<Modal open title="Language server" size="lg" {onClose}>
  <div class="space-y-4">
    <label class="block text-xs text-muted"
      >Name<input class={inputClass} bind:value={fields.name} /></label
    >
    <label class="block text-xs text-muted"
      >Executable<input
        class={inputClass}
        bind:value={fields.command}
        placeholder="gopls or an absolute executable path"
      /></label
    >
    <p class="text-xs text-muted">
      Commands run directly over stdio. Put each argument on its own line.
    </p>
    <div class="grid gap-4 sm:grid-cols-2">
      <label class="block text-xs text-muted"
        >Arguments, one per line<textarea
          maxlength={131072}
          class={`${inputClass} font-mono`}
          rows="3"
          bind:value={fields.args}></textarea></label
      >
    </div>
    <fieldset class="space-y-3">
      <legend class="mb-2 text-sm font-medium text-foreground">Languages and files</legend>
      {#each mappings as mapping (mapping.id)}
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block text-xs text-muted"
            >Language ID<input
              class={inputClass}
              bind:value={mapping.languageId}
              placeholder="python"
            /></label
          >
          <label class="block text-xs text-muted"
            >File extensions<input
              class={inputClass}
              bind:value={mapping.extensions}
              placeholder=".py, .pyi"
            /></label
          >
        </div>
      {/each}
      <div class="flex justify-end">
        <button
          type="button"
          class="border border-border px-3 py-2 text-xs text-foreground hover:bg-elevated"
          disabled={mappings.length >= 64}
          onclick={() =>
            (mappings = [...mappings, { id: crypto.randomUUID(), languageId: '', extensions: '' }])}
          >Add language</button
        >
      </div>
    </fieldset>
    <details class="border border-border p-3">
      <summary class="cursor-pointer text-sm text-foreground">Advanced settings</summary>
      <div class="mt-3 space-y-4">
        <label class="block text-xs text-muted"
          >Workspace root markers, one name per line<textarea
            maxlength={131072}
            class={`${inputClass} font-mono`}
            rows="2"
            bind:value={fields.markers}
            placeholder="go.mod"></textarea></label
        >
        <label class="block text-xs text-muted"
          >Environment, JSON object<textarea
            maxlength={131072}
            class={`${inputClass} font-mono`}
            rows="3"
            bind:value={fields.env}></textarea></label
        >
        <p class="text-xs text-muted">
          Environment values can reference inherited variables using {'${VARIABLE}'}. Credentials
          should stay in the environment.
        </p>
        <label class="block text-xs text-muted"
          >Initialization options, JSON object<textarea
            maxlength={131072}
            class={`${inputClass} font-mono`}
            rows="4"
            bind:value={fields.initializationOptions}></textarea></label
        >
        <label class="block text-xs text-muted"
          >Server settings, JSON object<textarea
            maxlength={131072}
            class={`${inputClass} font-mono`}
            rows="4"
            bind:value={fields.settings}></textarea></label
        >
      </div>
    </details>
    {#if error}<p role="alert" class="text-xs text-danger">{error}</p>{/if}
  </div>
  {#snippet footer()}
    <button type="button" class="px-3 py-2 text-sm text-muted" onclick={onClose}>Cancel</button>
    <button
      type="button"
      data-modal-primary
      class="bg-primary px-3 py-2 text-sm font-medium text-on-primary disabled:opacity-40"
      disabled={saving}
      onclick={() => void save()}>{saving ? 'Saving...' : 'Save server'}</button
    >
  {/snippet}
</Modal>
