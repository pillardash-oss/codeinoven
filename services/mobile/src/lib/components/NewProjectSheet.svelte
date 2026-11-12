<script lang="ts">
  import { onMount } from 'svelte'
  import { goto, invalidateAll } from '$app/navigation'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { api, ApiError } from '#lib/api/client'
  import Sheet from './Sheet.svelte'

  /**
   * A project started from the phone. It is a name and nothing else: the phone
   * holds no checkout, so the path, the Oven and the provider are what the
   * desktop fills in the moment it reports the project it works in.
   *
   * The sheet exists so a new account is not stuck on an empty list until a
   * desktop signs in: the first project, and the thread that follows it, can
   * both start here.
   */
  interface Props {
    open: boolean
    onclose: () => void
    /** Called with the project the service created, before the list reloads. */
    oncreated?: (name: string) => void
  }

  let { open, onclose, oncreated }: Props = $props()

  let name = $state('')
  let error = $state<string | null>(null)
  let saving = $state(false)

  let canCreate = $derived(name.trim().length > 0 && !saving)

  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
  }

  function reset(): void {
    name = ''
    error = null
  }

  function close(): void {
    if (saving) return
    reset()
    onclose()
  }

  async function create(): Promise<void> {
    const body = name.trim()
    if (body.length === 0 || saving) return
    saving = true
    error = null
    try {
      const project = await api.createProject({ name: body })
      reset()
      oncreated?.(project.name)
      onclose()
      await invalidateAll()
      await goto(`/projects?project=${project.id}`)
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'The project could not be started.'
    } finally {
      saving = false
    }
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void create()
  }

  onMount(() => {
    // A sheet reopened after a failure starts clean rather than holding a name
    // the service already refused.
    if (!open) reset()
  })
</script>

<Sheet {open} onclose={close} label="New project">
  <form class="sheet-form" onsubmit={onSubmit}>
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      <h2>New project</h2>
      <button type="button" onclick={close}>Cancel</button>
    </div>

    <label class="sheet-field">
      <span>What is the project called?</span>
      <input
        {@attach focusOnMount}
        bind:value={name}
        type="text"
        placeholder="A short name for the project"
        autocomplete="off"
        maxlength="120"
      />
    </label>

    {#if error}
      <p class="sheet-error" role="status">{error}</p>
    {/if}

    <div class="sheet-foot">
      <button class="btn quiet" type="button" onclick={close}>Cancel</button>
      <button class="btn primary with-icon" type="submit" disabled={!canCreate}>
        <CioPlus size={14} />
        {saving ? 'Starting' : 'Start project'}
      </button>
    </div>
  </form>
</Sheet>
