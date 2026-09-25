<script lang="ts">
  import { MessageSquarePlus, Plus, X } from '@lucide/svelte'
  import type { SpecAnnotation, SpecPhase } from '$shared/types'
  import EditableMarkdown from './EditableMarkdown.svelte'
  import SpecStudioAnnotationBubbles from './SpecStudioAnnotationBubbles.svelte'
  import type { SpecDraftEdits } from './spec-studio-draft-edits'

  interface Props {
    phases: SpecPhase[]
    annotations: SpecAnnotation[]
    edits: SpecDraftEdits
    onAnnotate: (section: 'resolution', event: MouseEvent) => void
    onOpenAnnotation: (annotation: SpecAnnotation) => void
  }

  let { phases, annotations, edits, onAnnotate, onOpenAnnotation }: Props = $props()
</script>

<section id="spec-section-resolution" data-spec-section="resolution" class="scroll-mt-5">
  <div class="flex items-center justify-between gap-3">
    <button
      class="group flex items-center gap-2 text-left"
      title="Annotate the Resolution section"
      onclick={(event: MouseEvent) => onAnnotate('resolution', event)}
    >
      <span class="text-xl font-semibold tracking-tight">Resolution & phases</span>
      <MessageSquarePlus
        size={14}
        class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
      />
    </button>
    <button
      class="flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-[0.6875rem] text-muted hover:bg-overlay hover:text-foreground"
      title="Add phase"
      onclick={() => edits.addPhase()}
    >
      <Plus size={11} />
      Phase
    </button>
  </div>
  <ol class="mt-5 space-y-4">
    {#each phases as phase, phaseIndex (phase.id)}
      <li class="rounded-xl border bg-surface p-4">
        <div class="flex items-start gap-3">
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[0.6875rem] font-semibold text-on-primary"
          >
            {phaseIndex + 1}
          </span>
          <div class="min-w-0 flex-1">
            <EditableMarkdown
              class="font-semibold outline-none focus:bg-elevated"
              text={phase.title}
              fallback="Untitled phase"
              ariaLabel={`Phase ${phaseIndex + 1} title`}
              onChange={(value) => edits.setPhaseField(phase.id, 'title', value)}
            />
            <EditableMarkdown
              class="mt-1 text-muted outline-none focus:bg-elevated"
              text={phase.objective}
              fallback="No objective."
              ariaLabel={`Phase ${phaseIndex + 1} objective`}
              onChange={(value) => edits.setPhaseField(phase.id, 'objective', value)}
            />
          </div>
          <button
            class="rounded-md p-1 text-dimmed hover:bg-danger/10 hover:text-danger"
            aria-label={`Remove phase ${phaseIndex + 1}`}
            title={`Remove phase ${phaseIndex + 1}`}
            onclick={() => edits.removePhase(phase.id)}
          >
            <X size={13} />
          </button>
        </div>
        <div class="mt-3 grid gap-3 lg:grid-cols-2">
          <div>
            <div class="flex items-center justify-between">
              <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
                Checkpoints
              </p>
              <button
                class="text-[0.6875rem] text-accent hover:underline"
                title="Add checkpoint"
                onclick={() => edits.addCheckpoint(phase.id)}>Add</button
              >
            </div>
            <div class="mt-1.5 space-y-1.5">
              {#each phase.checkpoints as checkpoint, checkpointIndex (checkpoint.id)}
                <div class="rounded-lg bg-elevated p-2 text-xs">
                  <EditableMarkdown
                    class="font-medium outline-none focus:bg-surface"
                    text={checkpoint.description}
                    ariaLabel={`Checkpoint ${checkpointIndex + 1}`}
                    onChange={(value) =>
                      edits.setCheckpointField(phase.id, checkpoint.id, 'description', value)}
                  />
                  <EditableMarkdown
                    class="mt-0.5 text-muted outline-none focus:bg-surface"
                    text={checkpoint.evidence}
                    ariaLabel={`Checkpoint ${checkpointIndex + 1} evidence`}
                    onChange={(value) =>
                      edits.setCheckpointField(phase.id, checkpoint.id, 'evidence', value)}
                  />
                </div>
              {:else}
                <p class="text-[0.6875rem] text-dimmed">No checkpoints.</p>
              {/each}
            </div>
          </div>
          <div>
            <div class="flex items-center justify-between">
              <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
                File operations
              </p>
              <button
                class="text-[0.6875rem] text-accent hover:underline"
                title="Add file operation"
                onclick={() => edits.addFileOperation(phase.id)}>Add</button
              >
            </div>
            <div class="mt-1.5 space-y-1.5">
              {#each phase.fileOperations as operation, operationIndex (`${phase.id}:${operationIndex}`)}
                <div class="rounded-lg bg-elevated p-2 text-xs">
                  <div class="flex items-center gap-2">
                    <select
                      class="rounded border bg-surface px-1.5 py-1 text-[0.6875rem]"
                      value={operation.operation}
                      onchange={(event) =>
                        edits.setFileOperationField(
                          phase.id,
                          operationIndex,
                          'operation',
                          event.currentTarget.value
                        )}
                      aria-label={`File operation ${operationIndex + 1} type`}
                    >
                      <option value="create">Create</option>
                      <option value="edit">Edit</option>
                      <option value="delete">Delete</option>
                    </select>
                    <EditableMarkdown
                      class="min-w-0 flex-1 font-mono outline-none focus:bg-surface"
                      text={operation.path}
                      ariaLabel={`File operation ${operationIndex + 1} path`}
                      onChange={(value) =>
                        edits.setFileOperationField(phase.id, operationIndex, 'path', value)}
                    />
                  </div>
                  <EditableMarkdown
                    class="mt-1 text-muted outline-none focus:bg-surface"
                    text={operation.reason}
                    ariaLabel={`File operation ${operationIndex + 1} reason`}
                    onChange={(value) =>
                      edits.setFileOperationField(phase.id, operationIndex, 'reason', value)}
                  />
                </div>
              {:else}
                <p class="text-[0.6875rem] text-dimmed">No file operations.</p>
              {/each}
            </div>
          </div>
        </div>
        <EditableMarkdown
          class="mt-3 block rounded-md bg-elevated px-2 py-1 font-mono text-xs outline-none"
          text={phase.commit}
          fallback="No commit specified."
          ariaLabel={`Phase ${phaseIndex + 1} commit`}
          onChange={(value) => edits.setPhaseField(phase.id, 'commit', value)}
        />
      </li>
    {/each}
  </ol>
  <SpecStudioAnnotationBubbles {annotations} onOpen={onOpenAnnotation} />
</section>
