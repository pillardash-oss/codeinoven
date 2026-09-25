<script lang="ts">
  import { Plus, X } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { APP_NAME } from '$shared/brand'
  import {
    APP_PROTOTYPE_CDN_ORIGINS,
    MAX_PROTOTYPE_CDN_ORIGINS,
    normalizePrototypeCdnOrigin
  } from '$shared/prototypes/prototype-cdn'
  import Switch from '../ui/Switch.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  /** The entry being typed. Cleared once it lands in the allowlist. */
  let candidate = $state('')

  /**
   * Origins the user added, shown normalized. A config written by hand could
   * hold an entry that no longer normalizes, so the original spelling is kept
   * for display and left for the validator to reject on the next save.
   */
  const userOrigins = $derived(
    (config.prototypeCdnAllowlist ?? []).map(
      (entry) => normalizePrototypeCdnOrigin(entry) ?? entry.trim()
    )
  )
  const builtInOrigins = $derived(APP_PROTOTYPE_CDN_ORIGINS.map((origin) => origin))
  const pendingOrigin = $derived(normalizePrototypeCdnOrigin(candidate))
  const atCapacity = $derived(userOrigins.length >= MAX_PROTOTYPE_CDN_ORIGINS)
  const canAdd = $derived(
    pendingOrigin !== null && !builtInOrigins.includes(pendingOrigin) && !atCapacity
  )

  function addOrigin(): void {
    const origin = normalizePrototypeCdnOrigin(candidate)
    if (!origin) {
      toast.error('Enter an HTTPS origin, for example cdn.example.com')
      return
    }
    if (builtInOrigins.includes(origin) || userOrigins.includes(origin)) {
      toast.error('That CDN is already approved.')
      return
    }
    if (atCapacity) {
      toast.error(`Prototypes accept at most ${MAX_PROTOTYPE_CDN_ORIGINS} added CDNs.`)
      return
    }
    candidate = ''
    void updateConfig({ prototypeCdnAllowlist: [...(config.prototypeCdnAllowlist ?? []), origin] })
  }

  function removeOrigin(origin: string): void {
    void updateConfig({
      prototypeCdnAllowlist: (config.prototypeCdnAllowlist ?? []).filter(
        (entry) => (normalizePrototypeCdnOrigin(entry) ?? entry.trim()) !== origin
      )
    })
  }

  function submitAdd(event: SubmitEvent): void {
    event.preventDefault()
    addOrigin()
  }
</script>

<div class="mt-4 border-t pt-4">
  <div class="flex items-center justify-between gap-4">
    <div>
      <p class="text-sm font-medium">Allow external CDNs in prototypes</p>
      <p class="text-xs leading-relaxed text-dimmed">
        Let generated prototypes load fonts, styles, scripts, and images from approved CDNs
      </p>
    </div>
    <Switch
      checked={config.allowPrototypeExternalCdn}
      onchange={(checked) => void updateConfig({ allowPrototypeExternalCdn: checked })}
      aria-label="Toggle external CDNs for prototype previews"
      disabled={!settingsReady}
    />
  </div>

  {#if config.allowPrototypeExternalCdn}
    <div class="mt-3 space-y-3">
      <div>
        <p class="text-xs font-medium text-muted">Always approved</p>
        <ul class="mt-1.5 flex flex-wrap gap-1.5">
          {#each builtInOrigins as origin (origin)}
            <li
              class="rounded-md border bg-elevated px-2 py-1 font-mono text-xs text-muted"
              title={`${origin} is approved by ${APP_NAME}`}
            >
              {origin}
            </li>
          {/each}
        </ul>
      </div>

      {#if userOrigins.length > 0}
        <div>
          <p class="text-xs font-medium text-muted">Your CDNs</p>
          <ul class="mt-1.5 flex flex-wrap gap-1.5">
            {#each userOrigins as origin (origin)}
              <li class="flex items-center gap-1 rounded-md border bg-elevated py-1 pl-2 pr-1">
                <span class="font-mono text-xs text-foreground">{origin}</span>
                <button
                  type="button"
                  class="rounded p-0.5 text-muted hover:bg-overlay hover:text-foreground disabled:opacity-50"
                  title={`Remove ${origin} from approved prototype CDNs`}
                  aria-label={`Remove ${origin} from approved prototype CDNs`}
                  disabled={!settingsReady}
                  onclick={() => removeOrigin(origin)}
                >
                  <X size={12} />
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <form class="flex items-center gap-2" onsubmit={submitAdd}>
        <input
          type="text"
          class="h-9 min-w-0 flex-1 rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary disabled:opacity-50"
          placeholder="cdn.example.com"
          aria-label="CDN origin to approve for prototype previews"
          bind:value={candidate}
          disabled={!settingsReady || atCapacity}
        />
        <button
          type="submit"
          class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium outline-none hover:bg-overlay focus:border-primary disabled:opacity-50"
          title="Approve this CDN for prototype previews"
          aria-label="Approve this CDN for prototype previews"
          disabled={!settingsReady || !canAdd}
        >
          <Plus size={13} />
          Add
        </button>
      </form>
      <p class="text-xs leading-relaxed text-dimmed">
        Approved hosts load in prototype previews immediately. Everything else stays blocked, so
        inline anything a prototype needs beyond these CDNs.
      </p>
    </div>
  {:else}
    <p class="mt-3 text-xs leading-relaxed text-dimmed">
      Prototypes stay offline: every style, script, font, and image must be inlined in the page.
    </p>
  {/if}
</div>
