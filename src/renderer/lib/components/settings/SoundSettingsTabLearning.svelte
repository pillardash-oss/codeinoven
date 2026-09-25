<script lang="ts">
  import { Trash2 } from '@lucide/svelte'
  import { speechSettingsStore as speech } from '$lib/stores/speech.svelte'
  import Switch from '../ui/Switch.svelte'
  import type { PendingDeletion } from './sound-settings-helpers'

  interface Props {
    searchQuery: string
    onRequestDelete: (pending: PendingDeletion) => void
  }

  let { searchQuery, onRequestDelete }: Props = $props()

  const normalizedQuery = $derived(searchQuery.trim().toLowerCase())

  const filteredLessons = $derived.by(() => {
    if (!normalizedQuery) return speech.lessons
    return speech.lessons.filter((lesson) => {
      const haystack = [
        lesson.instruction,
        lesson.kind,
        ...lesson.examples.flatMap((ex) => [ex.from, ex.to])
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  })
</script>

<section id="settings-block-sound-rules" class="rounded-xl border bg-surface p-4">
  <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Learned lessons</h2>
  <p class="mb-3 text-xs text-dimmed">
    After you edit a transcript before sending, the local instruct model compares what it heard with
    what you actually wrote and distills reusable style lessons word choices, punctuation habits,
    phrasing rewrites. They are applied by the model itself during future cleanup, separately per
    project and per chat context.
  </p>
  {#if speech.lessons.length === 0}<p class="text-xs text-dimmed">
      No lessons learned yet. Edit a dictation before sending and the model will learn from the
      difference.
    </p>{/if}
  {#each filteredLessons as lesson (lesson.id)}
    <div class="flex items-center gap-3 border-t py-2 first:border-0">
      <div class="min-w-0 flex-1">
        <p class="truncate text-xs">{lesson.instruction}</p>
        <p class="text-[0.625rem] text-dimmed">
          {lesson.kind} · {lesson.scope.kind} · {Math.round(lesson.confidence * 100)}% ·
          {lesson.evidenceCount} observations
        </p>
        {#if lesson.examples.length > 0}
          <p class="truncate text-[0.625rem] text-dimmed">
            e.g. “{lesson.examples[0].from}” → “{lesson.examples[0].to}”
          </p>
        {/if}
      </div>
      <Switch
        checked={lesson.enabled}
        onchange={(checked) => void speech.setRuleEnabled(lesson.id, checked)}
        aria-label={`Toggle lesson ${lesson.instruction}`}
      /><button
        type="button"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
        title={`Delete lesson ${lesson.instruction}`}
        aria-label={`Delete lesson ${lesson.instruction}`}
        onclick={() =>
          onRequestDelete({
            action: 'lesson',
            targetId: lesson.id,
            label: lesson.instruction
          })}><Trash2 size={13} aria-hidden="true" /></button
      >
    </div>
  {/each}
  {#if normalizedQuery && filteredLessons.length === 0}
    <p class="py-6 text-center text-sm text-dimmed">
      No lessons match “{searchQuery.trim()}”.
    </p>
  {/if}
</section>
