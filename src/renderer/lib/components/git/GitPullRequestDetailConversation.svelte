<script lang="ts">
  import { MessagesSquare } from '@lucide/svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import PrAvatar from './PrAvatar.svelte'
  import {
    conversationAccentClass,
    conversationKindClass,
    conversationKindLabel,
    type ConversationEntry
  } from './git-pull-request-detail-format'

  interface Props {
    entries: ConversationEntry[]
  }

  let { entries }: Props = $props()
</script>

{#if entries.length === 0}
  <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <MessagesSquare size={18} class="text-dimmed" />
    <p class="text-[0.6875rem] leading-relaxed text-dimmed">Nothing has been said yet.</p>
  </div>
{:else}
  <div class="flex flex-col gap-2 p-2">
    {#each entries as entry (entry.key)}
      <article
        class="overflow-hidden rounded-lg border border-border bg-surface {conversationAccentClass(
          entry.kind,
          entry.meta
        )}"
      >
        <header
          class="flex items-center gap-1.5 border-b border-border/60 bg-elevated/50 px-2.5 py-1.5"
        >
          <PrAvatar login={entry.author} />
          <span class="truncate text-[0.6875rem] font-medium text-foreground">{entry.author}</span>
          <span
            class="shrink-0 rounded px-1.5 py-px text-[0.5625rem] font-medium {conversationKindClass(
              entry.kind,
              entry.meta
            )}"
          >
            {conversationKindLabel(entry.kind, entry.meta)}
          </span>
          <span class="flex-1"></span>
          <span class="shrink-0 text-[0.5625rem] text-dimmed">{relativeTime(entry.at)}</span>
        </header>
        {#if entry.kind === 'inline' && entry.meta}
          <p
            class="truncate border-b border-border/40 bg-elevated/20 px-2.5 py-1 font-mono text-[0.5625rem] text-dimmed"
          >
            {entry.meta}
          </p>
        {/if}
        {#if entry.body.trim()}
          <div class="px-2.5 py-2">
            <!-- GitHub's dialect includes HTML, so PR prose needs it to
                 read correctly; the sanitizer still strips anything
                 executable. Agent-authored text elsewhere keeps it off. -->
            <MarkdownView text={entry.body} class="text-[0.6875rem] leading-relaxed" allowHtml />
          </div>
        {/if}
      </article>
    {/each}
  </div>
{/if}
