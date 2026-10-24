<script lang="ts">
  import IdeEditorTools from './IdeEditorTools.svelte'
  import { onMount } from 'svelte'

  import {
    createFileEditor,
    type FileEditorController,
    type FileEditorHistoryState
  } from '$lib/editor/codemirror-file-editor'

  interface Props {
    projectId?: string
    scopeBucketId?: string
    threadId?: string
    ideEnabled?: boolean
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
    replaceRequest?: {
      nonce: number
      action: 'one' | 'all'
      query: string
      replacement: string
    } | null
    focusCharacter?: number
    focusLine?: number | null
    focusLineRequest?: number
    /** Editor command request driven by toolbar buttons (undo/redo); the
     *  nonce makes each request fire exactly once. */
    editRequest?: { nonce: number; action: 'undo' | 'redo' } | null
    onInput: (input: { currentTarget: { value: string } }) => void
    onFindMatches?: (matches: number) => void
    onReplaceDone?: (replaced: number) => void
    /** Mirror of the editor's undo/redo depth, so a toolbar can disable the
     *  actions that would do nothing. */
    onHistoryChange?: (state: FileEditorHistoryState) => void
  }

  let {
    projectId = '',
    scopeBucketId,
    threadId,
    ideEnabled = false,
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
    focusCharacter,
    focusLine = null,
    focusLineRequest = 0,
    editRequest = null,
    onInput,
    onFindMatches = undefined,
    onReplaceDone = undefined,
    onHistoryChange = undefined
  }: Props = $props()

  let ideTools = $state<IdeEditorTools>()
  let host = $state<HTMLDivElement | null>(null)
  // The controller is a class-like object with closures; deep reactivity would
  // proxy it and break identity with the instance held by the editor module.
  let controller = $state.raw<FileEditorController | null>(null)
  let handledFocusLineRequest = 0
  let handledReplaceNonce = 0
  let handledEditNonce = 0

  onMount(() => {
    const hostElement = host
    if (!hostElement) return
    let cancelled = false
    let created: FileEditorController | null = null
    const syncDocument = (): void => created?.setRoot(hostElement.ownerDocument)
    hostElement.addEventListener('native-floating-document-change', syncDocument)
    void createFileEditor({
      host: hostElement,
      value,
      path,
      readonly,
      wrap,
      showLineNumbers,
      spellcheck,
      ariaLabel,
      onIdeHoverEnd: () => ideTools?.dismissHover(),
      isIdeEnabled: () => ideEnabled && Boolean(projectId),
      onIdeAction: (action, token) => ideTools?.handle(action, token) ?? false,
      getIdeActions: (token) => ideTools?.actions(token) ?? [],
      onDocChange: (text) => onInput({ currentTarget: { value: text } }),
      onFindMatches,
      onHistoryChange: (history) => onHistoryChange?.(history)
    }).then((instance) => {
      if (cancelled) {
        instance.destroy()
        return
      }
      created = instance
      syncDocument()
      controller = instance
    })
    return () => {
      cancelled = true
      hostElement.removeEventListener('native-floating-document-change', syncDocument)
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
    const request = editRequest
    if (!controller || !request || request.nonce === handledEditNonce) return
    handledEditNonce = request.nonce
    if (request.action === 'undo') controller.undo()
    else controller.redo()
  })

  $effect(() => {
    const requestedLine = focusLine
    const request = focusLineRequest
    if (!controller || !requestedLine || request === 0 || request === handledFocusLineRequest)
      return
    handledFocusLineRequest = request
    controller.revealLine(requestedLine, focusCharacter)
  })
</script>

<div
  bind:this={host}
  class="min-h-0 min-w-0 flex-1 overflow-hidden bg-app"
  data-editor-codemirror
  data-floating-document
></div>

{#if projectId}
  <IdeEditorTools
    bind:this={ideTools}
    {projectId}
    {scopeBucketId}
    {threadId}
    {path}
    {value}
    enabled={ideEnabled}
  />
{/if}
