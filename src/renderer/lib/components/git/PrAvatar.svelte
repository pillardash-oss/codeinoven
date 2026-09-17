<script lang="ts">
  import { avatarState } from '$lib/stores/avatars.svelte'

  interface Props {
    /** GitHub login whose picture this is. */
    login: string
    /**
     * The picture URL the provider declared for this account, when a payload
     * carried one. Authoritative over the login: a bot account's login alone
     * resolves to GitHub's generated identicon rather than the app's real picture.
     */
    avatarUrl?: string | null
    /** Draw at the conversation-row size rather than the compact chip size. */
    size?: 'sm' | 'md'
  }

  let { login, avatarUrl = null, size = 'sm' }: Props = $props()

  /** GitHub's palette, so the fallback letter still tells two people apart. */
  const palette = [
    'bg-primary/20 text-primary',
    'bg-success/20 text-success',
    'bg-warning/20 text-warning',
    'bg-danger/20 text-danger',
    'bg-accent/20 text-accent'
  ]

  const url = $derived(avatarState.avatarFor(login))
  const tone = $derived(palette[Math.abs(loginHash(login)) % palette.length])
  const initial = $derived(login.trim().slice(0, 1).toUpperCase() || '?')
  const boxClass = $derived(size === 'md' ? 'size-7 text-[0.6875rem]' : 'size-5 text-[0.5625rem]')

  /** Stable per-login colour, so an account keeps its circle wherever it appears. */
  function loginHash(value: string): number {
    let hash = 0
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) | 0
    }
    return hash
  }

  // Queueing is an effect and not a `$derived`: main downloads the picture, so it
  // cannot be part of reading this component's props. The store dedupes and batches,
  // which is what allows one request per account instead of one per row.
  $effect(() => {
    avatarState.ensureResolved([{ login, avatarUrl }])
  })
</script>

<!--
  The login sits beside this in every row that uses it, and that is what a screen
  reader should read, so the circle is decoration: `aria-hidden` here and an empty
  `alt` on the image, exactly as the monogram was before it had a picture.
-->
<span
  class="relative flex {boxClass} shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold uppercase {tone}"
  aria-hidden="true"
>
  {initial}
  {#if url}
    <img src={url} alt="" class="absolute inset-0 size-full object-cover" />
  {/if}
</span>
