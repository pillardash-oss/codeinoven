<script lang="ts">
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
  import DeferredMarkdownView from '$lib/components/markdown/DeferredMarkdownView.svelte'
  import RichMarkdownEditor from '$lib/components/shared/RichMarkdownEditor.svelte'
  import AssistantKnowledgeHistory from '../AssistantKnowledgeHistory.svelte'
  import { assistantKnowledgeSections, type KnowledgeSection } from '../assistant-view'
  import {
    assistantIsUnnamed,
    assistantKnowledgeComplete,
    type Assistant,
    type Thread
  } from '$shared/types'

  /**
   * The behaviour tab: the instructions the assistant follows on every run.
   *
   * One row per section, folding to its title alone. A fold that kept a line of
   * prose was not a fold: the reader asked for the section to get out of the way,
   * and the summary kept it on screen. The editor opens in place, and its header
   * sticks so Save and Cancel are never scrolled away.
   */
  interface Props {
    assistant: Assistant
    /** The assistant's Getting started thread, which authors this document. */
    knowledgeThread: Thread | null
    /** What that conversation has agreed so far, before the recap saves it. */
    checkpoint: string | null
    /** Opens the authoring thread, revealing it when it was hidden. */
    onOpenKnowledgeThread: () => void
    /** Writes one section back into the knowledge document. */
    onSave: (sectionId: string, body: string) => Promise<void>
  }

  let { assistant, knowledgeThread, checkpoint, onOpenKnowledgeThread, onSave }: Props = $props()

  const sections = $derived<KnowledgeSection[]>(assistantKnowledgeSections(assistant.knowledge))

  const knowledgeComplete = $derived(assistantKnowledgeComplete(assistant))
  const assistantLabel = $derived(
    assistantIsUnnamed(assistant) ? 'your new assistant' : assistant.name
  )

  const collapsed = new SvelteSet<string>()
  let editingId = $state<string | null>(null)
  let editDraft = $state('')
  let historyOpen = $state(false)

  function toggleSection(id: string): void {
    if (collapsed.has(id)) collapsed.delete(id)
    else collapsed.add(id)
  }

  function startEdit(section: KnowledgeSection): void {
    editingId = section.id
    editDraft = section.body
    collapsed.delete(section.id)
  }

  function cancelEdit(): void {
    editingId = null
    editDraft = ''
  }

  async function saveSection(sectionId: string): Promise<void> {
    const body = editDraft.trim()
    editingId = null
    await onSave(sectionId, body)
  }
</script>

<div class="flex flex-col gap-2 p-3">
  {#if !knowledgeComplete}
    <div
      class="flex flex-col items-center gap-2.5 border border-border bg-surface px-4 py-8 text-center"
    >
      <span class="flex h-10 w-10 items-center justify-center border border-border bg-elevated">
        <AssistantIcon mark="knowledge" size={24} class="text-dimmed" />
      </span>
      <p class="text-[0.8125rem] font-semibold text-foreground">Nothing yet</p>
      <p class="max-w-[17rem] text-[0.75rem] leading-relaxed text-muted">
        Tell {assistantLabel} what you want in its thread. Tell it the goal, the steps, and when it should
        run. The plan you agree on shows up here.
      </p>
      {#if knowledgeThread}
        <button
          type="button"
          class="mt-1 border border-border px-3 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Open this assistant's behavior thread"
          aria-label="Open this assistant's behavior thread"
          onclick={onOpenKnowledgeThread}
        >
          Open the task
        </button>
      {/if}
    </div>
    {#if checkpoint}
      <div class="flex flex-col gap-1.5 border border-border bg-surface p-2.5">
        <p class="text-[0.8125rem] font-semibold text-foreground">Agreed so far</p>
        <p class="text-[0.6875rem] leading-relaxed text-muted">
          What you and the agent have agreed for this assistant so far. It is not saved until you
          confirm the recap.
        </p>
        <div class="text-[0.6875rem] text-muted">
          <DeferredMarkdownView text={checkpoint} class="markdown-body-card" />
        </div>
      </div>
    {/if}
  {:else}
    <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-[0.875rem] font-semibold text-foreground">Assistant behavior</h2>
        <div class="flex items-center gap-1.5">
          <span class="text-[0.625rem] text-dimmed"
            >{sections.length} {sections.length === 1 ? 'section' : 'sections'}</span
          >
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Review earlier versions of these instructions"
            aria-label="Review earlier versions of these instructions"
            onclick={() => (historyOpen = true)}
          >
            <CioUndo size={12} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <p class="text-[0.6875rem] leading-relaxed text-muted">
        The instructions this assistant follows on every run. Personality is how it behaves and
        sounds, and the sections under it are what it does. The agent follows them literally, so
        anything not written here does not happen.
      </p>
      <ol class="flex flex-col gap-2">
        {#each sections as section (section.id)}
          {@const folded = collapsed.has(section.id) && editingId !== section.id}
          <li class="border-t border-border first:border-t-0">
            <!--
              While this section is being edited its header sticks to the top of
              the panel and carries the actions, so Save and Cancel are always
              under the pointer instead of at the end of a long document the user
              would have to scroll back down to reach.
            -->
            <div
              class="flex items-center gap-1.5 px-2.5 py-1.5 {editingId === section.id
                ? 'sticky top-0 z-10 border-b border-border bg-surface'
                : ''}"
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                aria-expanded={!folded}
                title={folded ? `Expand ${section.title}` : `Fold ${section.title}`}
                onclick={() => toggleSection(section.id)}
              >
                <CioForward
                  size={12}
                  strokeWidth={1.8}
                  class="shrink-0 text-dimmed transition-transform duration-150 {folded
                    ? ''
                    : 'rotate-90'}"
                />
                <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                  {section.title}
                </span>
              </button>
              {#if editingId === section.id}
                <div class="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    class="px-2 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                    title="Discard these changes"
                    onclick={cancelEdit}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="bg-primary px-2 py-1 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover"
                    title="Save {section.title}"
                    onclick={() => void saveSection(section.id)}
                  >
                    Save
                  </button>
                </div>
              {:else}
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  title="Edit {section.title}"
                  aria-label="Edit {section.title}"
                  onclick={() => startEdit(section)}
                >
                  <CioPencil size={12} strokeWidth={1.8} />
                </button>
              {/if}
            </div>

            {#if editingId === section.id}
              <div class="border-t border-border p-2">
                <!-- The editor grows with its content (no `max-h` cap) so a long
                     section keeps the same tall box the read view showed instead
                     of collapsing into a short scroll pane on edit. The panel's
                     content already scrolls, so an overlong body is still safe. -->
                <RichMarkdownEditor
                  id="assistant-section-{section.id}"
                  value={editDraft}
                  onValueChange={(value) => (editDraft = value)}
                  placeholder="Write this section in Markdown…"
                  ariaLabel="Edit {section.title}"
                  autofocus
                  onSubmit={() => void saveSection(section.id)}
                  containerClass="border border-border bg-surface"
                  class="min-h-10 w-full px-3.5 pt-3 pb-1 text-sm leading-5 text-foreground outline-none"
                />
              </div>
            {:else if !folded}
              <div class="border-t border-border px-2.5 py-2">
                <DeferredMarkdownView text={section.body} class="text-[0.75rem]" />
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    </div>
  {/if}
</div>

<!-- The instructions are replaced whole on every save, so the versions behind the
     current one are the only way back from a save that lost the page. This opens
     beside the panel rather than inside its sections: it is a reading surface for
     the document, not another section of it. -->
{#if historyOpen}
  <AssistantKnowledgeHistory
    assistantId={assistant.id}
    assistantName={assistantLabel}
    onClose={() => (historyOpen = false)}
  />
{/if}
