# Session protocol: a session that lives on the Oven

Status: plan. No code has been written for it yet.

Provenance of every "today" claim: read at `HEAD = 7e92cbdf7`. The working tree also holds an
uncommitted change by a parallel worker that adds `oven_mode` and a permission-card deadline
(`src/lib/permission-level.ts` is new/untracked; `src/lib/types/common.ts`,
`src/renderer/lib/actions/permission-actions.ts`, `src/main/permissions/permission-policy.ts`,
`src/main/chat/chat-engine/chat-engine-permissions.ts`, `src/main/chat/chat-engine/chat-engine-types.ts`,
`src/main/ipc/validation/threads.ts`, `src/renderer/lib/components/chats/ChatComposerPermissionPicker.svelte`
are modified). Section E depends on that work; items already done there are marked `in flight`, and
every HEAD-based claim about tokens/timers is cited at HEAD on purpose.

## 0. Fixed decisions (not re-litigated here)

| # | Decision |
| --- | --- |
| 1 | The session (identity, record, RPC, event mapping, turn lifecycle, arbitration, transcript) moves onto the Oven. The desktop becomes a viewer. |
| 2 | The Oven assigns `seq` and persists the log in its own sqlite; clients read from there. The account DB is a mirror, never the arbiter. |
| 3 | Offline commits are required: an Oven without backend reach queues and flushes later. Session state (`live` / `behind` / `offline`) is a stored field, never inferred by a reader. |
| 4 | Every waiting card times out on one value (`questionTimeoutMs`). A permission card that times out auto-rejects so the agent takes another path. |
| 5 | `oven_mode` is a new permission level above `full_access`, offered only when the composer targets an external Oven before send, rendered in the destructive colour, and inside it the protective guards (sensitive-file guard, bundled-pi file policy, destructive-command guard) do not apply. |

## 1. What exists today, and where the session actually lives

| Concern | Owner today | Evidence |
| --- | --- | --- |
| Session id | desktop, in memory + thread row (`oven-<uuid>`) | `src/main/ovens/oven-chat.ts:314` |
| Session record (messages, nativeSessionId, checkout hash) | desktop JSON file `ovens/threads/<projectId>/<threadId>.json` | `src/main/ovens/oven-chat.ts:251`, written `:420`, read `:913-916` |
| Event → message mapping | desktop, per harness | `src/main/ovens/oven-chat.ts:1097-1160` (`record`) |
| Turn lifecycle (status, publish, finish) | desktop | `src/main/ovens/oven-chat.ts:292-470` (`send`), `:971-1036` (`consume`), `:1037-1090` (`finish`) |
| Permission/question arbitration | desktop process memory | `src/main/ovens/oven-chat.ts:1295`, `:1343-1345`, `:1348` |
| Transcript persistence | desktop sqlite + per-thread `stream.jsonl` | `src/main/chat/turn-stream.ts:1-5`, `chat-engine/chat-engine-messages-write.ts` |
| Command execution + raw stdio journal | Oven | `src/main/ovens/remote/oven-service-entry.ts:773-795`, `:900-935` |
| Run records | Oven, `~/.config/pillardash/codeinoven/.../runs/<runId>.{json,jsonl}` | `oven-service-entry.ts:322`, `:785`, `:1193` |
| RPC to the Oven | one line-JSON request per call, `{ok,value}` / `{ok,error}` | `src/main/ovens/oven-service.ts:220-230`, `:395-400`, `oven-service-entry.ts:1242-1252` |
| Cursor paging | byte offsets cached in the daemon's memory | `oven-service-entry.ts:301`, `:900-935` |

Consequences that this plan exists to remove: a second client has no session at all (the read path
returns early when the local binding is missing, `oven-chat.ts:913-916`); a desktop restart loses
every open card (`oven-chat.ts:1425` leaves the run alive with nobody able to answer it); and the
Oven's journal is raw harness stdout, so no reader can reconstruct events without running the
desktop's mapping code.

## A. Session owned on the Oven

### A.1 What moves

| Moves to the Oven | Stays on the client |
| --- | --- |
| Session id minting, session record, native session binding | Nothing that decides truth |
| `seq` assignment and the event log | The read cursor (one per client, per session) |
| Event → message folding for the harness (same folds, moved) | Rendering, folding of *parts* for display only |
| Turn lifecycle: start, prompt, steer, abort, end status | Draft composer state, attachments staging |
| Waiting cards: ask, deadline, settle | The card UI and the decision the user makes |
| Transcript persistence (message rows + turn stream) | An offline read cache, dirty-but-replaceable |
| Session state (`live`/`behind`/`offline`) | A reachability hint, kept separate (see C.4) |

The desktop keeps a local cache only to render while disconnected. Rule: any local row is
replaceable by a page of the log; if a local row and a log event disagree, the log wins and the
local row is dropped.

### A.2 Why the folds must move with the session

The event→message mapping is per harness and lives in the desktop
(`src/main/ovens/oven-chat.ts:1097-1160` dispatching to `parseCodexJsonLine`, `mapClaudeCodeRecord`,
`mapPiRecord`, `mapMuseRecord`, `mapClineRecord`, `mapOpenCodeEvent`). Those modules are plain
TypeScript with no Electron or `app` dependency, so they can be bundled into the Oven service
(`out/main/oven-service.mjs`, built by the same `electron.vite.config.ts` entry that already ships
`oven-service-entry.ts`). The Oven therefore stores *mapped* events, and a late joiner never needs
the folding code at all.

### A.3 v2 protocol surface

Envelope is unchanged (`{method, protocolVersion, input}` in, one line `{ok,value}` out;
`src/main/ovens/oven-service.ts:395-400`, `oven-service-entry.ts:1242-1252`). `PROTOCOL` becomes 2
(`oven-service-entry.ts:71`, `src/lib/ovens.ts:5`). The daemon keeps answering every v1 method, so
an old desktop and a new Oven coexist; a new desktop already replaces a stale Oven service
(`oven-service.ts:436-460` + `oven-request-channel.ts:45`).

| Method | Input | Value | Notes |
| --- | --- | --- | --- |
| `session.create` | `{projectId, threadId, harnessId, providerId?, accountId?, modelId, thinkingLevel, permissionLevel, cwd, environment?, clientId, clientKey}` | `{session, headSeq}` | `clientKey` makes a retried create idempotent: same key returns the same session. One live session per `threadId` unless `allowMultiple`. |
| `session.resume` | `{sessionId, clientId}` | `{session, headSeq, state, behindBy, openCards}` | The attach primitive. Refuses with `session.lost` when the Oven has no such session. |
| `session.list` | `{projectId?, threadId?, state?, limit?, after?}` | `{sessions[], nextCursor}` | Browse without attaching. |
| `session.prompt` | `{sessionId, clientId, turn:{permissionLevel, harnessId, providerId?, accountId?, modelId, thinkingLevel}, body, attachments[], clientKey}` | `{turnId, seq}` | `clientKey` = the prompt idempotency key. The turn block is stored with the turn, not read from a thread default. |
| `session.steer` | `{sessionId, clientId, turnId, body, clientKey}` | `{seq}` | Queued until the in-flight tool call ends, logged as `steer.held` then `steer.delivered`. |
| `session.abort` | `{sessionId, clientId, turnId?}` | `{seq}` | Ends the harness run (`SIGTERM`, then `SIGKILL` after 5 s as today, `oven-service-entry.ts:960-971`). |
| `session.permission.reply` | `{sessionId, requestId, clientId, reply, message?}` | `{seq, settledBy}` | `reply` is `once \| always \| reject` (`src/lib/types/common.ts:63`). A settled card answers `card.alreadySettled` with the winner, never a second write to stdin. |
| `session.question.reply` | `{sessionId, requestId, clientId, answers \| null}` | `{seq}` | `null` = dismissed. |
| `session.events` | `{sessionId, after, limit}` | `{events[], headSeq, state, behindBy, hasMore}` | The read path. `limit` default 200, max 500. |
| `session.state` | `{sessionId}` | `{state, headSeq, committedSeq, behindBy, openCards}` | Cheap poll for a phone that only needs "is it working". |
| `HTTP POST /v1/threads/{id}/attach-ticket` | `{clientId, kind}` (not an Oven method) | `{ticket, expiresAt}` | Minted by the backend, verified by the Oven; see D.4. |

Request/response shapes, concretely:

```
->  {"method":"session.prompt","protocolVersion":2,"input":{
      "sessionId":"ovs_7f3a...","clientId":"cli_9b1c","clientKey":"prm_01H...",
      "turn":{"permissionLevel":"oven_mode","harnessId":"pi","modelId":"...","thinkingLevel":"high"},
      "body":"fix the flaky test","attachments":[]}}
<- {"ok":true,"value":{"turnId":"trn_...","seq":41}}
```

```
->  {"method":"session.events","protocolVersion":2,"input":{"sessionId":"ovs_7f3a...","after":41,"limit":200}}
<- {"ok":true,"value":{"events":[{"seq":42,"kind":"part.delta", ...}],"headSeq":57,
      "state":"behind","behindBy":16,"hasMore":false}}
```

Constraints that carry over from v1 and must stay true:

- Inputs are validated the way `start` validates today (`oven-service-entry.ts:799-860`): absolute
  `cwd`, bounded strings, no `\0`, an environment allow-list that refuses `PATH`/`HOME`/`LD_PRELOAD`/
  `NODE_OPTIONS`/`ELECTRON_RUN_AS_NODE`.
- One request per line, 1 MiB in / 2 MiB out (`oven-service-entry.ts:280`, `:1282`).
- `session.events` must NOT be serialized behind the daemon's single request chain
  (`oven-service-entry.ts:279`, `:1246`). Reading the log is a read-only path and is served
  concurrently; only writers (append, card settle, spawn) take the chain.

## B. The event log on the Oven

### B.1 Storage engine

`better-sqlite3` is a native module and cannot travel inside the single-file bundle the Oven runs
(`out/main/oven-service.mjs`, embedded as one string by `oven-agent-script.ts:113-146` and read at
`oven-service.ts:501`), so the store uses `node:sqlite` (`DatabaseSync`), which the app's own
engine floor already satisfies (`package.json:7-10` requires node >= 22.13.0). The daemon probes
`import('node:sqlite')` once at start and reports `sessionStore: 'sqlite' | 'jsonl'` on every
`probe` answer, so a client always knows which store is answering. Fallback (older runtimes): the
same schema as newline records in `sessions/<sessionId>/events.jsonl` with `seq` = a persisted
counter — same read API, same guarantees except transactional multi-row append.

Database file: `<dataRoot>/sessions.sqlite`, `journal_mode=WAL`, `synchronous=FULL`, mode `0600`,
sibling of the existing `runs/` directory (`oven-service-entry.ts:1193`).

### B.2 DDL (the Oven's own store)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,                  -- 'ovs_' + 26 chars
  project_id       TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  harness_id       TEXT NOT NULL,
  provider_id      TEXT,
  account_id       TEXT,
  cwd              TEXT NOT NULL,                     -- the Oven checkout
  owner_user       TEXT,                              -- account user id, null until enrolled
  created_at       INTEGER NOT NULL,                  -- epoch ms, Oven clock
  ended_at         INTEGER,
  head_seq         INTEGER NOT NULL DEFAULT 0,
  committed_seq    INTEGER NOT NULL DEFAULT 0,        -- contiguous seq the account DB holds
  state            TEXT NOT NULL DEFAULT 'live'
                   CHECK (state IN ('live','behind','offline','ended')),
  behind_by        INTEGER NOT NULL DEFAULT 0,
  last_flush_ok_at INTEGER,
  schema_version   INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_thread_live
  ON sessions (thread_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_state ON sessions (state, head_seq);

CREATE TABLE IF NOT EXISTS turns (
  session_id        TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  turn_id           TEXT NOT NULL,
  start_seq         INTEGER NOT NULL,
  client_id         TEXT,
  client_key        TEXT,                             -- prompt idempotency key
  permission_level  TEXT NOT NULL,                    -- the level this turn actually ran with
  protections_off   TEXT NOT NULL DEFAULT '[]',       -- JSON array, see E.4
  harness_id        TEXT NOT NULL,
  provider_id       TEXT,
  account_id        TEXT,
  model_id          TEXT,
  thinking          TEXT,
  status            TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','failed','aborted')),
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  PRIMARY KEY (session_id, turn_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS turns_client_key
  ON turns (session_id, client_key) WHERE client_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  turn_id     TEXT,
  at          INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  dedupe_key  TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe
  ON events (session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_kind ON events (session_id, kind, seq);

CREATE TABLE IF NOT EXISTS cards (
  session_id   TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  turn_id      TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('permission','question','secret')),
  asked_seq    INTEGER NOT NULL,
  asked_at     INTEGER NOT NULL,
  timeout_ms   INTEGER NOT NULL,                      -- always set, one config value
  deadline_at  INTEGER NOT NULL,
  on_timeout   TEXT NOT NULL CHECK (on_timeout IN ('reject','recommended','dismiss')),
  settled_seq  INTEGER,
  settled_at   INTEGER,
  settled_by   TEXT,                                  -- 'user:<clientId>' | 'policy:timeout' | 'policy:<rule>'
  reply        TEXT,
  payload      TEXT NOT NULL,
  PRIMARY KEY (session_id, request_id)
);
CREATE INDEX IF NOT EXISTS cards_open
  ON cards (session_id, deadline_at) WHERE settled_at IS NULL;

CREATE TABLE IF NOT EXISTS outbox (
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  enqueued_at     INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  committed_at    INTEGER,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS outbox_pending
  ON outbox (next_attempt_at) WHERE committed_at IS NULL;

CREATE TABLE IF NOT EXISTS peers (
  session_id    TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('desktop','phone','cli')),
  attached_at   INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  write_lease_until INTEGER,
  PRIMARY KEY (session_id, client_id)
);
```

Retention: keep every event forever (the transcript is the product). Reclaim only by session:
`session.retire` marks `ended_at` and drops `outbox` rows already committed. This deliberately does
not inherit the run-journal caps (`MAX_RUNS 64`, `MAX_JOURNAL 64 MiB`,
`oven-service-entry.ts:280-283`), which stay for raw stdio only.

### B.3 `seq` assignment

One writer process, one transaction:

```
BEGIN IMMEDIATE;
  head = SELECT head_seq FROM sessions WHERE id = :session;          -- 409 session.lost if absent
  for each pending event e:  head = head + 1; e.seq = head
  INSERT INTO events (...) VALUES (...);                             -- UNIQUE(session_id, seq) backstop
  INSERT INTO outbox (session_id, seq, kind) VALUES (...);
  UPDATE sessions SET head_seq = :head, state = ..., behind_by = ...;
COMMIT;
```

Rules:

- `seq` starts at 1 per session, never restarts, never renumbers, never has gaps inside one commit.
- A retried append with the same `dedupe_key` (`prm_<id>`, `per_<requestId>`, `qst_<requestId>`,
  `trn_<turnId>` + step) returns the stored `seq` instead of appending. This is what makes
  `session.prompt` and a card reply safe over a flaky channel.
- The daemon's request chain (`oven-service-entry.ts:1246`) is the in-process mutex; the UNIQUE
  constraint is the on-disk one. Both are required, because a second daemon is possible after a
  crashed restart (`oven-service-entry.ts:1200-1240`).

### B.4 Event kinds

Payloads are the existing `AgentEvent` variants where one exists
(`src/lib/types/agent-events.ts:122-300`), so the desktop can render a page without translation.

| kind | payload essentials | written by |
| --- | --- | --- |
| `session.created` | `{harnessId, permissionLevel, cwd, threadId}` | session.create |
| `turn.started` | `{turnId, permissionLevel, protectionsOff[], harnessId, modelId, thinking, accountId, clientId, promptId}` | session.prompt |
| `user.prompt` | `{messageId, body, attachments[]}` | session.prompt |
| `part.updated` / `part.delta` / `message.completed` | as `AgentEvent` | fold |
| `permission.asked` | `{requestId, permission, tool, patterns, command, risk, expiresAt, timeoutMs}` | fold |
| `permission.replied` | `{requestId, reply, decidedBy, resolution, message?}` | settle |
| `question.asked` / `question.resolved` | as `AgentEvent` plus `decidedBy` | fold / settle |
| `card.expired` | `{requestId, kind, onTimeout, resolution}` | deadline |
| `session.status` | `AgentSessionStatus` | turn lifecycle |
| `session.state` | `{state, headSeq, committedSeq, behindBy}` | append/flush (state change only) |
| `session.idle` / `session.error` | as `AgentEvent` | turn lifecycle |
| `usage.updated` | as `AgentEvent` | fold |
| `steer.held` / `steer.delivered` / `steer.released` | as `AgentEvent` | prompt/steer |
| `turn.ended` | `{turnId, status, error?}` | turn lifecycle |
| `session.ended` | `{reason}` | session.retire |

A secret card is a `question.asked` whose questions satisfy `isSecretQuestion`
(`chat-engine-questions.ts:215`, `chat-engine-questions-ask.ts:256,544`), with `card.kind =
'secret'` in the `cards` row. It needs no separate event kind; the stored values never appear in a
payload, only a `storedRefs` count on resolution.

`session.state` is emitted only when the triple changes, so a log does not fill with heartbeats.

### B.5 Cursor paging

`session.events` reads `WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT n+1` — index-only on the
primary key, no byte offsets, no in-memory state. Response caps: 200 events, 256 KiB, whichever
first; `hasMore` tells the reader to ask again immediately. A page is always a contiguous `seq` run,
so a reader never sees a hole. The old run-journal `events` method keeps working unchanged for the
raw-tail path (`oven-service-entry.ts:900-935`).

### B.6 Mirror commit to the account DB

Per-user store schema (new migration `services/backend/migrations/store/0005_session_log.sql`):

```sql
ALTER TABLE IF EXISTS threads ADD COLUMN IF NOT EXISTS oven_session_id text;

CREATE TABLE IF NOT EXISTS oven_sessions (
    id            text PRIMARY KEY,
    thread_id     text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    project_id    text,
    oven_id       text NOT NULL,
    state         text NOT NULL DEFAULT 'live'
                  CHECK (state IN ('live','behind','offline','ended')),
    head_seq      bigint NOT NULL DEFAULT 0,
    committed_seq bigint NOT NULL DEFAULT 0,
    behind_by     integer NOT NULL DEFAULT 0,
    last_event_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oven_sessions_thread_idx ON oven_sessions (thread_id);

CREATE TABLE IF NOT EXISTS session_events (
    session_id  text NOT NULL REFERENCES oven_sessions (id) ON DELETE CASCADE,
    seq         bigint NOT NULL,
    kind        text NOT NULL,
    turn_id     text,
    at          bigint NOT NULL,          -- epoch ms from the Oven's clock: the only clock that matters
    payload     jsonb NOT NULL,
    payload_sha bytea NOT NULL,           -- divergence detection on a duplicate commit
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS session_events_kind_idx ON session_events (session_id, kind, seq);
```

Endpoints (added to `services/README.md` in the same change):

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| `POST` | `/v1/ovens/sessions/{sessionId}/events` | `{ovenId, events:[{seq,kind,turnId,at,payload,sha}], state:{state,headSeq}}` | Batch flush. `ON CONFLICT (session_id, seq) DO NOTHING`; a duplicate whose `payload_sha` differs answers `409 conflict`. Returns `{committedSeq, headSeq}` so the Oven can advance `committed_seq`. |
| `GET` | `/v1/threads/{id}/events?after=<seq>&limit=` | — | The phone's read path. Envelope + `nextCursor` exactly as every other list (`services/README.md:73-88`). Returns the session row so `state`/`behindBy` ride along. |
| `GET` | `/v1/threads/{id}/session` | — | One row: `{sessionId, ovenId, state, headSeq, committedSeq, behindBy, lastEventAt}`. |
| `POST` | `/v1/threads/{id}/attach-ticket` | `{clientId, kind}` | Short-lived ticket for an Oven-side attach (D.4). |
| `POST` | `/v1/ovens/enroll` | `{code, fingerprint, name}` | One-time code -> oven credential (D.1). |
| `GET` | `/v1/ovens/{id}/commands?after=` | — | Oven's outbound long-poll (D.2). |
| `POST` | `/v1/ovens/{id}/commands/{cid}` | `{result \| error}` | Result of one command. |

Order of trust: the Oven appends, the Oven flushes, the account DB stores. The account DB never
assigns `seq`, never reorders, never drops an unknown `kind` (it stores the payload verbatim so a
newer Oven can add kinds without a backend deploy).

### B.7 Offline queue and flush

The `outbox` table is the queue; it is written in the same transaction as the event, so an event
exists either in both tables or neither.

```
flush loop (single instance per Oven, owned by the daemon):
  batch = SELECT * FROM outbox WHERE committed_at IS NULL AND next_attempt_at <= now()
          ORDER BY session_id, seq LIMIT 500
  POST /v1/ovens/sessions/{sessionId}/events   (grouped by session)
  on 2xx:  UPDATE outbox SET committed_at=now() WHERE ...;
           UPDATE sessions SET committed_seq=<contiguous max>, last_flush_ok_at=now(), state=...
  on any failure: attempts+1, next_attempt_at = now() + backoff(attempts)   -- 1s,2s,4s..60s cap
```

- Batches are ordered by `(session_id, seq)` and clamped at 500 events so one flush cannot exceed the
  body limit (`withBodyLimit`, `services/backend/internal/httpapi/middleware.go:131`).
- `committed_seq` advances only across a contiguous prefix; a gap (a batch lost in a 5xx retry storm)
  is filled by the retry, never skipped.
- The queue survives a service restart: it is sqlite, not memory. It is bounded by disk, and a
  session that has been offline for a week still flushes in order on reconnect.

### B.8 State: stored, never inferred

| Field | Meaning |
| --- | --- |
| `head_seq` | highest `seq` in the Oven log |
| `committed_seq` | highest contiguous `seq` the account DB acknowledged |
| `behind_by` | `head_seq - committed_seq`, written on every append and every flush |
| `state` | `live` (`committed_seq == head_seq`), `behind` (`committed_seq < head_seq` and a flush succeeded within `OFFLINE_AFTER_MS = 60_000`), `offline` (uncommitted and no successful flush for >= 60 s), `ended` |

Transitions, all written by the Oven in one transaction with the row it describes:

| From | To | Trigger |
| --- | --- | --- |
| `live` | `behind` | an append succeeds while `committed_seq < head_seq` |
| `behind` | `live` | a flush advances `committed_seq` to `head_seq` |
| `behind` | `offline` | flush failures continue past `OFFLINE_AFTER_MS` |
| `offline` | `behind` | a flush attempt reaches the backend but is not yet complete |
| `offline` | `live` | a flush catches up |
| any | `ended` | `session.retire` |

Readers must not compute this. A client that cannot reach either source renders a *client*
reachability state, which is a different field and never overwrites the session's own state.

## C. Client attach

### C.1 Source selection

| Condition | Source | Transport |
| --- | --- | --- |
| The Oven answers `probe` in <= 1500 ms over the existing channel | `direct` | `oven-service.ts` channel -> `session.events` |
| Otherwise, and the account has a credential | `account` | HTTPS `GET /v1/threads/{id}/events` |
| Neither | nothing; render last cached page with a stale badge | — |

The decision is cached per `(ovenId)` for 30 s, so a poll loop does not re-probe every tick. A page
is read start-to-finish from one source; the client never merges two pages from different sources.
The source that served a page is shown as diagnostics only.

Preference order matches the fixed decision (same-LAN clients read the Oven directly; remote clients
read the account). It is a *preference*, not a correctness requirement: both sources return the same
`seq` space.

### C.2 Attach sequence

```
1  probe / account    -> is the Oven reachable, which store, sessionStore kind
2  session.resume     -> {session, headSeq, state, openCards}      (or GET /v1/threads/{id}/session)
3  read cursor        -> local file ovens/cursors/<sessionId>.json  {after}
4  catch-up loop      -> session.events(after) until hasMore == false
5  tail loop          -> poll every 120 ms while state == live && turn running   (direct)
                         poll every 1500 ms while direct is unavailable            (account)
6  on resume of a running turn, re-offer openCards from the page, not from memory
```

Poll cadences reuse the numbers that already exist so behaviour does not regress: 120 ms direct
(`src/main/ovens/oven-rpc-transport.ts:27`), 1000 ms desktop / 1500 ms phone when reading through the
account.

### C.3 Reconnect and catch-up

| Situation | Behaviour |
| --- | --- |
| Channel drops mid-page | Keep `after`; re-read the same page. `seq` makes the retry idempotent. |
| `head_seq` advanced by N pages | Loop until `hasMore == false`, then tail. |
| `after > head_seq` | The Oven lost the session (reimage, data root wiped). Answer `session.lost`; the client must call `session.list`/`session.resume` and show "this session is gone", never silently reset the transcript to empty. |
| A page's `state` is `live` in the account copy but the Oven is unreachable | Read from the account; show the Oven's own `behindBy`, not a guess. |
| Two clients reading | Allowed without limit. No cross-client locking on reads. |

### C.4 What a client is forbidden to do

1. Mint a session id, or persist a session record that can outlive the Oven's own.
2. Treat its local binding/JSON as the source of truth (today's `oven-chat.ts:251` file becomes a cache).
3. Answer a permission/question from local memory when the card is not in the log.
4. Append events, or write messages into a thread outside `session.prompt`/`session.steer`.
5. Renumber, compact, or re-derive `seq`.
6. Infer `state`/`behindBy` from timing.
7. Start a turn on a session whose `state` is `ended` without explicitly resuming it.

## D. Accounts, devices, attach authorization

### D.1 The Oven as an account actor

Today an Oven cannot authenticate: `/v1/ovens/heartbeat` sits behind `requireSession`
(`services/backend/internal/httpapi/router.go:108`, handler
`services/backend/internal/httpapi/ovens.go:26-33`), and a device row cannot even represent an Oven
(`services/backend/migrations/control/0001_init.sql:37` platform check;
`:45` `sessions.device_id NOT NULL`).

New control migration `services/backend/migrations/control/0004_oven_credentials.sql`:

```sql
ALTER TABLE IF EXISTS devices DROP CONSTRAINT IF EXISTS devices_platform_check;
ALTER TABLE IF EXISTS devices ADD CONSTRAINT devices_platform_check
    CHECK (platform IN ('desktop','ios','android','oven'));

CREATE TABLE IF NOT EXISTS oven_credentials (
    id           text PRIMARY KEY,
    oven_id      text NOT NULL REFERENCES ovens (id) ON DELETE CASCADE,
    user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id    text REFERENCES devices (id) ON DELETE SET NULL,
    label        text,
    token_hash   bytea NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS oven_credentials_oven_idx ON oven_credentials (oven_id);

CREATE TABLE IF NOT EXISTS oven_enroll_codes (
    id         text PRIMARY KEY,
    user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    oven_id    text REFERENCES ovens (id) ON DELETE CASCADE,
    code_hash  bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,          -- 10 minutes
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
```

Enrollment, in the shape the project already uses for OAuth handoff
(`control/0003_oauth_codes.sql`): the desktop asks for a code, shows it, the Oven is started with
`cio-oven enroll <code>`, the Oven trades it for a long-lived bearer (`cio_<43>` like every other
token, `services/backend/internal/auth/token.go:10`) and stores only the hash. The Oven's identity is
its **fingerprint** (the same value `UpsertOven` already keys on,
`services/backend/internal/store/ovens.go:12-42`), so a re-enrolled machine keeps one `ovens` row.

### D.2 Outbound connection (NAT-safe)

The Oven never listens. One cheap loop in the daemon (Node, one socket per poll):

```
loop:
  GET  /v1/ovens/{id}/commands?after=<cursor>     (long-poll, server holds <= 25 s)
  execute each command -> POST /v1/ovens/{id}/commands/{cid}
  if 204/none: sleep 1s
flush loop runs beside it (B.7)
```

Backend side: the handler parks on a `chan struct{}` per oven, woken by (a) a new command, (b) a
session event committed for a session owned by that Oven, (c) a 25 s timer. Nothing in the service
today pushes (`grep -rn "event-stream\|websocket\|Flusher" services/backend` finds nothing), so the
first implementation is long-poll, and a later SSE/WebSocket upgrade replaces the transport without
touching the protocol.

### D.3 Authorization of attach

| Reader | Proof | Checked by |
| --- | --- | --- |
| Desktop on the LAN | SSH channel to the Oven (the registry's vaulted key, `src/main/ovens/oven-registry.ts`) | The Oven service itself: a request arriving on the service socket is already the machine's own user. `peers` records the client id. |
| Phone on the LAN | attach ticket (D.4) | The Oven verifies the HMAC; the ticket names `sessionId`, `clientId`, `kind`, `exp`. |
| Phone anywhere | account session token (`services/README.md:92-107`) | The backend checks `thread -> store -> user`, then serves events from `session_events` only. |

The Oven's socket is `0600` on POSIX and a per-data-root named pipe on Windows
(`oven-service-entry.ts:163-175`, `:1269`), so a local attacker is already the machine's user. That is the
whole LAN authorization story for a desktop and must be stated in the UI, not silently assumed.

### D.4 Attach tickets

`POST /v1/threads/{id}/attach-ticket` returns `{ticket, expiresAt}` where
`ticket = base64url(HMAC-SHA256(enrollSecret, sessionId|clientId|kind|exp))`. `enrollSecret` is
issued to the Oven at enrollment (D.1) alongside its bearer. The phone carries the ticket to the
Oven's service socket in the same `session.resume` call, with `ticket` in place of a bare
`clientId`; the Oven verifies, inserts a `peers` row, and answers `{session, headSeq}`. A ticket
never grants writes: write authority is a lease (D.5).

### D.5 Multiple clients per session

| Actor | Count | Rule |
| --- | --- | --- |
| Readers | unlimited | No lock. Each keeps its own `after`. |
| Writers (`prompt`, `steer`, `abort`, card replies) | one lease per session | `peers.write_lease_until`; acquired by `session.prompt` when free, TTL 120 s, renewed by any write from the same `clientId`. A write without the lease answers `session.leaseHeld` with the holder; the client offers "take over", which is an explicit `session.lease.take` and is logged as `session.lease` event. |

Rationale: two clients prompting one harness process is not a merge problem, it is two different
conversations. Arbitration cards are exempt: any client holding a valid ticket or channel may settle
a card, and the first settle wins (`cards.settled_at` closes it).

## E. Permissions

### E.1 `oven_mode` (in flight, uncommitted in the tree)

| Piece | Location | State |
| --- | --- | --- |
| Type | `src/lib/types/common.ts:36` (`'auto_review' \| 'full_access' \| 'oven_mode'`) | in flight |
| Semantics helper | `src/lib/permission-level.ts` (`isUnrestrictedLevel`, policy-mode mapping) | in flight, untracked |
| Picker catalogue, last position | `src/renderer/lib/actions/permission-actions.ts:18-45` | in flight |
| IPC validation | `src/main/ipc/validation/threads.ts:56` | in flight |
| Policy mode + protection bypass | `src/main/permissions/permission-policy.ts` (mode type at `:8`, sensitive-file branch at `:270-300` at HEAD) | in flight |
| Pi gate | `src/main/drivers/pi/tools/core-tools-events.ts:320` (`evaluateGate(..., !skipSensitive)`) | to do: `oven_mode` must pass `includeSensitive = false` and skip the destructive-command rules |
| Harness yolo flags | `src/main/ovens/oven-chat.ts:486` (`const full = settings.permissionLevel === 'full_access'`) | to do: use `isUnrestrictedLevel` |
| Destructive colour | `--color-danger` (`src/renderer/app.css:57`, dark `:199`, `:226`) | to do in the picker: `text-danger`, not `text-warning` |

Offering rule: `oven_mode` appears only when the composer's resolved target is a remote Oven before
send (`ChatComposer-handle-drop-data.svelte.ts:84` `targetOvenId`, `OvenControls.svelte:47`
`oven:selectThread`). Selecting it while the target is `local` is refused, not silently downgraded.

### E.2 Card deadlines (one value, every card)

| Card | Deadline at HEAD | Deadline after this plan |
| --- | --- | --- |
| Question | armed, `chat-engine-questions.ts:180` + `schedulePendingQuestion` | same value, moved to the Oven (`cards`) |
| Secret | armed via the same `PendingQuestionInfo.timer` (`chat-engine-types.ts:374-383`) | same |
| Permission | **none at HEAD** (`chat-engine-types.ts:358-371` has no `timer`; only the policy approval TTL is checked at reply time, `chat-engine-permissions.ts:117-127`) | in flight locally; must become an Oven-side `cards` row so it expires with every client closed |
| Oven-thread cards (all three) | **none**: `OvenChat` publishes straight to `engine.broadcast` (`chat-engine/chat-engine-wiring.ts:145-159`), bypassing `handlePermissionAsked` (`chat-engine-turns.ts:1121-1124`, `chat-engine-permissions.ts:499,659`), and its questions come from an in-memory map (`oven-chat.ts:1343-1345`) | enforced by the Oven, independent of any client |

`timeout_ms` is `questionTimeoutMs` (`src/main/storage/storage-engine.ts:106` default 300000; bounds
10000..3600000 in `src/main/ipc/handlers/config-helpers.ts:721-732`). It is sent to the Oven with every
`session.create` and `session.prompt`, so the Oven never reads a client setting at expiry time.

### E.3 Auto-reject and its log representation

A permission card that expires is refused with guidance that keeps the turn alive. The local
behaviour to preserve is the sibling's `expirePermission`: reject, with the instruction "do not
retry that exact action; find another way".

Log entries, in order:

| seq | kind | payload |
| --- | --- | --- |
| n | `permission.asked` | `{requestId, permission, tool, patterns, command, risk, expiresAt, timeoutMs}` |
| n+k | `permission.replied` | `{requestId, reply:"reject", decidedBy:"policy:timeout", resolution:"timeout", message:"The permission card for <permission> was automatically rejected after <m> minute(s) without an answer. Do not retry that exact action. ..."}` |
| n+k | `card.expired` | `{requestId, kind:"permission", onTimeout:"reject", resolution:"timeout"}` |

`decidedBy` is new on the wire and is required: today `permission.replied` carries only
`{requestId, reply}` (`src/lib/types/agent-events.ts:237-247`), so a reader cannot tell a user's
refusal from a deadline's. Values: `user`, `user:<clientId>`, `policy:timeout`, `policy:<rule>`,
`settings:sensitive-files-disabled` (the rule name style already exists,
`chat-engine-permissions.ts:735,749`).

The user-facing ledger (`src/main/system/auto-answer-store.ts`, `AutoAnswerKind` at HEAD lacks
`permission`, `src/lib/types/attention.ts:13`) stays as the attention rail; the log is the durable
record. Overlap is intentional, not duplication of truth: the rail is a UI projection of the log's
`card.expired` events.

### E.4 How a late joiner learns which level applied

`turn.started` carries the level and the guards that were skipped:

```json
{"turnId":"trn_...","permissionLevel":"oven_mode",
 "protectionsOff":["bundled-pi-file-policy","sensitive-file-guard","destructive-command-guard"],
 "harnessId":"pi","modelId":"...","thinking":"high","accountId":"acc_...","clientId":"cli_...",
 "promptId":"prm_..."}
```

Rules: the payload is written once, at turn start, from the value the desktop sent with the prompt —
never re-read from a thread default later. `turns.permission_level` mirrors it for querying. A turn
started under `oven_mode` and a turn started under `full_access` are distinguishable forever, in both
the Oven log and the mirrored rows.

## F. Migration order and risk

### F.1 One-way doors

| Door | Why irreversible | When it closes |
| --- | --- | --- |
| `seq` identity of an event | Account PK is `(session_id, seq)`; renumbering orphans every mirror row | S1 |
| Oven-minted session id (`ovs_`) | Becomes the account FK and the cursor namespace | S1 |
| v2 method names | Two desktops on different builds share Ovens; renaming breaks the older one | S1 (additive only, forever) |
| `threads.status` authority | Once the Oven owns turn status, a desktop that keeps writing status creates two truths | S3 |
| Deleting `ovens/threads/*.json` | In-flight turns of older builds lose their only record | after S3 is on every build |
| `payload_sha` divergence check | Once a divergent duplicate 409s, a re-commit needs a manual repair path | S2 |

Additive, safe to do in any order: new `session.*` methods; new probe fields; new tables; new event
kinds; `decidedBy` on existing events.

### F.2 Ordered slices

| Slice | Content | Delivers | Breaks if skipped |
| --- | --- | --- | --- |
| S0 | The pluggable-now list in G.2 (card deadlines on Oven threads, `decidedBy` in the wire types, `oven_mode` finished, cards persisted locally) | Correct behaviour with no protocol change | Every later slice inherits cards with no deadline |
| S1 | Oven sqlite store, `seq`, mapped events, `session.create/resume/prompt/abort/events`, folds bundled into the Oven service, desktop reads through it | A session surviving the desktop: another desktop on the LAN attaches to the same turn | The mirror has nothing to mirror |
| S2 | Oven enrollment + credential, outbound long-poll, `outbox`, `POST .../events`, `GET /v1/threads/{id}/events`, phone read view | **Send once, close the laptop, attach from a phone** | S3 has no distribution path |
| S3 | Cards owned by the Oven with deadlines, `session.permission.reply`/`session.question.reply`, auto-reject from the Oven | A turn that finishes (or auto-rejects) with every client closed | S4 cannot arbitrate |
| S4 | Write lease, `session.steer`, multi-writer rules, `session.list` browsing | Any client can continue a session | — |
| S5 | Cloud Oven: the same Oven behind a public address; nothing new in the protocol | Quality parity for a hosted Oven | — |

### F.3 The smallest slice that delivers the phone case

S1 + the minimum of S2, scoped to one thread:

1. Oven: `sessions`, `events`, `outbox` tables; `seq`; folds for the one harness under test.
2. Oven: `session.create`, `session.prompt`, `session.events`, `session.state`.
3. Oven: enrollment code path and the outbound flush loop (25 s long-poll).
4. Backend: `0005_session_log.sql`, `POST /v1/ovens/sessions/{id}/events`,
   `GET /v1/threads/{id}/session`, `GET /v1/threads/{id}/events`, `control/0004_oven_credentials.sql`.
5. Phone: read a thread from `/v1/threads/{id}/events` with its own cursor, rendering
   `live | behind | offline` from the row (not from timers).
6. Desktop: behind a per-Oven flag, stop writing `ovens/threads/*.json` as truth; keep it as a cache.

Explicitly out of slice 1 (and acceptable, because it is a read-only attach): prompting from the
phone, settling cards from the phone, LAN direct attach for the phone, write leases. A slice-1 phone
sees every event, including `permission.asked` with its `expiresAt`, and can see the Oven-side
auto-reject when it happens.

### F.4 Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `node:sqlite` missing or flagged on an older Oven runtime | No store | Probe once, report `sessionStore`, fall back to the JSONL store with the same read API (B.1) |
| Service replacement refuses while runs are active (`oven-service-entry.ts:941-945`) | A session blocks the update | Sessions restore from sqlite at daemon start the way runs restore from `runs/*.json` (`oven-service-entry.ts:1219-1240`); the refusal message names sessions, not just runs |
| One serialized request chain (`oven-service-entry.ts:279,1246`) | A read stalls a stop | Reads bypass the chain (A.3) |
| Mirror body limit | A large page rejected | 500-event / 256 KiB batch caps (B.7) |
| Clock skew between Oven and backend | Wrong ordering in the account view | `session_events.at` is the Oven's ms and the sort key is `seq`, never `at` |
| Two desktops, different builds, one Oven | Service thrash | Service replacement is already cooldown-guarded (`oven-service.ts:99`, `:436-460`, `:470-500`); v2 is additive so a revision mismatch does not force a value change |
| A phone holding an attach ticket after revocation | Stale access | Ticket TTL 5 min + `peers` revoke + device revocation already cascades (`services/backend/internal/store/devices.go:102-130`) |

## G. Hole checklist

### G.1 Needs the protocol change

| # | Hole | Evidence |
| --- | --- | --- |
| 1 | Session id is minted by the desktop; no Oven-side session exists | `src/main/ovens/oven-chat.ts:314`; the Oven only knows a `runId` (`oven-service.ts:220-230`) |
| 2 | Session record lives only on the desktop and every read requires it | `oven-chat.ts:251` (path), `:913-916` (`restore` returns when absent) |
| 3 | Session identity is a hash of a client-side directory | `src/main/drivers/persistent-cli/persistent-cli-session.ts:4-7`; `oven-chat.ts:375`; re-stamp fix `persistent-cli-driver.ts:238` called from `chat-engine-turns-send-prompt.ts:167` |
| 4 | The Oven journal is raw stdio; the mapping is desktop code | `oven-service-entry.ts:773-795`, `:900-935`; `src/lib/ovens.ts:202-206`; `oven-chat.ts:1097-1160` |
| 5 | History is capped and deletable | `oven-service-entry.ts:280-283` (`MAX_RUNS 64`, `MAX_ACTIVE 4`, `MAX_JOURNAL 64 MiB`), `:981-988` (`remove` unlinks) |
| 6 | Cursor offsets are in-memory only | `oven-service-entry.ts:301`, `:900-935` |
| 7 | Pages cap at 128 records / 256 KiB and there is no session read at all | `oven-service-entry.ts:924` |
| 8 | Protocol 1 rejects unknown methods and is version-pinned | `oven-service-entry.ts:71`, `:938`, `:954-956`; `src/lib/ovens.ts:5` |
| 9 | All daemon requests serialize behind one promise | `oven-service-entry.ts:279`, `:1246` |
| 10 | Cards are process memory; `dispose` leaves the run with nobody to answer | `oven-chat.ts:1295`, `:1343-1345`, `:1348`, `:1425` |
| 11 | Oven threads bypass the permission policy entirely | `chat-engine-wiring.ts:145-159` vs `chat-engine-turns.ts:1121-1124`, `chat-engine-permissions.ts:499,659` |
| 12 | No deadline on any Oven-thread card; HEAD has no permission-card deadline at all | `chat-engine-types.ts:358-371` (no `timer`) vs `:374-383`; `chat-engine-permissions.ts:117-127` |
| 13 | An Oven cannot authenticate; a device row cannot be an Oven | `httpapi/router.go:108` + `httpapi/ovens.go:26-33`; `control/0001_init.sql:37`, `:45` |
| 14 | No Oven outbound channel and no desktop backend client | `docs/HOSTED-SERVICES.md:149-151` ("sync and the desktop adapter are not [built]"); no `/v1/` client under `src/main` |
| 15 | Account DB has no log tables and no streaming transport | `services/backend/migrations/store/0001..0004`; no SSE/WebSocket anywhere in `services/backend` |
| 16 | A second client cannot change a running turn's settings | `src/lib/engines/thread-manager.ts:894-903` (refuses while busy); the per-turn shape already exists for prompts (`store/0004_thread_composer.sql:35-40`) |
| 17 | Thread status authority is local | `store/0001_init.sql:28-52` mirrors status; the Oven has no status notion |

### G.2 Pluggable now (no protocol change)

| # | Gap | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | A permission card has no deadline on the Local path | `chat-engine-types.ts:358-371`, `chat-engine-permissions.ts:117-127` | sibling's in-flight `schedulePermissionTimeout` / `expirePermission` |
| 2 | Oven-thread permission cards skip policy and the timer | `chat-engine-wiring.ts:145-159` | arm a deadline inside `OvenChat` (S0) and route through `handlePermissionAsked` where the request is harness-shaped |
| 3 | Oven-thread question/secret cards have no deadline | `oven-chat.ts:1343-1345` | same timer in the `live.questions` map (S0) |
| 4 | `permission.replied` carries no `decidedBy`/`resolution`; `question.resolved` carries no `decidedBy` | `src/lib/types/agent-events.ts:237-247` | widen the payloads now so the log can record them from the first commit |
| 5 | Open cards are not persisted; a desktop restart drops them | `oven-chat.ts:913-916`, `:1425` | write open cards into the binding JSON's `resolved`-style list, re-offer on `restore` |
| 6 | `oven_mode` not yet accepted by IPC validation | `src/main/ipc/validation/threads.ts:56` | sibling's change (in flight) |
| 7 | Picker renders `full_access` in `text-warning`; `oven_mode` must be destructive | `ChatComposerPermissionPicker.svelte:49-50,58,79-87` (HEAD), `app.css:57` | add the `oven_mode` branch |
| 8 | Harness yolo flags test for `full_access` literally | `oven-chat.ts:486` | switch to `isUnrestrictedLevel` |
| 9 | Auto-answer ledger has no `permission` kind at HEAD | `src/lib/types/attention.ts:13` | sibling's change (in flight) |
| 10 | A probe cannot report the Oven's store kind or session head | `src/lib/ovens.ts` `OvenProbe` | additive optional fields (`sessionStore`, `sessions: n`), safe for older clients |

## H. Open questions this plan does not answer

1. Whether the account `session_events` rows are pruned when the desktop's own retention rule lands
   (`docs/HOSTED-SERVICES.md:160-162` names the same problem for messages).
2. Whether a second Oven may hold a copy of a session (today: no; a session belongs to one Oven, and
   `session.lost` is terminal).
3. Whether the phone may answer a card in slice 2 or only in S3. Slice 1 says read-only.
4. Whether `always` approvals survive a session resume on the Oven (they are per-turn today and the
   per-turn record now lives in `turns`).
