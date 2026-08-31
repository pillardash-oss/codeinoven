<script lang="ts">
  import type { Snippet } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { ContextMenu } from 'bits-ui'
  import {
    ChevronRight,
    Clipboard,
    Copy,
    ExternalLink,
    FileText,
    FolderOpen,
    Save
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText as copyTextToClipboard } from '$lib/copy-text'
  import { revealCitationFile } from '$lib/reveal-file'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { EditorId, EditorInfo, ProjectFileInfo } from '$shared/types'

  interface Props {
    /** Content whose file citations should open this context menu on right-click. */
    children: Snippet
    /** Fired by the "Open file" action. Defaults to opening the app file viewer. */
    onOpenFile?: (path: string, line?: number) => void
    /** Project whose root the citations resolve against. Defaults to the active project. */
    projectId?: string
    /**
     * Force the whole wrapped content to act as this citation on right-click —
     * for elements that are not citation anchors (e.g. agent file chips).
     */
    citation?: CitationTarget
  }

  let { children, onOpenFile, projectId, citation }: Props = $props()

  interface CitationTarget {
    path: string
    line?: number
  }

  interface ResolvedCitation {
    projectId: string
    relativePath: string
    absolutePath: string
    kind: ProjectFileInfo['kind']
  }

  let menuOpen = $state(false)
  let pendingTarget = $state<CitationTarget | null>(null)
  let resolved = $state<ResolvedCitation | null>(null)
  let editors = $state<EditorInfo[]>([])
  let openInEditor = $state(false)

  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'
  const dangerItemClass = `${itemClass} text-danger data-[highlighted]:bg-danger/10`

  function citationFromLink(link: HTMLAnchorElement): CitationTarget | null {
    const path = link.dataset.citationPath
    if (!path) return null
    const line = link.dataset.citationLine
    return { path, ...(line ? { line: Number(line) } : {}) }
  }

  /**
   * Gate for right-clicks. Citation links let bits-ui's trigger open the menu at
   * the pointer (this handler only records the target); everything else (plain
   * text, external links) stops the event so the native OS context menu keeps
   * working untouched.
   */
  function handleContextMenu(event: MouseEvent): void {
    if (citation) {
      pendingTarget = citation
      void resolveCitation(citation).then((value) => {
        if (pendingTarget === citation) resolved = value
      })
      return
    }
    const link = (event.target as Element | null)?.closest('a')
    const linkCitation = link instanceof HTMLAnchorElement ? citationFromLink(link) : null
    if (!linkCitation) {
      event.stopPropagation()
      return
    }
    pendingTarget = linkCitation
    void resolveCitation(linkCitation).then((value) => {
      if (pendingTarget === linkCitation) resolved = value
    })
  }

  function handleOpenChange(open: boolean): void {
    menuOpen = open
    if (!open) {
      pendingTarget = null
      resolved = null
      editors = []
    }
  }

  async function resolveCitation(target: CitationTarget): Promise<ResolvedCitation | null> {
    const safeProjectId = projectId ?? workspaceState.activeProject?.id
    if (!safeProjectId) return null
    try {
      const resolvedPaths = await invoke('projectFiles:resolveCitationPaths', safeProjectId, [
        target.path
      ])
      const relativePath = resolvedPaths[target.path]
      if (!relativePath) return null
      const info = await invoke('projectFiles:info', safeProjectId, relativePath)
      return {
        projectId: safeProjectId,
        relativePath,
        absolutePath: info.absolutePath,
        kind: info.kind
      }
    } catch {
      return null
    }
  }

  async function loadEditors(): Promise<void> {
    try {
      await editorPreference.load()
      editors = editorPreference.availableEditors
    } catch {
      editors = []
    }
  }

  async function copyText(text: string, successMessage: string): Promise<void> {
    try {
      await copyTextToClipboard(text)
      toast.success(successMessage)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Copy failed.')
    }
  }

  async function openInApp(): Promise<void> {
    if (!pendingTarget) return
    const { path, line } = pendingTarget
    if (onOpenFile) {
      onOpenFile(path, line)
      return
    }
    const safeProjectId = projectId ?? workspaceState.activeProject?.id
    if (safeProjectId) void revealCitationFile(safeProjectId, path, line)
  }

  async function openInPreferred(): Promise<void> {
    if (!resolved) return
    try {
      await invoke(
        'projectFiles:openInEditor',
        resolved.projectId,
        resolved.relativePath,
        workspaceState.activeScopeBucketIdFor(resolved.projectId)
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open the file.')
    }
  }

  async function openWithEditor(editorId: EditorId): Promise<void> {
    if (!resolved) return
    try {
      await invoke(
        'projectFiles:openInEditorWith',
        resolved.projectId,
        resolved.relativePath,
        editorId,
        workspaceState.activeScopeBucketIdFor(resolved.projectId)
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open the file.')
    }
  }

  async function saveAs(): Promise<void> {
    if (!resolved) return
    try {
      const savedPath = await invoke(
        'projectFiles:saveAs',
        resolved.projectId,
        resolved.relativePath
      )
      if (savedPath) toast.success('File saved.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the file.')
    }
  }

  async function copyPath(): Promise<void> {
    if (!resolved) return
    await copyText(resolved.absolutePath, 'Path copied to clipboard.')
  }

  async function copyContents(): Promise<void> {
    if (!resolved) return
    try {
      const textFile = await invoke('projectFiles:read', resolved.projectId, resolved.relativePath)
      await copyText(textFile.content, 'File contents copied to clipboard.')
    } catch {
      toast.error('This file cannot be copied as text.')
    }
  }

  async function revealInFileManager(): Promise<void> {
    if (!resolved) return
    await invoke('shell:revealPath', resolved.absolutePath)
  }

  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'Editor')
</script>

<ContextMenu.Root open={menuOpen} onOpenChange={handleOpenChange}>
  <ContextMenu.Trigger class="contents">
    <div oncontextmenu={handleContextMenu} class="contents" role="presentation">
      {@render children()}
    </div>
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content
      avoidCollisions
      collisionPadding={12}
      sticky="always"
      updatePositionStrategy="always"
      class="z-50 max-h-[calc(100vh-1.5rem)] min-w-44 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      {#if pendingTarget}
        <ContextMenu.Item class={itemClass} onSelect={openInApp}>
          <FileText size={13} class="text-muted" />
          Open file
        </ContextMenu.Item>
        {#if resolved}
          {#if resolved.kind === 'file'}
            <ContextMenu.Item class={itemClass} onSelect={openInPreferred}>
              <ExternalLink size={13} class="text-muted" />
              Open in {preferredName}
            </ContextMenu.Item>
          {/if}
          <ContextMenu.Sub
            open={openInEditor}
            onOpenChange={(open) => {
              openInEditor = open
              if (open) void loadEditors()
            }}
          >
            <ContextMenu.SubTrigger class={itemClass}>
              <FolderOpen size={13} class="text-muted" />
              Open with
              <ChevronRight size={13} class="ml-auto text-muted" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                avoidCollisions
                collisionPadding={12}
                class="z-50 max-h-[calc(100vh-1.5rem)] min-w-40 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
              >
                {#if editors.length === 0}
                  <ContextMenu.Item class={itemClass} disabled>No editors found</ContextMenu.Item>
                {:else}
                  {#each editors as editor (editor.id)}
                    <ContextMenu.Item
                      class={itemClass}
                      onSelect={() => void openWithEditor(editor.id)}
                    >
                      {#if editor.iconDataUrl}
                        <img
                          src={editor.iconDataUrl}
                          alt=""
                          class="h-3.5 w-3.5 shrink-0 object-contain"
                        />
                      {:else}
                        <ExternalLink size={13} class="text-muted" />
                      {/if}
                      <span class="truncate">{editor.name}</span>
                    </ContextMenu.Item>
                  {/each}
                {/if}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
        {/if}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        {#if resolved?.kind === 'file'}
          <ContextMenu.Item class={itemClass} onSelect={saveAs}>
            <Save size={13} class="text-muted" />
            Save as...
          </ContextMenu.Item>
        {/if}
        <ContextMenu.Item class={itemClass} disabled={!resolved} onSelect={copyPath}>
          <Copy size={13} class="text-muted" />
          Copy path
        </ContextMenu.Item>
        {#if resolved?.kind === 'file'}
          <ContextMenu.Item class={itemClass} onSelect={copyContents}>
            <Clipboard size={13} class="text-muted" />
            Copy file contents
          </ContextMenu.Item>
        {/if}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        <ContextMenu.Item
          class={dangerItemClass}
          disabled={!resolved}
          onSelect={revealInFileManager}
        >
          <FolderOpen size={13} />
          {navigator.platform.toUpperCase().indexOf('MAC') >= 0
            ? 'Reveal in File Manager'
            : 'Show in Explorer'}
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
