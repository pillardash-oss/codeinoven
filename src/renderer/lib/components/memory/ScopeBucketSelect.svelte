<script lang="ts">
  import type { ScopeBucket } from '$shared/types'

  interface Props {
    /** The project's feature scopes, in board order. */
    buckets: readonly ScopeBucket[]
    value?: string | null
    onValueChange: (bucketId: string) => void
    ariaLabel: string
    title: string
    placeholder?: string
    /** Whether the project's board is still arriving. */
    loading?: boolean
    disabled?: boolean
    class?: string
  }

  let {
    buckets,
    value = null,
    onValueChange,
    ariaLabel,
    title,
    placeholder = 'Select a scope',
    loading = false,
    disabled = false,
    class: className = ''
  }: Props = $props()

  let emptyLabel = $derived(loading ? 'Loading scopes…' : 'No scopes in this project')
  let unavailable = $derived(disabled || loading || buckets.length === 0)

  /** A stored bucket the board no longer lists (archived or deleted) still names
   *  itself in the select, so an existing memory never silently points elsewhere. */
  let missingBucket = $derived(
    value && !buckets.some((bucket) => bucket.id === value) ? value : null
  )
</script>

<select
  class="w-full border bg-elevated px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary {className}"
  value={value ?? ''}
  aria-label={ariaLabel}
  {title}
  disabled={unavailable}
  onchange={(event) => {
    const next = event.currentTarget.value
    if (next) onValueChange(next)
  }}
>
  <option value="" disabled>{buckets.length === 0 ? emptyLabel : placeholder}</option>
  {#if missingBucket}
    <option value={missingBucket}>{missingBucket}</option>
  {/if}
  {#each buckets as bucket (bucket.id)}
    <option value={bucket.id}>{bucket.name}</option>
  {/each}
</select>
