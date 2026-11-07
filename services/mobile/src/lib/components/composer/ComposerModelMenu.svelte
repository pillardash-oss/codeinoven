<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioLayers from '@pdslng/cio-icon/CioLayers.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioStar from '@pdslng/cio-icon/CioStar.svelte'
  import VendorMark from '../VendorMark.svelte'
  import type { Model } from '#lib/api/types'

  /**
   * The model picker, drawn the way the desktop draws it: a section rail on the
   * left, a search row, then the grouped list. Recent is a real reading of the
   * models this account's threads ran, and every provider group is the catalog
   * the service offers, so nothing here is a fixed list in the client.
   */
  interface Props {
    models: Model[]
    recent: string[]
    phase: 'idle' | 'loading' | 'ready' | 'error'
    selected: string | null
    onpick: (id: string) => void
    onretry: () => void
    onclose: () => void
  }

  let { models, recent, phase, selected, onpick, onretry, onclose }: Props = $props()

  type Rail = 'all' | 'favorite' | string

  let rail = $state<Rail>('all')
  let query = $state('')
  let providers = $derived.by(() => {
    const out: { id: string; label: string }[] = []
    for (const model of models) {
      if (!out.some((provider) => provider.id === model.provider)) {
        out.push({ id: model.provider, label: model.providerLabel })
      }
    }
    return out
  })

  let visible = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    return models.filter((model) => {
      if (rail === 'favorite' && !model.favorite) return false
      if (rail !== 'all' && rail !== 'favorite' && model.provider !== rail) return false
      if (needle.length === 0) return true
      return (
        model.name.toLowerCase().includes(needle) ||
        model.providerLabel.toLowerCase().includes(needle)
      )
    })
  })

  let recentModels = $derived.by(() => {
    const byId = new Map(visible.map((model) => [model.id, model]))
    return recent.map((id) => byId.get(id)).filter((model): model is Model => model !== undefined)
  })

  interface Group {
    key: string
    label: string
    count: number
    models: Model[]
  }

  let groups: Group[] = $derived.by(() => {
    if (rail === 'favorite') {
      return [{ key: 'favorites', label: 'Favorites', count: visible.length, models: visible }]
    }
    const out: Group[] = []
    if (recentModels.length > 0) {
      out.push({
        key: 'recent',
        label: 'Recent',
        count: recentModels.length,
        models: recentModels
      })
    }
    for (const provider of providers) {
      if (rail !== 'all' && rail !== provider.id) continue
      const items = visible.filter((model) => model.provider === provider.id)
      if (items.length === 0) continue
      out.push({
        key: provider.id,
        label: provider.label,
        count: models.filter((model) => model.provider === provider.id).length,
        models: items
      })
    }
    return out
  })

  /** The field takes focus the moment the panel is mounted, because the person
   *  opened this panel to choose and typing is the quickest way to do it. */
  function focusSearch(node: HTMLInputElement): void {
    node.focus()
  }
</script>

<div class="cpanel model-menu" role="dialog" aria-label="Select model">
  <nav class="model-rail" aria-label="Model picker sections">
    <button
      type="button"
      aria-current={rail === 'all'}
      aria-label="Show all models"
      title="Show all models"
      onclick={() => (rail = 'all')}
    >
      <CioLayers size={16} />
    </button>
    <button
      type="button"
      aria-current={rail === 'favorite'}
      aria-label="Show favorite models only"
      title="Show favorite models only"
      onclick={() => (rail = 'favorite')}
    >
      <CioStar size={16} />
    </button>
    <span class="rail-sep" aria-hidden="true"></span>
    {#each providers as provider (provider.id)}
      <button
        type="button"
        aria-current={rail === provider.id}
        aria-label={`Show ${provider.label} models`}
        title={`Show ${provider.label} models`}
        onclick={() => (rail = provider.id)}
      >
        <VendorMark name={provider.id} size={16} />
      </button>
    {/each}
  </nav>

  <div class="model-col">
    <div class="model-search">
      <CioSearch size={12} />
      <input
        {@attach focusSearch}
        bind:value={query}
        type="search"
        placeholder="Search models"
        aria-label="Search models"
      />
      <button
        type="button"
        aria-label="Close model picker"
        title="Close model picker"
        onclick={onclose}
      >
        <CioClose size={12} />
      </button>
    </div>

    <div class="model-list">
      {#if phase === 'loading'}
        <p class="cpanel-caption">Reading the models…</p>
      {:else if phase === 'error'}
        <p class="cpanel-caption">The models could not be read.</p>
        <button class="cpanel-item" type="button" onclick={onretry}> Try again </button>
      {:else if groups.length === 0}
        <p class="cpanel-caption">No model matches that search.</p>
      {:else}
        {#each groups as group (group.key)}
          <p class="model-section">
            {group.label}
            <span class="n">{group.count}</span>
          </p>
          {#each group.models as model (group.key + model.id)}
            <button
              class={['model-item', { 'is-selected': selected === model.id }]}
              type="button"
              role="menuitemradio"
              aria-checked={selected === model.id}
              title={`Run ${model.name} from ${model.providerLabel}`}
              onclick={() => onpick(model.id)}
            >
              <span class="mi-name">{model.name}</span>
              <span class="mi-mark"><VendorMark name={model.provider} size={12} /></span>
              {#if selected === model.id}
                <span class="mi-check"><CioCheck size={12} /></span>
              {/if}
            </button>
          {/each}
        {/each}
      {/if}
    </div>
  </div>
</div>
