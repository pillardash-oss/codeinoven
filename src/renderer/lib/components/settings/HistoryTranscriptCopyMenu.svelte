<script lang="ts">
  import CioCheck from '@pillardash-oss/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pillardash-oss/cio-icon/CioChevronDown.svelte'
  import CioCopy from '@pillardash-oss/cio-icon/CioCopy.svelte'
  import CioSparkles from '@pillardash-oss/cio-icon/CioSparkles.svelte'
  /**
   * Copy control for one recording-history attempt.
   *
   * A single finished transcript hides two different things a user may need:
   * what the speech model actually heard, and what cleanup turned it into. So
   * the trigger opens a menu instead of copying one of them behind their back.
   * Raw is always offered when it exists; the cleaned variant is added only
   * when cleanup actually produced different text, so the menu never shows two
   * rows that copy the same string.
   */

  import { DropdownMenu } from 'bits-ui'
  import { copyText } from '$lib/copy-text'
  import type { SpeechRecordingAttempt } from '../../../../lib/speech/types'

  interface Props {
    attempt: SpeechRecordingAttempt
    /**
     * Draw attention when a fresh transcript has just landed behind this button,
     * so a retry that changed the text does not go unnoticed.
     */
    highlighted?: boolean
  }

  let { attempt, highlighted = false }: Props = $props()

  /**
   * A failed attempt that was later retried keeps its transcripts on the retry
   * records, so read the attempt first and fall back to the newest retry that
   * has text.
   */
  function resolveRawText(attempt: SpeechRecordingAttempt): string {
    if (attempt.rawTranscript) return attempt.rawTranscript
    for (let index = attempt.retries.length - 1; index >= 0; index -= 1) {
      const retry = attempt.retries[index]
      if (retry.rawTranscript) return retry.rawTranscript
    }
    return ''
  }

  function resolveCleanedText(attempt: SpeechRecordingAttempt): string {
    if (attempt.cleanedTranscript) return attempt.cleanedTranscript
    for (let index = attempt.retries.length - 1; index >= 0; index -= 1) {
      const retry = attempt.retries[index]
      if (retry.cleanedTranscript) return retry.cleanedTranscript
    }
    return ''
  }

  const plainText = $derived(resolveRawText(attempt) || resolveCleanedText(attempt))
  const cleanedText = $derived(resolveCleanedText(attempt))
  const hasCleanedVariant = $derived(cleanedText !== '' && cleanedText !== plainText)

  let copied = $state(false)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  function flashCopied(): void {
    copied = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied = false), 1500)
  }

  async function copy(text: string): Promise<void> {
    if (!text) return
    try {
      await copyText(text, null)
      flashCopied()
    } catch {
      // Clipboard unavailable   the button simply stays idle.
    }
  }

  $effect(() => () => clearTimeout(copiedTimer))

  const itemClass =
    'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40'

  const triggerClass = $derived(
    [
      'flex h-8 shrink-0 cursor-pointer items-center justify-center gap-0.5 px-1.5 transition-colors',
      highlighted
        ? 'bg-primary/10 text-primary ring-1 ring-primary/40 hover:bg-primary/15'
        : 'text-muted hover:bg-elevated',
      'disabled:opacity-40 data-[state=open]:bg-elevated data-[state=open]:text-foreground'
    ].join(' ')
  )
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class={triggerClass}
    title="Copy transcription"
    aria-label="Copy transcription"
    disabled={!plainText && !cleanedText}
  >
    {#if copied}
      <CioCheck size={13} class="text-success" aria-hidden="true" />
    {:else}
      <CioCopy size={13} aria-hidden="true" />
    {/if}
    <CioChevronDown size={10} aria-hidden="true" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      class="z-50 min-w-52 overflow-hidden border border-border bg-surface p-1 shadow-xl"
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
    >
      {#if plainText}
        <DropdownMenu.Item class={itemClass} onSelect={() => void copy(plainText)}>
          <CioCopy size={12} class="shrink-0 text-dimmed" />
          Copy transcript
          <span class="ml-auto pl-3 text-[0.5625rem] text-dimmed tabular-nums"
            >{plainText.length} chars</span
          >
        </DropdownMenu.Item>
      {/if}
      {#if hasCleanedVariant}
        <DropdownMenu.Item class={itemClass} onSelect={() => void copy(cleanedText)}>
          <CioSparkles size={12} class="shrink-0 text-dimmed" />
          Copy with cleanup
          <span class="ml-auto pl-3 text-[0.5625rem] text-dimmed tabular-nums"
            >{cleanedText.length} chars</span
          >
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
