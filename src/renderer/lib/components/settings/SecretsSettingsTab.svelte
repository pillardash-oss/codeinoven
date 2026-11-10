<script lang="ts">
  import { secretsPageState } from '$lib/stores/secrets-page-state.svelte'
  import { APP_NAME } from '$shared/brand'
  import EnvFilesPanel from './secrets-settings/EnvFilesPanel.svelte'
  import ThreadEnvPanel from './secrets-settings/ThreadEnvPanel.svelte'

  /**
   * Project env files.
   *
   * The page is the editor for a project's `.env` family: names, groups and run
   * modes live here, values live in the encrypted store, and the processes the app
   * starts receive them. Every reply from the main process is a manifest, so this
   * surface never holds a value.
   *
   * The app's own credentials (provider tokens, capability credentials, sign-ins)
   * are owned by the surface that uses them and are not listed here.
   */
  const target = $derived(secretsPageState.target)
  const openedProjectId = $derived(target?.projectId)
  const openedDirectory = $derived(target?.directory ?? '')
  const openedThreadId = $derived(target?.threadId)
</script>

<div class="p-6 pb-24">
  <div class="mb-6">
    <h1 class="text-xl font-bold tracking-tight">Secrets</h1>
    <p class="mt-0.5 text-sm text-muted">
      Project env files, held in {APP_NAME}'s encrypted store instead of the repository. A value is
      written once and never shown again: the file keeps a reference, and any process the app starts
      for that project receives it.
    </p>
  </div>

  <div class="space-y-4">
    <EnvFilesPanel projectId={openedProjectId} directory={openedDirectory} />
    {#if openedThreadId}
      {#key openedThreadId}
        <ThreadEnvPanel threadId={openedThreadId} />
      {/key}
    {/if}
  </div>
</div>
