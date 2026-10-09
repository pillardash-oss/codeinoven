<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { FEEDBACK_URL, GITHUB_URL, SUPPORT_EMAIL } from '$shared/brand'
  import type { AppConfig, AppConfigPatch } from '$shared/types'
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import Switch from '../ui/Switch.svelte'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }
  let { config, settingsReady, updateConfig }: Props = $props()
  let saving = $state(false)
  let issueUrl = $state(`${GITHUB_URL}/issues/new/choose`)
  const actions = $derived([
    {
      label: 'Report an issue',
      url: issueUrl,
      title: 'Report an issue on GitHub'
    },
    {
      label: 'Send feedback',
      url: FEEDBACK_URL,
      title: `Send feedback to ${SUPPORT_EMAIL} in your email app`
    },
    {
      label: 'Contribute',
      url: `${GITHUB_URL}/blob/main/CONTRIBUTING.md`,
      title: 'Open the repository to contribute a pull request'
    }
  ])

  onMount(() => {
    void invoke('community:getIssueUrl')
      .then((url) => {
        issueUrl = url
      })
      .catch(() => {
        // The issue chooser remains available if metadata could not be loaded.
      })
  })

  async function open(url: string): Promise<void> {
    try {
      await invoke('shell:openExternal', url)
    } catch {
      toast.error('Could not open the link')
    }
  }

  async function setConsent(shareAnonymousUsage: boolean): Promise<void> {
    saving = true
    try {
      await updateConfig({ shareAnonymousUsage })
    } finally {
      saving = false
    }
  }
</script>

<div id="settings-block-about-community" class="mt-4 rounded-xl border bg-surface p-4">
  <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Community</h3>
  <p class="text-xs leading-relaxed text-dimmed">
    Report a bug, send feedback, or contribute on GitHub.
  </p>
  <div class="mt-3 flex flex-wrap gap-2">
    {#each actions as action (action.label)}
      <button
        type="button"
        class="flex h-9 items-center rounded-lg border bg-elevated px-3.5 text-xs font-medium hover:bg-overlay"
        title={action.title}
        data-external-url={action.url}
        onclick={() => void open(action.url)}
      >
        {action.label}
      </button>
    {/each}
  </div>
</div>

<div id="settings-block-about-privacy" class="mt-4 rounded-xl border bg-surface p-4">
  <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Privacy</h3>
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <p class="text-sm font-medium">Share anonymous usage statistics</p>
      <p
        id="usage-statistics-description"
        class="mt-0.5 max-w-xl text-xs leading-relaxed text-dimmed"
      >
        Sends the app version, operating system, CPU architecture, and daily activity to PostHog
        under a random installation ID. Prompts, code, project paths, and conversations are never
        sent.
      </p>
    </div>
    <Switch
      checked={config.shareAnonymousUsage === true}
      disabled={!settingsReady || saving}
      title="Share anonymous usage statistics"
      aria-label="Share anonymous usage statistics"
      aria-describedby="usage-statistics-description"
      onchange={(enabled) => void setConsent(enabled)}
    />
  </div>
</div>
