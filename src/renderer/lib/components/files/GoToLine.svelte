<script lang="ts">
  import { tick } from 'svelte'
  import { X } from '@lucide/svelte'

  interface Props {
    maxLine: number
    focusTrigger: number
    floating?: boolean
    onSubmit: (line: number) => void
    onClose: () => void
  }

  let { maxLine, focusTrigger, floating = false, onSubmit, onClose }: Props = $props()
  let input = $state<HTMLInputElement | null>(null)
  let value = $state('')
  let handledFocusTrigger = -1
  let previousFocus: HTMLElement | null = null

  function handleInput(event: Event & { currentTarget: HTMLInputElement }): void {
    value = event.currentTarget.value.replace(/\D/gu, '')
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Enter' || !value) return
    event.preventDefault()
    submit()
  }

  function submit(): void {
    if (!value) return
    onSubmit(Math.min(maxLine, Math.max(1, Number(value))))
  }

  function close(): void {
    onClose()
    void tick().then(() => previousFocus?.focus())
  }

  $effect(() => {
    const trigger = focusTrigger
    if (!input || handledFocusTrigger === trigger) return
    handledFocusTrigger = trigger
    value = ''
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== input) previousFocus = active
    input.focus()
  })
</script>

<div
  class={[
    'flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-surface px-2 shadow-xl',
    floating ? 'absolute right-3 top-3 z-30 w-64' : 'w-full'
  ]}
  role="dialog"
  aria-label="Go to line"
>
  <label for="project-file-go-to-line" class="shrink-0 text-[11px] font-medium text-muted">
    Line
  </label>
  <input
    id="project-file-go-to-line"
    bind:this={input}
    type="text"
    inputmode="numeric"
    pattern="[0-9]*"
    class="h-7 min-w-0 flex-1 rounded-lg border border-border bg-app px-2.5 text-xs tabular-nums text-foreground outline-none placeholder:text-dimmed focus:border-primary"
    aria-label={`Line number from 1 to ${maxLine}`}
    placeholder="1"
    {value}
    oninput={handleInput}
    onkeydown={handleKeydown}
  />
  <span class="shrink-0 text-[10px] tabular-nums text-dimmed">/ {maxLine}</span>
  <button
    type="button"
    class="flex h-7 shrink-0 items-center justify-center rounded-lg bg-primary px-2 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
    disabled={!value}
    onclick={submit}
  >
    Go
  </button>
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    aria-label="Close go to line"
    title="Close go to line (Escape)"
    onclick={close}
  >
    <X size={13} aria-hidden="true" />
  </button>
</div>
