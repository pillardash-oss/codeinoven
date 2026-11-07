<script lang="ts">
  import { onMount, tick } from 'svelte'
  import CioArrowUp from '@pdslng/cio-icon/CioArrowUp.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioFile from '@pdslng/cio-icon/CioFile.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioMemory from '@pdslng/cio-icon/CioMemory.svelte'
  import CioMic from '@pdslng/cio-icon/CioMic.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import CioPerson from '@pdslng/cio-icon/CioPerson.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import CioShieldAlert from '@pdslng/cio-icon/CioShieldAlert.svelte'
  import CioShieldCheck from '@pdslng/cio-icon/CioShieldCheck.svelte'
  import ComposerAccountMenu from './composer/ComposerAccountMenu.svelte'
  import ComposerModelMenu from './composer/ComposerModelMenu.svelte'
  import ComposerPermissionMenu from './composer/ComposerPermissionMenu.svelte'
  import ComposerPlusMenu from './composer/ComposerPlusMenu.svelte'
  import ComposerShoe from './composer/ComposerShoe.svelte'
  import ComposerThinkingMenu from './composer/ComposerThinkingMenu.svelte'
  import VendorMark from './VendorMark.svelte'
  import { api, ApiError, type ThreadPatch } from '#lib/api/client'
  import {
    DEFAULT_PERMISSION,
    DEFAULT_THINKING,
    permissionLabel,
    permissionTone,
    thinkingLabel,
    thinkingShortLabel
  } from '#lib/composer-choice'
  import type { ComposerPanel } from './composer/panel'
  import type {
    Attachment,
    PermissionLevel,
    Prompt,
    Thread,
    ThreadUsage,
    ThinkingLevel
  } from '#lib/api/types'
  import { modelCatalog } from '#lib/stores/model-catalog.svelte'
  import { session } from '#lib/stores/session.svelte'
  import { composerHasThirdLine, composerShowsExpandControl } from '#shared/composer-expand'

  /**
   * The composer, held at phone width and drawn exactly as the desktop draws it:
   * the field with its prompt gutter, then the toolbar that owns the plus menu,
   * the permission level, the model with its thinking and account chips, the
   * microphone and the send plate. Under it sits the shoe, which states what the
   * message writes into, the Oven it runs on and what the context has left.
   *
   * Every picker writes to the thread before it closes, so the next message and
   * the next phone that opens this thread start from the same choice. The return
   * key writes a line; the plate is the only control that sends, and Cmd/Ctrl and
   * Enter together still send, as on the desktop.
   */
  interface Props {
    threadId: string
    /** The thread being written into: its model, harness and composer choices. */
    thread?: Thread | null
    /** True while a prompt is waiting to be answered, which the field states. */
    working?: boolean
    /** Called once the service has accepted the prompt, so the page can track it. */
    onqueued: (turn: { prompt: Prompt; body: string }) => void
    /** The writing itself, owned by the page: a held message that is taken back
     *  to the box arrives as a new draft. */
    draft?: string
    /** Bumped when a draft arrives from outside, so the field can take focus. */
    focusSeq?: number
    /** The thread as the service answered the last composer write. */
    onthreadchange: (thread: Thread) => void
    /** What the thread's context has used, read by the page with the transcript. */
    usage?: ThreadUsage | null
    usagePhase?: 'idle' | 'loading' | 'ready' | 'error'
    onreloadusage: () => void
    onusagechange: (usage: ThreadUsage) => void
  }

  let {
    threadId,
    thread = null,
    working = false,
    onqueued,
    draft = $bindable(''),
    focusSeq = 0,
    onthreadchange,
    usage = null,
    usagePhase = 'idle',
    onreloadusage,
    onusagechange
  }: Props = $props()

  const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
  const MAX_ATTACHMENTS = 6

  let sending = $state(false)
  let uploading = $state(false)
  let error = $state<string | null>(null)
  let panel = $state<ComposerPanel>(null)
  let showExpand = $state(false)
  let expanded = $state(false)

  let attachments = $state<Attachment[]>([])
  let fileInput: HTMLInputElement | null = null

  let resetting = $state(false)

  /** A plain node reference: the box is measured imperatively, never rendered from. */
  let box: HTMLTextAreaElement | null = null

  let canSend = $derived(draft.trim().length > 0 && !sending && !uploading)
  let hasText = $derived(draft.trim().length > 0)

  let models = $derived(modelCatalog.catalog?.items ?? [])
  let recent = $derived(modelCatalog.catalog?.recent ?? [])
  let catalogPhase = $derived(modelCatalog.phase)
  let modelsById = $derived(new Map(models.map((model) => [model.id, model])))
  let modelEntry = $derived(thread?.model ? (modelsById.get(thread.model) ?? null) : null)
  let modelLabel = $derived(modelEntry?.name ?? thread?.model ?? 'No model')
  let vendorName = $derived(modelEntry?.provider ?? thread?.model ?? null)

  let thinking = $derived(thread?.thinking ?? DEFAULT_THINKING)
  let permission = $derived(thread?.permission ?? DEFAULT_PERMISSION)
  let fileSystem = $derived(thread?.fileSystem ?? false)
  let accountLabel = $derived(session.user?.name?.trim() || session.user?.email || 'Account')
  let accountReading = $derived(thread?.account ?? accountLabel)

  function failure(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Cannot reach CodeInOven right now.'
  }

  /* ---- The thread's own choices ---- */

  async function patchThread(patch: ThreadPatch): Promise<void> {
    error = null
    try {
      const updated = await api.updateThread(threadId, patch)
      onthreadchange(updated)
    } catch (cause) {
      error = failure(cause)
    }
  }

  function pickPermission(level: PermissionLevel): void {
    panel = null
    void patchThread({ permission: level })
  }

  function pickThinking(level: ThinkingLevel): void {
    panel = null
    void patchThread({ thinking: level })
  }

  function pickModel(id: string): void {
    panel = null
    void patchThread({ model: id }).then(() => modelCatalog.load(true))
  }

  function pickAccount(label: string): void {
    panel = null
    void patchThread({ account: label })
  }

  function pickOven(ovenId: string | null): void {
    void patchThread({ ovenId })
  }

  function toggleFileSystem(): void {
    void patchThread({ fileSystem: !fileSystem })
  }

  function openPanel(next: ComposerPanel): void {
    panel = panel === next ? null : next
  }

  /* ---- The model catalog ---- */

  // The chip reads a model's name, so the catalog is read once with the screen
  // rather than when the picker first opens.
  onMount(() => {
    void modelCatalog.load()
  })

  /* ---- Context usage ---- */

  async function resetUsage(): Promise<void> {
    if (resetting) return
    resetting = true
    error = null
    try {
      onusagechange(await api.resetUsage(threadId))
    } catch (cause) {
      error = failure(cause)
    } finally {
      resetting = false
    }
  }

  /* ---- One panel at a time ---- */

  /** A press outside the composer or its shoe closes the panel that was open. */
  function onWindowPointer(event: PointerEvent): void {
    if (panel === null) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('.composer-box, .composer-shoe')) return
    panel = null
  }

  function onWindowKey(event: KeyboardEvent): void {
    if (panel !== null && event.key === 'Escape') panel = null
  }

  /** The attach item clicks the input the form owns, so the picker and the
   *  hidden field are the same file seam rather than two. */
  function attachFileInput(node: HTMLInputElement): () => void {
    fileInput = node
    return () => {
      if (fileInput === node) fileInput = null
    }
  }

  /* ---- The field's height ---- */

  function fit(): void {
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${box.scrollHeight}px`
  }

  function handleInput(): void {
    fit()
    if (!box) return
    const lineHeight = parseFloat(getComputedStyle(box).lineHeight) || 21
    const contentHeight = box.scrollHeight - 2
    showExpand = composerShowsExpandControl(
      composerHasThirdLine(contentHeight, lineHeight),
      expanded
    )
  }

  function toggleExpand(): void {
    expanded = !expanded
    if (!box) return
    box.focus()
    const end = box.value.length
    box.setSelectionRange(end, end)
    // The cap changes with the attribute, so the field is measured once the new
    // one is on it.
    void tick().then(() => {
      fit()
      handleInput()
    })
  }

  /** A draft handed in from elsewhere (an edited held message) is written and
   *  focused, because the person is expected to carry on in the field. */
  $effect(() => {
    if (focusSeq <= 0) return
    if (!box) return
    box.focus()
    const end = box.value.length
    box.setSelectionRange(end, end)
    fit()
    handleInput()
  })

  function attachBox(node: HTMLTextAreaElement): () => void {
    box = node
    fit()
    return () => {
      box = null
    }
  }

  /* ---- Files ---- */

  function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }

  /** btoa takes a binary string, and spreading a large buffer into one call would
   *  overflow the stack, so the bytes are converted in fixed chunks. */
  function encodeBase64(bytes: Uint8Array): string {
    const chunk = 0x8000
    let binary = ''
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
    }
    return btoa(binary)
  }

  async function onFiles(event: Event): Promise<void> {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const files = [...(input.files ?? [])]
    input.value = ''
    if (files.length === 0) return

    error = null
    uploading = true
    for (const file of files) {
      if (attachments.length >= MAX_ATTACHMENTS) {
        error = `A message can carry up to ${MAX_ATTACHMENTS} files.`
        break
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        error = `${file.name} is larger than 4 MB.`
        continue
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const attachment = await api.uploadAttachment(threadId, {
          name: file.name,
          mime: file.type || 'application/octet-stream',
          dataBase64: encodeBase64(bytes)
        })
        attachments = [...attachments, attachment]
      } catch (cause) {
        error = failure(cause)
        break
      }
    }
    uploading = false
  }

  async function removeAttachment(file: Attachment): Promise<void> {
    error = null
    try {
      await api.deleteAttachment(file.id)
      attachments = attachments.filter((held) => held.id !== file.id)
    } catch (cause) {
      error = failure(cause)
    }
  }

  /* ---- Sending ---- */

  async function send(): Promise<void> {
    const body = draft.trim()
    if (body.length === 0 || sending || uploading) return
    const clientId = crypto.randomUUID()
    sending = true
    error = null
    try {
      const prompt = await api.sendPrompt(threadId, {
        body,
        clientId,
        attachmentIds: attachments.map((file) => file.id)
      })
      draft = ''
      attachments = []
      expanded = false
      await tick()
      fit()
      handleInput()
      onqueued({ prompt, body })
    } catch (cause) {
      // The text stays in the box so nothing written is lost to a flaky network.
      error = failure(cause)
    } finally {
      sending = false
    }
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void send()
  }

  function onKeydown(event: KeyboardEvent): void {
    // The return key is a line break. Sending is the plate's job alone.
    if (event.key !== 'Enter' || event.shiftKey) return
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    void send()
  }

  function voice(): void {
    error = 'Voice messages are not available on this phone yet.'
  }
</script>

<svelte:window onpointerdown={onWindowPointer} onkeydown={onWindowKey} />

<form class="composer-box" data-has-text={hasText} data-expanded={expanded} onsubmit={onSubmit}>
  {#if attachments.length > 0 || uploading}
    <div class="composer-files" aria-label="Attached files">
      {#each attachments as file (file.id)}
        <span class="file-chip" title={`${file.name} · ${formatBytes(file.size)}`}>
          <CioFile size={11} />
          <span class="file-name">{file.name}</span>
          <button
            class="file-drop"
            type="button"
            aria-label={`Remove ${file.name}`}
            title={`Remove ${file.name}`}
            onclick={() => removeAttachment(file)}
          >
            <CioClose size={10} />
          </button>
        </span>
      {/each}
      {#if uploading}
        <span class="file-chip pending">Uploading…</span>
      {/if}
    </div>
  {/if}

  <div class="composer-field">
    <span class="composer-prompt" aria-hidden="true">&gt;</span>
    <textarea
      {@attach attachBox}
      bind:value={draft}
      oninput={handleInput}
      onkeydown={onKeydown}
      rows="1"
      placeholder={working ? 'Queue a message for the oven' : 'Message the oven'}
      aria-label="Message the oven"
      enterkeyhint="enter"></textarea>
  </div>

  {#if showExpand}
    <button
      class="composer-expand"
      type="button"
      aria-pressed={expanded}
      aria-label={expanded ? 'Collapse the composer' : 'Expand the composer'}
      title={expanded
        ? 'Collapse the composer to its normal size'
        : 'Expand the composer for a taller typing area'}
      onclick={toggleExpand}
    >
      <span class="expand-glyphs" aria-hidden="true">
        <span class="g-max"><CioMaximize size={13} /></span>
        <span class="g-min"><CioMinimize size={13} /></span>
      </span>
    </button>
  {/if}

  {#if error}
    <p class="composer-error" role="status">{error}</p>
  {/if}

  <div class="composer-toolbar">
    <div class="cpanel-holder">
      <button
        class="tool-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={panel === 'plus'}
        aria-controls="plus-menu"
        aria-label="Chat options"
        title="Chat options"
        onclick={() => openPanel('plus')}
      >
        <CioPlus size={15} />
      </button>
      {#if panel === 'plus'}
        <ComposerPlusMenu
          {fileSystem}
          busy={sending || uploading}
          onfilesystem={toggleFileSystem}
          onattach={() => fileInput?.click()}
        />
      {/if}
    </div>

    <div class="toolbar-group">
      <div class="cpanel-holder">
        <button
          class="perm-btn"
          type="button"
          data-level={permission}
          aria-haspopup="menu"
          aria-expanded={panel === 'permission'}
          aria-controls="perm-menu"
          aria-label={`Permission level: ${permissionLabel(permission)}`}
          title="Permission level: controls how tool-call permissions are handled"
          onclick={() => openPanel('permission')}
        >
          {#if permissionTone(permission) === 'warn'}
            <CioShieldAlert class="perm-mark" size={12} />
          {:else}
            <CioShieldCheck class="perm-mark" size={12} />
          {/if}
          <span>{permissionLabel(permission)}</span>
        </button>
        {#if panel === 'permission'}
          <ComposerPermissionMenu selected={permission} onpick={pickPermission} />
        {/if}
      </div>

      <div class="cpanel-holder">
        <button
          class="model-btn"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={panel === 'model'}
          aria-controls="model-menu"
          aria-label={`Select model, currently ${modelLabel}`}
          title={`Select model: ${modelLabel}`}
          onclick={() => openPanel('model')}
        >
          <VendorMark name={vendorName} size={12} />
          <span>{modelLabel}</span>
        </button>
        <button
          class="think-chip"
          type="button"
          aria-haspopup="menu"
          aria-expanded={panel === 'thinking'}
          aria-controls="think-menu"
          aria-label={`Thinking level: ${thinkingLabel(thinking)}`}
          title="Thinking level"
          onclick={() => openPanel('thinking')}
        >
          <CioMemory size={10} />
          <span>{thinkingShortLabel(thinking)}</span>
        </button>
        <button
          class="account-chip"
          type="button"
          aria-haspopup="menu"
          aria-expanded={panel === 'account'}
          aria-controls="account-menu"
          aria-label={`Account: ${accountReading}`}
          title="Account"
          onclick={() => openPanel('account')}
        >
          <CioPerson size={10} />
          <span>{accountReading}</span>
        </button>

        {#if panel === 'model'}
          <ComposerModelMenu
            {models}
            {recent}
            phase={catalogPhase}
            selected={thread?.model ?? null}
            onpick={pickModel}
            onretry={() => modelCatalog.load(true)}
            onclose={() => (panel = null)}
          />
        {/if}
        {#if panel === 'thinking'}
          <ComposerThinkingMenu selected={thinking} onpick={pickThinking} />
        {/if}
        {#if panel === 'account'}
          <ComposerAccountMenu selected={accountReading} own={accountLabel} onpick={pickAccount} />
        {/if}
      </div>
    </div>

    <span class="toolbar-spacer" aria-hidden="true"></span>

    <button
      class="tool-btn"
      type="button"
      aria-label="Record a message"
      title="Record a message"
      onclick={voice}
    >
      <CioMic size={15} />
    </button>
    <button
      class="send"
      type="submit"
      disabled={!canSend}
      title={working ? 'Queue this message' : 'Send this message'}
      aria-label={working ? 'Queue this message' : 'Send this message'}
    >
      <CioArrowUp size={15} />
    </button>
  </div>

  <input
    class="file-input"
    type="file"
    multiple
    hidden
    {@attach attachFileInput}
    onchange={onFiles}
  />
</form>

<ComposerShoe
  {thread}
  {usage}
  {usagePhase}
  open={panel}
  {resetting}
  ontoggle={openPanel}
  onpickoven={pickOven}
  onreset={resetUsage}
  {onreloadusage}
/>
