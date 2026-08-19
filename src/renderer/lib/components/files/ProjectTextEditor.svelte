<script lang="ts">
  import { onMount } from 'svelte'

  import { createFileEditor, type FileEditorController } from '$lib/editor/codemirror-file-editor'

  interface Props {
    value: string
    path: string
    readonly?: boolean
    showLineNumbers?: boolean
    wrap?: boolean
    ariaLabel: string
    spellcheck?: boolean
    findQuery?: string
    findActiveIndex?: number
    focusLine?: number | null
    focusLineRequest?: number
    onInput: (input: { currentTarget: { value: string } }) => void
    onFindMatches?: (matches: number) => void
  }

  let {
    value,
    path,
    readonly = false,
    showLineNumbers = true,
    wrap = false,
    ariaLabel,
    spellcheck = false,
    findQuery = '',
    findActiveIndex = 0,
    focusLine = null,
    focusLineRequest = 0,
    onInput,
    onFindMatches = undefined
  }: Props = $props()

  let host = $state<HTMLDivElement | null>(null)
  let controller = $state<FileEditorController | null>(null)
  let handledFocusLineRequest = 0

  onMount(() => {
    const hostElement = host
    if (!hostElement) return
    let cancelled = false
    let created: FileEditorController | null = null
    void createFileEditor({
      host: hostElement,
      value,
      path,
      readonly,
      wrap,
      showLineNumbers,
      spellcheck,
      ariaLabel,
      onDocChange: (text) => onInput({ currentTarget: { value: text } }),
      onFindMatches
    }).then((instance) => {
      if (cancelled) {
        instance.destroy()
        return
      }
      created = instance
      controller = instance
    })
    return () => {
      cancelled = true
      controller = null
      created?.destroy()
    }
  })

  $effect(() => {
    controller?.setValue(value)
  })

  $effect(() => {
    controller?.setPath(path)
  })

  $effect(() => {
    controller?.setWrap(wrap)
  })

  $effect(() => {
    controller?.setReadonly(readonly)
  })

  $effect(() => {
    controller?.setShowLineNumbers(showLineNumbers)
  })

  $effect(() => {
    controller?.setSpellcheck(spellcheck)
  })

  $effect(() => {
    controller?.setFind(findQuery, findActiveIndex)
  })

  $effect(() => {
    const requestedLine = focusLine
    const request = focusLineRequest
    if (!controller || !requestedLine || request === 0 || request === handledFocusLineRequest)
      return
    handledFocusLineRequest = request
    controller.scrollToLine(requestedLine)
  })
</script>

<div
  bind:this={host}
  class="min-h-0 min-w-0 flex-1 overflow-hidden bg-app"
  data-editor-codemirror
></div>
