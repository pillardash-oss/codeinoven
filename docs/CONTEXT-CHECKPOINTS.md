# Context is a pointer, not a payload

How a CodeInOven thread survives the end of a harness session: forks, harness
switches, and app-owned checkpoints are all one mechanism. This document is the
operator-facing description of that mechanism, what is landed today, and the
shape the remaining work has to take.

Related: `docs/APP-BIBLE.md` (section 4.8), `docs/GIT-WORKTREES.md` (Git
checkpoints, a different thing that shares the word), `docs/ASSISTANT-VIEW.md`
(assistant runs, which are just threads).

---

## 1. The invariant

**A rebuilt session is handed a short recap and the ids it needs. It is never
handed the conversation.**

The mirrored conversation lives in `agent_messages` and is queryable through
read-only diagnostics. The prompt carries the map, not the territory:

- which thread this is (and, for a fork, which thread it came from),
- what was asked,
- how the last turn ended,
- what was done (files edited, commands run, what failed),
- the read-only calls that recover any of it in full.

The reasoning is measured, not aesthetic. A verbatim replay of prior turns cost
up to 8% of the checkpoint line on every rebuild (12k tokens on a large model),
and models answered the replayed request instead of the one the user had just
sent. A recap costs a few hundred tokens and makes the agent ask for detail only
when a decision needs it.

| Piece                                                                         | Status     |
| ----------------------------------------------------------------------------- | ---------- |
| `formatHistoryBrief` — the short recap                                        | **Landed** |
| Fork notice naming the parent thread id                                       | **Landed** |
| `read_messages` paging (`before_id` / `nextBeforeId`) and tool evidence       | **Landed** |
| Indexes carry the conversation's words only (no tools, reasoning, sub-agents) | **Landed** |
| App-owned context checkpoints replacing harness compaction                    | **Landed** |
| A checkpoint window readable by `checkpoint_id`                               | **Landed** |
| A page bounded as a whole (60k characters)                                    | **Landed** |
| Checkpoints named in the brief                                                | **Landed** |
| Fork records lineage and copies no rows                                       | **Landed** |
| Old rows reindexed to the narrowed corpus (schema v15)                        | **Landed** |

----------------------------------------------------------------------------- | ----------- |
| `formatHistoryBrief` — the short recap | **Landed** |
| Fork notice naming the parent thread id | **Landed** |
| `read_messages` paging (`before_id` / `nextBeforeId`) and tool evidence | **Landed** |
| Indexes carry the conversation's words only (no tools, reasoning, sub-agents) | **Landed** |
| Checkpoint-scoped reads, page-level budget, checkpoints in the brief | **Agreed** |
| App-owned context checkpoints replacing harness compaction | **Planned** |
| Fork stops copying rows, lineage row instead | **Planned** |

---

## 2. What a rebuilt session receives

`formatHistoryBrief` (`src/main/chat/chat-engine/chat-engine-message-text.ts`)
opens the turn. Its sections, all bounded:

1. **The thread.** `Resuming thread <id> ("<title>") in a fresh session…`, and
   the statement that the complete conversation is in the app database under
   that id.
2. **What was asked.** The newest 12 user requests, oldest first, each line
   `- <timestamp> <message id>: <request>`, with a count of the ones left out.
   The message id is the point: recovering that exact turn is one query away.
3. **Where the last turn left off.** The assistant's last spoken paragraph
   (800 characters), never its reasoning.
4. **What was done.** The newest 24 tool calls as one line each — action phrase,
   subject, failure marker. Tool _output_ is deliberately not replayed here; the
   brief names the work and the reader returns the evidence.
5. **How to read the rest.** The query guide (section 3).
6. **The trailer.** `End of the recap. The user's actual request follows.`

The recap section is cut to the model's input budget while the pointer, the
guide and the trailer always survive. A recap that loses the pointer is worse
than no recap, because the agent then believes the thread started here.

The brief is used by every path that rebuilds a session:

- **Fork** — the new thread's first turn (`chat-engine-fork-parent.ts` adds the
  parent thread id, because the fork owns a _copy_ of the pre-fork history while
  the parent keeps everything after it).
- **Harness switch** — the same thread, a new session on the other harness.
- **Session loss, edit, truncation** — the durable mirror is the fallback.

Two paths keep verbatim text, both on purpose:

- **Reduced native prefill.** A session seeded from the newest part of an edited
  transcript gets that tail natively (the harness's own message list), plus the
  one-time pointer. Verbatim here costs nothing in the prompt.
- **Parked-branch replay.** A session adopted from a parked branch already holds
  the conversation and missed only the delta, so the delta is replayed as it is.

---

## 3. How the agent reads the rest

Granted on every turn that carries the gateway (`cio_util_diagnose`), read-only,
redacted, and bounded per call:

| Call             | Bound                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `read_messages`  | 120 messages per page, 4,000 characters of text per message, 12 tool actions per message at 400 characters each |
| `search_threads` | 20 threads, keyword and semantic, with matching passages                                                        |
| `query_sql`      | 200 rows, 2,000 characters per value, SELECT/WITH/EXPLAIN/PRAGMA only                                           |
| `read_log`       | 200 entries, allow-listed log files only                                                                        |

`read_messages` returns a page oldest-to-newest together with `nextBeforeId`, the
message id to pass as `before_id` for the page before it. That is how a thread is
walked back to its beginning, one bounded call at a time. A `before_id` from
another thread is refused by name rather than silently restarting at the newest
page.

Each returned message also carries its `actions`: the turn's tool calls with
argument, status, and a redacted preview of the result. Without that, the reader
returned the assistant's prose and nothing else — "I fixed it" and not the edit
that fixed it — and a pointer to the history pointed at a blank spot.

**Cost model.** Every call is bounded, so its cost is O(1) in the age of the
thread. Token spend grows with the number of calls an agent chooses to make, not
with history length. Those results then stay in that session's transcript until
the next checkpoint, which is why a page-level budget is required before this is
finished: 120 messages × (4k text + 12 × 400 action characters) is ~250k tokens
in the pathological case, against a measured typical 40-message page of 9 KB
(~2.3k tokens) and a measured worst real page of 153 KB (~38k tokens).

**Storage model.** Also linear, because every write is capped:

- Tool output is capped at 64 KB per part when persisted (40 KB head, 8 KB tail,
  exact byte count, embedded images over 4 KB replaced by a marker). The 144
  outputs that hit that cap record 32.6 MB of true output, so the cap is holding
  back ~26 MB today — removing it is cheap, but it is still not free.
- `agent_messages` is 856 MB of the 1.30 GB data file, 274 MB of which is tool
  output against 107 MB of conversation text.
- The FTS index is roughly two-thirds the size of the text it covers, and that
  text is the conversation's words only (see below), so the index stays small.
- The only super-linear term in this system is **copying history into forks**
  (section 6), and the fix is to stop copying.

### What the indexes cover, and what they must never cover

The corpus is the words the conversation actually showed: the **user's request**
and the **agent's own reply**. Both indexes — the FTS table
(`agent_messages_fts`) and the embedding index (`thread-embedding-index.ts`) —
are built from that one text (`partsToSearchText`), and human search and the
agent's `search_threads` read the same index. One corpus, one set of rules:

- **Excluded permanently:** tool calls, tool results, reasoning, sub-agent
  transcripts and their output. A person searches for what was said, never for
  the command that ran, and indexing working noise made searches match text the
  user was never shown. An agent that needs tool evidence reads it from the
  mirror with `read_messages`, which returns it with the turn that produced it —
  that is what the pointer in the brief is for, and it is why the indexes do not
  have to carry the evidence.
- Included: message text, the answer recorded on a question card, and the body
  of an app presentation (an answered question, an applied specification), because
  those are the user's words and the agent's words as the thread shows them.

`partsToSearchText` used to index reasoning and sub-agent cards as well. Those
rows keep their older text until a rebuild pass regenerates `search_text`; that
pass is a follow-up, and it can only remove matches that should never have been
there.

---

## 4. Checkpoints replace compaction

Harness compaction rewrites the conversation in place: the model summarizes the
old turns, they are dropped, and the session continues with a summary the app
cannot read, cannot audit, and cannot hand to another harness. It also throws
away exactly what this app keeps — the durable mirror — in exchange for a
document the next harness cannot use.

So compaction becomes a **checkpoint**, and on Pi compaction is disabled in
favour of it.

### What happens at a checkpoint

1. The app sees the session cross the checkpoint line
   (`COMPACT_LINE_SHARE` of usable input, `src/lib/prompt-budget.ts`). The line is
   the same number the harness triggers on today, so nothing about _when_
   changes.
2. The UI reports **Checkpointing**, where it reports Compacting today.
3. A **marker** is written into the thread anyway: the boundary message id and
   timestamp recorded on the checkpoint row, so a reader can tell exactly where
   one session ended and the next began.
4. The current harness session is **closed** and a **new session is started** on
   the same app thread. On Pi that is a new Pi session (a new underlying
   transcript, new session id) — the app thread is unchanged, because a thread
   is the unit the user sees.
5. The new session's first turn carries `formatHistoryBrief` plus the ids of the
   previous checkpoints (section 5). The agent continues the work with a map of
   where it has been.
6. The checkpoint row is finalized with the tokens the closed session consumed,
   the context window, and the session id.

Nothing is summarized away. The old session's messages are still in
`agent_messages`; the session id says which window each row belonged to.

### Pi specifics

Pi is the one harness where the app already owns compaction end to end, so most
of the switch is already thrown:

- Pi's **own** auto-compaction is already off. Every session start sends
  `set_auto_compaction(false)` (`pi-driver-rpc.ts`), because Pi's threshold is
  `contextWindow - 16k`, far above what a provider that bills completion against
  the same window accepts; leaving it on would race the app and could rewrite a
  transcript the app keeps.
- What the app's `codeinoven-compaction` extension does today is a **checkpoint in
  place**: it summarizes, drops the covered entries and keeps one session. The
  change is that step 4 above replaces the summary with a **new session**, so the
  transcript is never rewritten and the old window stays readable.
- The extension keeps its **emergency** path either way: a request that would
  otherwise exceed the window still rebuilds a checkpoint rather than failing,
  because a session with no way out is worse than a lossy summary.
- `publishCompactionContext` keeps publishing the plan and progress snapshot, so
  a checkpoint built after a crash has the same material a normal one does.

### Every harness

Checkpointing is an app-owned mechanism, so it does not depend on a harness
having one: the brief, the read tools, the marker and the checkpoint rows are all
the app's, and every driver already implements the two primitives it needs —
`createSession` and a rebindable `threads.session_id`. The engine takes the
checkpoint in `ensureSession`, before the turn is dispatched, so **every harness
in the table below checkpoints on the same line**. What differs per harness is
only whether the app can also switch off the harness's own compaction, which
decides what that compaction is for.

| Harness              | Its own compaction                                                                                                                                                       | What the app can do                                                                                                                                                 | Tier                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Pi**               | The app's `codeinoven-compaction` extension; `set_auto_compaction(false)` is already sent on every session start so Pi's own threshold never races the app's checkpoints | Owns the trigger outright, and the emergency rebuild is the only Pi-side compaction left                                                                            | **1 — full replacement**       |
| **Codex**            | `model_auto_compact_token_limit`, passed by the app                                                                                                                      | Owns the trigger by config: move it to the checkpoint line, or past the window, and checkpoint instead                                                              | **1 — config**                 |
| **Muse**             | Hard threshold, value passed by the app (`COMPACT_LINE_SHARE`)                                                                                                           | Same: the number is the app's                                                                                                                                       | **1 — config**                 |
| **Cline**            | None declared (`compaction: false`), `nativeResume: false`                                                                                                               | The app already owns context entirely; checkpointing is the only mechanism                                                                                          | **1 — by construction**        |
| **ACP**              | None declared (`compaction: false`)                                                                                                                                      | Same, though the agent may still compact on its own                                                                                                                 | **1 — by construction**        |
| **Claude Code**      | `/compact` plus its own auto-compaction                                                                                                                                  | Cannot be switched off; the app checkpoints at its own line, which is below Claude's, so the checkpoint lands first. Claude's compaction remains the emergency path | **2 — checkpoint ahead of it** |
| **OpenCode v1 / v2** | Harness-owned, surfaced as `session.compaction.*` and mirrored as a checkpoint part                                                                                      | Same as Claude Code                                                                                                                                                 | **2 — checkpoint ahead of it** |
| **Antigravity**      | `/compact` slash command, harness-owned                                                                                                                                  | Same as Claude Code                                                                                                                                                 | **2 — checkpoint ahead of it** |

Rules that hold for every row:

- A checkpoint is recorded whichever path produced it, including a harness
  compaction the app did not ask for. The marker and the session id are facts
  about what happened, not a promise about who caused it.
- The app checkpoints at the start of a turn, so a session it just checkpointed
  begins the next turn well below the line. A harness trigger that shares the
  line therefore only fires when a single turn is large enough to reach it on
  its own, which is what makes it the emergency net rather than the primary path.
- The line comes from the model's usable input budget (`COMPACT_LINE_SHARE` of
  it), the same number a harness that accepts a trigger is given. A harness that
  sees a smaller window than the catalog knows compacts earlier; its boundary is
  recorded as a checkpoint like any other, so nothing is lost.
- A harness that compacts on its own does not corrupt anything: its boundary
  becomes a checkpoint row, the mirror keeps every row, and the brief still points
  at the same thread ids.
- The emergency rebuild path stays in every row. A session that cannot checkpoint
  in time must still be able to continue.

---

## 5. The checkpoint table

One row per closed session. A dedicated table, tied to the thread, because a
checkpoint is a first-class thing the agent queries and the UI reports — not a
column on `threads` and not a part buried in a message.

```sql
CREATE TABLE IF NOT EXISTS thread_checkpoints (
  id                    TEXT PRIMARY KEY NOT NULL,
  thread_id             TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  -- 1, 2, 3 … per thread, so "the checkpoint before this one" is a read.
  sequence              INTEGER NOT NULL,
  kind                  TEXT NOT NULL CHECK(kind IN (
                          'auto',           -- crossed the checkpoint line
                          'manual',         -- the user asked for one
                          'harness-switch', -- the same thread moved harness
                          'fork',           -- a fork's inherited boundary
                          'recovery'        -- emergency rebuild after a failure
                        )),
  harness_id            TEXT NOT NULL,
  provider_id           TEXT,
  model_id              TEXT,
  account_id            TEXT,
  -- The session that ENDED here. The running session stays on threads.session_id.
  session_id            TEXT NOT NULL,
  session_file          TEXT,            -- harness transcript path, when the harness has one
  project_path          TEXT NOT NULL DEFAULT '',
  -- The boundary marker: the last mirrored message the closed session saw.
  boundary_message_id   TEXT,
  boundary_created_at   INTEGER,
  -- What the closed session had consumed, so the next line decision is real.
  tokens_before         INTEGER,
  context_window        INTEGER,
  -- Human-facing one-liner for the UI and the next brief, never a summary the
  -- agent has to trust: the rows behind it are readable.
  label                 TEXT,
  created_at            INTEGER NOT NULL,
  UNIQUE (thread_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_thread_checkpoints_thread
  ON thread_checkpoints(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_thread_checkpoints_session
  ON thread_checkpoints(session_id);
```

Rules:

- `threads.session_id` keeps pointing at the **running** session. A checkpoint
  row always describes a session that has ended, so the two never disagree.
- `agent_messages.session_id` already records which window each row was written
  in. Nothing needs backfilling for existing threads: a thread with no checkpoint
  rows is one session that has not been checkpointed yet.
- This is **not** `turn_checkpoints`, which stores Git change tracking for a
  turn. Different table, different lifetime, different reader. Both names stay.
- A fork writes its inherited boundary as a checkpoint row of kind `fork` and
  **does not copy the parent's messages** (section 6), so the table is also the
  fork's lineage.

The brief lists the previous checkpoints compactly — `sequence`, `kind`, when it
closed, and the session id — so an agent that needs what happened before the
current window knows which ids to search.

---

## 6. Forks are lineage, not copies

A fork today duplicates every mirrored row up to the fork point into the new
thread (`thread-manager-fork.ts`), which means a fork of a fork re-stores the
same history again. That is the only place in this design where storage grows
faster than the data written, and it buys nothing: the fork already names the
parent thread id in its first turn.

So:

- A fork records **lineage** (`thread_lineage` or a `kind = 'fork'` checkpoint
  row naming the parent thread and the message it cut at) and copies **no
  messages**.
- Its first turn is the brief with the parent id, which is what it already
  carries.
- The reader takes a thread id, so reading the parent's history is the same call
  as reading its own — including the pages from before the fork.
- Subagent traces stay with the session that produced them. They are not copied,
  and they are reachable through the same thread id.

This also settles what a fork _is_: a new thread sharing a history, not a new
copy of one.

---

## 7. Harness switch is a checkpoint too

Switching harness is the same event as a checkpoint with a different `kind`. The
session that ran on the old harness closes (a `harness-switch` row), the new
harness starts a session on the same thread, and the first turn carries the same
brief with the same ids. Nothing about the conversation needs to travel between
harnesses, because it never lived in the harness.

What must keep working, and does:

- the parked branch (`parkedSessionReplay`) for a harness the user comes back to,
- native binding restore (`restoreNativeBinding`) so the returning harness
  resumes its own transcript rather than cold-starting,
- the reduced prefill and the one-time pointer (`prefilledHistoryBoundaries`).

---

## 8. What the reader does

Every piece below is in the build; this section is the contract the next change
has to keep.

- **Read a window.** `read_messages` takes `checkpoint_id` and returns the
  messages the session behind that checkpoint covered. The mirror rows carry no
  session tag (the thread is the conversation), so a window is the time range
  between the previous checkpoint and that one's boundary.
- **Read a page.** One page is bounded per message _and_ as a whole
  (`MAX_PAGE_CHARACTERS`, 60k): it keeps the newest messages that fit, says it
  was trimmed, and still hands back the cursor that walks further back.
- **Read the evidence.** Each message carries its tool calls with a redacted
  result preview, which is what a resumed agent needs to know what was run and
  changed. The indexes never carry it; the read path does.
- **Name the windows.** A rebuilt session's brief lists the thread's checkpoints
  — id, sequence, kind, harness, consumed tokens — because an agent that is not
  told older windows exist has no reason to ask for one.
- **Repair the index once.** Schema v15 rewrites `search_text` for rows written
  before the corpus was narrowed, and bumps `updated_at` on the affected threads
  so the embedding index re-embeds them (the thread's recency is `last_activity`
  and does not move).

Two things stay out on purpose: tool evidence never enters the FTS or embedding
indexes (search stays the thing a person would recognise), and a checkpoint never
summarizes the conversation it closes — the rows stay in the mirror.
