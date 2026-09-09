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
    findNonce?: number
    replaceRequest?: { nonce: number; action: 'one' | 'all'; query: string; replacement: string } | null
    focusLine?: number | null
    focusLineRequest?: number
    onInput: (input: { currentTarget: { value: string } }) => void
    onFindMatches?: (matches: number) => void
    onReplaceDone?: (replaced: number) => void
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
    findNonce = 0,
    replaceRequest = null,
    focusLine = null,
    focusLineRequest = 0,
    onInput,
    onFindMatches = undefined,
    onReplaceDone = undefined
  }: Props = $props()

  let host = $state<HTMLDivElement | null>(null)
  // The controller is a class-like object with closures; deep reactivity would
  // proxy it and break identity with the instance held by the editor module.
  let controller = $state.raw<FileEditorController | null>(null)
  let handledFocusLineRequest = 0
  let handledReplaceNonce = 0

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
    // findNonce lets the parent force a re-scan (e.g. after a replace).
    void findNonce
  })

  $effect(() => {
    const request = replaceRequest
    if (!controller || !request || request.nonce === handledReplaceNonce) return
    handledReplaceNonce = request.nonce
    const replaced =
      request.action === 'all'
        ? controller.replaceAll(request.query, request.replacement)
        : controller.replaceOne(request.query, request.replacement, findActiveIndex)
        ? 1
        : 0
    onReplaceDone?.(replaced)
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
