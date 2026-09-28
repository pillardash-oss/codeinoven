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
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { revealCitationFile } from '$lib/reveal-file'
  import { osFileManagerLabel, revealInOsFileManager } from '$lib/os-file-manager'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { isAbsoluteCitationPath } from '$lib/agent-source-citations'
  import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
  import type { EditorId, EditorInfo, ProjectFileInfo } from '$shared/types'

  interface Props {
    /** Content whose file citations should open this context menu on right-click. */
    children: Snippet
    /** Fired by the "Open file" action. Defaults to opening the app file viewer. */
    onOpenFile?: (path: string, line?: number) => void
    /** Project whose root the citations resolve against. Defaults to the active project. */
    projectId?: string
    /**
     * Force the whole wrapped content to act as this citation on right-click  
     * for elements that are not citation anchors (e.g. agent file chips).
     */
    citation?: CitationTarget
  }

  let { children, onOpenFile, projectId, citation }: Props = $props()

  interface CitationTarget {
    path: string
    line?: number
  }

  /**
   * One project mount a citation resolved inside, and the scope bucket it
   * resolved against (a managed worktree checkout, or the project-rooted
   * Default scope). Every project-relative action reuses these instead of
   * re-deriving them, so a menu opened in a worktree never falls back to the
   * main project directory.
   */
  interface CitationMount {
    projectId: string
    scopeBucketId: string
    relativePath: string
    kind: ProjectFileInfo['kind']
  }

  interface ResolvedCitation {
    /** The file's real location on disk. Copy path and reveal use this and
     *  nothing else, so the result is the file's actual path whether it lives
     *  in a managed worktree, the project directory, or app scratch space. */
    absolutePath: string
    /**
     * Absent when the file exists outside every project root (chat artifacts,
     * attachment scratch): then only the absolute-path actions apply, because
     * the project-relative ones have no root to resolve against.
     */
    mount?: CitationMount
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

  /**
   * Resolve a candidate inside one project mount. An entry resolves only when
   * it exists on disk inside that mount's root, so the returned relative path
   * and metadata always describe the file the citation actually names.
   *
   * A root that cannot be resolved (a managed scope whose checkout is gone) or
   * an entry that does not exist below it both resolve to `null`: this is the
   * same fail-closed answer main gives, and the caller decides whether another
   * mount can own the candidate.
   */
  async function resolveInMount(
    mountProjectId: string,
    candidate: string,
    scopeBucketId: string
  ): Promise<ResolvedCitation | null> {
    try {
      const resolvedPaths = await invoke(
        'projectFiles:resolveCitationPaths',
        mountProjectId,
        [candidate],
        scopeBucketId
      )
      const relativePath = resolvedPaths[candidate]
      if (!relativePath) return null
      const info = await invoke('projectFiles:info', mountProjectId, relativePath, scopeBucketId)
      return {
        absolutePath: info.absolutePath,
        mount: { projectId: mountProjectId, scopeBucketId, relativePath, kind: info.kind }
      }
    } catch {
      return null
    }
  }

  /**
   * Locate the file a citation names, layering the mounts that can own it:
   *
   * 1. the active scope mount, so a conversation in a managed worktree resolves
   *    its own checkout instead of the main project directory;
   * 2. the project root that contains an absolute candidate;
   * 3. the active project's own root, which is the last mount that can hold a
   *    path whose scope cannot be resolved any more (a merged and deleted
   *    worktree) or that no scope contains at all;
   * 4. for an absolute candidate outside every project root (app scratch space,
   *    chat artifacts), the file itself, so path-level actions still work.
   */
  async function resolveCitation(target: CitationTarget): Promise<ResolvedCitation | null> {
    const safeProjectId = projectId ?? workspaceState.activeProject?.id
    if (!safeProjectId) return null
    const projectRootMount = { projectId: safeProjectId, scopeBucketId: DEFAULT_SCOPE_BUCKET_ID }
    const activeMount = {
      projectId: safeProjectId,
      scopeBucketId: workspaceState.activeScopeBucketIdFor(safeProjectId)
    }
    const absolute = isAbsoluteCitationPath(target.path)
    const mounts: Array<{ projectId: string; scopeBucketId: string }> = []
    if (activeMount.scopeBucketId !== DEFAULT_SCOPE_BUCKET_ID) mounts.push(activeMount)
    if (absolute) {
      const owner = await invoke('project:findFileOwner', target.path).catch(() => null)
      if (owner && owner.projectId !== safeProjectId) {
        mounts.push({ projectId: owner.projectId, scopeBucketId: DEFAULT_SCOPE_BUCKET_ID })
      }
    }
    mounts.push(projectRootMount)

    for (const mount of mounts) {
      const resolvedInMount = await resolveInMount(
        mount.projectId,
        target.path,
        mount.scopeBucketId
      )
      if (resolvedInMount) return resolvedInMount
    }
    if (!absolute) return null
    const external = await invoke('projectFiles:resolveExternalCitationPaths', [target.path]).catch(
      () => null
    )
    return external?.[target.path] ? { absolutePath: target.path } : null
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
      reportError(error, 'Copy failed.')
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
    const mount = resolved?.mount
    if (!mount) return
    try {
      await invoke(
        'projectFiles:openInEditor',
        mount.projectId,
        mount.relativePath,
        mount.scopeBucketId
      )
    } catch (error) {
      reportError(error, 'Could not open the file.')
    }
  }

  async function openWithEditor(editorId: EditorId): Promise<void> {
    const mount = resolved?.mount
    if (!mount) return
    try {
      await invoke(
        'projectFiles:openInEditorWith',
        mount.projectId,
        mount.relativePath,
        editorId,
        mount.scopeBucketId
      )
    } catch (error) {
      reportError(error, 'Could not open the file.')
    }
  }

  async function saveAs(): Promise<void> {
    const mount = resolved?.mount
    if (!mount) return
    try {
      const savedPath = await invoke(
        'projectFiles:saveAs',
        mount.projectId,
        mount.relativePath,
        mount.scopeBucketId
      )
      if (savedPath) toast.success('File saved.')
    } catch (error) {
      reportError(error, 'Could not save the file.')
    }
  }

  async function copyPath(): Promise<void> {
    if (!resolved) return
    await copyText(resolved.absolutePath, 'Path copied to clipboard.')
  }

  async function copyContents(): Promise<void> {
    const mount = resolved?.mount
    if (!mount) return
    try {
      const textFile = await invoke(
        'projectFiles:read',
        mount.projectId,
        mount.relativePath,
        mount.scopeBucketId
      )
      if (!textFile) {
        toast.error('This file cannot be copied as text.')
        return
      }
      await copyText(textFile.content, 'File contents copied to clipboard.')
    } catch {
      toast.error('This file cannot be copied as text.')
    }
  }

  /**
   * Reveal the resolved file in the OS file manager. Main re-validates the path
   * against the roots it hands over (project directories, healthy worktree
   * checkouts, app artifact roots), and a file that lives outside all of them is
   * revealed through the reveal-only external surface instead, so a citation in
   * app scratch space is never reported as unrevealable.
   */
  async function revealInFileManager(): Promise<void> {
    if (!resolved) return
    if (await revealInOsFileManager(resolved.absolutePath)) return
    const revealed = await invoke('shell:revealExternalPath', resolved.absolutePath).catch(
      () => false
    )
    if (!revealed) toast.error('This file no longer exists on disk.')
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
          {#if resolved.mount?.kind === 'file'}
            <ContextMenu.Item class={itemClass} onSelect={openInPreferred}>
              <ExternalLink size={13} class="text-muted" />
              Open in {preferredName}
            </ContextMenu.Item>
          {/if}
          {#if resolved.mount}
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
        {/if}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        {#if resolved?.mount?.kind === 'file'}
          <ContextMenu.Item class={itemClass} onSelect={saveAs}>
            <Save size={13} class="text-muted" />
            Save as...
          </ContextMenu.Item>
        {/if}
        <ContextMenu.Item
          class={itemClass}
          disabled={!resolved}
          title={resolved ? undefined : 'This file could not be located on disk'}
          onSelect={copyPath}
        >
          <Copy size={13} class="text-muted" />
          Copy path
        </ContextMenu.Item>
        {#if resolved?.mount?.kind === 'file'}
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
          {osFileManagerLabel()}
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
