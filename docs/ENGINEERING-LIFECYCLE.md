# Engineering lifecycle

The Engineering Toolbox stores a set of independent stage switches per project thread and an optional **Auto Pilot** flag. Any combination of `brainstorm`, `prd`, `spec`, `assignment`, and `achievement` can be enabled at once; the lifecycle runs the enabled stages in canonical order (`brainstorm → prd → spec → assignment → achievement`), skipping stages that are not enabled. Selecting a stage does not mark it as started. The first start sets `started_at`; that timestamp is permanent and keeps the Toolbox filled after completion, cancellation, failure, reload, or restart.

## Circle completion (implementation mode)

Manual (non-Auto-Pilot) mode is **circular**, not chained. When a stage's circle completes (Brainstorm is finalized, PRD is finalized, Spec is approved and implemented, an Assignment is approved and run, an Achievement goal is audited to done), the engine:

- marks the stage complete and **turns that stage's switch OFF** (removes it from the selection),
- clears `active_stage`, so the thread drops to **implementation mode**.

It does **not** auto-advance to the next selected stage in manual mode. The remaining stages keep their switches ON but stay parked. The only way to start the next stage is a **designated button**: the Brainstorm/PRD Studio "Next step" menu (Generate PRD / Generate Spec), the Spec Studio "Review / Implement" buttons, the assignment "Generate assignment" action, or the audit "Start audit" actions. `Auto Pilot` and a manual run that includes `achievement` keep the chained behavior so the audit/rework loop can drive the pipeline forward.

A plain chat message sent while the lifecycle is parked is answered normally in implementation mode. The model is instructed not to re-enter brainstorming, generate a new specification, or reformulate problem statements unless one of those designated buttons is used; if the user asks it to implement/advance from a plain message, it points them at the Engineering Studio buttons (or to forking a branch and disabling Engineering mode instead).

## Stage behavior

Dependencies cascade when a switch is enabled: **Achievement implies Spec**, so enabling it leaves the Spec switch on. **Assignment stands alone** and never turns Spec on see _Assignment sources_ below. Achievement is a loop mode and never enables Assignment. Turning on PRD or Spec never turns on Brainstorm instead, PRD and Spec require context, so the **engineer entry card** ("Brainstorm first | Jump directly into PRD/Spec") is shown at the point of sending a message, never when the switch is toggled. Jumping in still lets the Sr. Engineer ask alignment questions; it simply skips the Brainstorm document and generates the PRD or Spec from the message instead.

Single-stage runs stop after their selected stage. PRD finalization does not select Spec. Spec approval does not start implementation on its own. Achievement requires an approved Spec; Assignment does not.

### Assignment sources

An Assignment always has exactly one authoritative source, resolved when generation runs:

- **Spec-backed** an approved Spec exists, so it is the immutable scope and the Assignment records the Spec identifier and version. A Spec that exists but is not yet approved still owns the Assignment: approve it first, or dismiss the Spec review to fall back to the conversation.
- **Conversation-backed** no Spec exists, so the user's message and the thread conversation are the scope. Every distinct work item the message names becomes its own task, the Sr. Engineer inspects the project read-only to resolve concrete `expectedFiles`, and the Assignment is persisted with no Spec identifier.

Both sources produce the same reviewable draft, the same human Assignment-approval gate, and the same durable worker threads. A conversation-backed Assignment completes into an audit run against its own task prompts and conversation, because there is no specification to audit against.

The user's message that triggers generation is passed to the Sr. Engineer as that Assignment's request, so a send in the Assignment stage is never silently discarded.

### Assignment interview

The Assignment stage is conversational, exactly like the Brainstorm and PRD stages. A send in the Assignment stage is never force-decomposed: the Sr. Engineer reads the whole thread (the user's message plus everything the conversation already recorded, and the approved Spec as well when one exists) and then either submits or interviews.

- **Submits** when the source already holds a task graph: concrete deliverables, the files or areas each one touches, ownership, dependencies, and how every task is verified. The submission persists the draft, or replaces the unsigned draft the same turn is re-deriving, and it always advances the Assignment-approval gate.
- **Interviews** when it does not: the Sr. Engineer asks only the unresolved task-graph questions through the question tool and ends the turn on them, keeping every question as a card in the conversation. The answers resume the same logical turn and the interview repeats until the source is sufficient. A partial, speculative, or invented graph is never submitted to look complete.

The interview owns both the active Assignment stage and its `assignment_approval` gate, so the unsigned draft under review can still be reworked by talking to the Sr. Engineer. Two paths deliberately bypass the interview: **Auto Pilot**, which has nobody to answer and keeps the forced background decomposition, and the explicit **Generate assignment** action, which is the user asking for the graph now.

Once the Assignment is signed, its thread stops being a planning turn altogether. The Sr. Engineer coordinates the workers there, so plain messages are an ordinary coordinator conversation (and each worker thread stays independently chat-able) instead of reopening the specification pipeline.

### Worker reporting

A worker thread decides for itself whether the finished task goes back to the Sr. Engineer. The composer footer of any worker thread carries a reporting control next to the git branch pill: it reads **Reporting** in green while the worker hands its work back, and **Not reporting** in amber once the user has taken the thread over.

- **Reporting (default)** is the full Assignment loop. The worker receives the Assignment API contract with its task prompt, submits baseline and check evidence, and reports the task when the work is complete, which is what makes the Sr. Engineer audit the thread.
- **Not reporting** makes the thread a private iteration loop. Every worker prompt dispatch, Sr. Engineer steer, and reactivation after a direct user message replaces the report-task contract with an explicit instruction to finish the work in the conversation, no worker API capability is minted, and the report is refused at the Assignment boundary with an `invalid_transition` error. The task therefore never advances to `reported` and the coordinator is never prompted, so no review or audit can start while the user iterates directly with the worker.

The setting lives on the thread (`ThreadSettings.reportToCoordinator`) and applies to the whole thread rather than one turn, so it survives navigation and restarts. Because the refusal is enforced in the engine rather than only in the prompt, switching reporting off mid-run still stops that run from reporting. Switching it off is destructive and confirms through the shared `ConfirmDialog`, which states that the Sr. Engineer will not be able to audit the thread; switching it back on restores the hand-off immediately.

The coordinator panel marks the state without opening a thread: a task whose worker has reporting off carries an amber **Not reporting** badge next to the worker name in the task row, in the same tooltip and accessible name as the row itself.

Because such a worker never hands its task back, the Assignment lifecycle is frozen for it. A live worker turn no longer flips the task to `running`: `AssignmentEngine.markWorkerSteered` returns the plan untouched when the worker's reporting is off, so the task stays wherever the user left it instead of sitting on `running` forever with no report coming to settle it. The row shows the worker thread's own live status next to the badge instead, using the same indicator, colour, and wording as the thread row (Working, Waiting to retry, Needs approval, Spec ready, Needs attention, Unread, Done, New), and the frozen lifecycle pill is hidden for that row because it can no longer advance. Worker threads settle unread exactly like regular threads: opening or selecting one marks it read through the same `thread:markRead` flow, so the chip moves from Unread (green) to Done once the user has seen it.

### Assignment audit offer

When implementation finishes, the coordinator thread shows the **Implementation finished** offer that starts the independent audit. Cancelling the offer does not end the audit cycle. It hides the composer prompt for that thread and reveals the ordinary composer, so the Sr. Engineer can simply be talked to again, and the worker hand-off loop is untouched.

The cycle stays `available` with `offerDismissedAt` set, so the audit remains reachable from the coordinator panel's **Audit Work** action and from Spec Studio, and asking for it there restores the composer prompt (`audit:restoreOffer`). Starting the audit or making it available again clears the dismissal.

### Worker scope

An Assignment runs in the scope its coordinator already uses. Sign-off freezes that scope onto the plan (`AssignmentPlan.scopeBucketId`, taken from the coordinator thread and falling back to Default), and every worker thread is created inside it, so the default is that workers share the Sr. Engineer's checkout and branch.

A phase can be pointed somewhere else too, exactly like the phase model: the phase header in the assignment review carries the same scope picker next to its model picker, and the choice lives on the phase (`AssignmentPhase.workerScope`). A phase pick governs that phase and every phase after it, mirroring the phase-model cascade, so a mid-list pick never bleeds upward. Dispatch resolves `task.workerScope ?? phase.workerScope ?? inherit`, so a task override always wins and the Assignment's own scope is the final fallback.

Both levels offer the same three choices. Each worker task also carries the picker on its own row, and its choice lives on the task (`AssignmentTask.workerScope`):

- **Inherit (default)** the worker runs in whatever the level above resolved to: the Assignment's scope for a phase, the phase's choice for a task. No field is stored, and `workerScopeBucketId` is deliberately not consulted, so a task whose scope the user changed back to inherit follows wherever inherit points now rather than the checkout an earlier choice created.
- **Dedicated worktree** the worker gets a managed worktree scope of its own, with its own branch and setup, created when the task is dispatched. Signing off an Assignment with a dozen such tasks stays instant because nothing is created up front. A phase with this choice gives every one of its tasks its own worktree, one per dispatch.
- **Existing scope** the worker runs in a scope already on the project board, or one created from the picker on the spot.

Provisioning happens in the app rather than the engine. The engine calls an `AssignmentWorkerScopeProvisioner` port, installed on it by the IPC layer once the scope and worktree services exist, and that implementation creates the bucket and then the worktree exactly like an agent-made scope, including rolling the empty bucket back if the worktree never lands. A dedicated scope is named after the worker and its task, uniquified against every existing scope name, because scope names are how a scope is addressed by reference and a duplicate would make every name-based lookup ambiguous.

`AssignmentTask.workerScopeBucketId` records the scope a dispatched worker actually runs in. A retried task passes it back to the provisioner, so a replacement worker reuses the checkout holding the failed attempt's commits instead of leaking a second worktree for the same task. Changing the choice clears it, and the engine refuses both to change a scope once a worker thread exists and to fail a dispatch quietly: if the scope can no longer be created or found, the dispatch fails with `scope_unavailable` and the task stays `ready` rather than starting a worker in the wrong directory. The auditor always inherits the Assignment scope.

Agent-generated task graphs cannot set a worker scope, at either level. Only the human choice made on the review surface does, so Autopilot, which has no sign-off, always inherits.

### Reopening a finished worker

A direct message to a worker thread is work, not a dead end. When a worker that already finished its task starts a new turn from the user, live activity is authoritative: the task returns to `running` (its report and review are cleared), the Assignment returns to `running`, and the turn carries the worker's Assignment API contract again, because that capability is revoked when the Assignment completes. The worker can therefore submit fresh baseline/check evidence and report the task back to the Sr. Engineer exactly as it did the first time, and the coordinator panel, the Assignment studio, and the task row all show the run from the moment it starts. An explicitly `stopped` Assignment is never reopened this way, and a task that is `reported`, `auditing`, or `rework` stays with the coordinator while it reviews. The restored contract follows the thread's reporting setting: with reporting switched off, the turn carries the stand-down instruction instead and the task is never handed back (see _Worker reporting_ above).

After a Brainstorm session, the studio offers a **Next step** menu instead of a single "Prepare spec" action: Prototype Lo-Fi, Prototype Hi-Fi, Generate PRD, or Generate Spec. Prototype steps steer the Sr. Engineer to extend the Brainstorm; PRD and Spec steps finalize the Brainstorm and produce the requested document. Likewise, after a PRD finalizes, the PRD Studio offers a **Next step** menu to Generate Spec.

### Auto Pilot

Auto Pilot replaces the old "Run all" toggle. It is a full-autonomy mode: the lifecycle runs `brainstorm → prd → spec → assignment → achievement` and keeps the achievement audit/rework loop active until the goal passes or reaches a hard terminal failure. Auto Pilot generates only what the pipeline needs the Brainstorm may be skipped, the message is used as input (alignment questions are still allowed), a Spec is generated, worker tasks are assigned to the re-used workers from the last run or the agent defaults, and the run proceeds without waiting for human intervention. Auto Pilot therefore always takes the spec-backed source above.

## Stage behavior (original single-run notes)

Completing a stage advances to the next enabled stage; when no further stage is enabled the run terminates. Run all remains selected while work is active or awaiting a human decision. Completed stages are persisted before the next stage starts. Resume tokens are bounded, single-use, and safe to replay: a repeated consumed token returns the current state without repeating work.

> Note: the automatic-advance described here applies to Auto Pilot and achievement-loop runs. Manual multi-select runs stop at circle completion (see _Circle completion_ above).

Human gates cover LoFi selection when HiFi is offered, Brainstorm finalization, PRD finalization, Spec approval, Assignment approval, and acknowledged terminal failures. A hard failure retains the failed stage and selection behind a single-use retry token; Retry re-enters that same stage, while Stop uses the normal confirmation flow. Replacing or stopping an active run requires confirmation. Existing documents and prototype artifacts are preserved after cancellation. Resuming a decision gate for a manual run re-enters the gate's owning stage so the follow-up `completeStage` can finish the circle.

## PRD contract

Every PRD contains title, summary, Problem, Goals, Non-goals, Users and Use Cases, Product Requirements, Experience Flow, Acceptance Criteria, Dependencies, Risks, and Open Questions. Open Questions may be empty; all other sections require content.

Immutable versions are written to `.cio/specs/<feature-slug>/versions/<prd-id>-v<version>-prd.md`. Finalization records a SHA-256 input hash. A later Spec may record the finalized PRD identifier, version, and input hash alongside Brainstorm provenance.

When neither a PRD nor Brainstorm exists, direct PRD selection pauses at `Brainstorm first` or `Start PRD`. The Brainstorm-first choice persists its nested Brainstorm review gate while the lifecycle remains on PRD, then returns to PRD drafting after finalization. Existing finalized Brainstorm material skips the entry choice. PRD finalization clears an individual PRD selection and never selects Spec.

## Prototype contract

Prototype content exists only when explicitly requested. LoFi identifiers are `L1`, `L2`, and so on; HiFi identifiers are `H1`, `H2`, and so on. A direct HiFi request defaults to `H1`. An unspecified LoFi request defaults to `L1` and `L2`. Larger requests are split into serial batches of at most two.

Canonical files live at `.cio/specs/<feature-slug>/prototypes/<prototype-id>/`. Project-facing links use `cio/<feature-slug>-<lowercase-prototype-id>/`. Existing paths are never silently replaced. Each asset is limited to 25 MiB and a prototype session to 100 MiB; hashing and delivery use bounded streams.

## Preview deployment

`CODEINOVEN_PUBLIC_PROTOTYPE_PREVIEW_ORIGIN` is the runtime public origin. `MAIN_VITE_PUBLIC_PROTOTYPE_PREVIEW_ORIGIN` is the build-time public value. Production and remote access require an explicit HTTPS origin. Development may omit both values and use the app-owned `http://127.0.0.1:<allocated-port>` service.

`REMOTE_API_ORIGIN` and `ACCOUNT_AUTH_ORIGIN` retain their existing meanings and are never preview-origin fallbacks. A missing production preview origin is a deployment-readiness failure; the relative `cio/<slug>/` path remains visible for diagnosis.

Desktop preview registration is reconstructed from validated feature-scoped manifests after restart. Remote and mobile clients request 192 KiB chunks through the authenticated, encrypted workflow RPC and assemble a bounded Blob locally; ownership is checked against the active Brainstorm metadata before any canonical file is read. The relay's existing 1 MiB frame cap remains unchanged, and neither the account origin nor arbitrary filesystem RPC is used for prototype delivery.

## Recovery

- Generation failure: keep the lifecycle selected, fix the provider or validation failure, and retry from the persisted stage.
- Invalid preview link: verify the feature-scoped artifact, manifest, preview link target, and configured public origin.
- Unsupported symlink or junction environment: preserve the canonical artifact and report the preview as unavailable; do not copy over another preview.
- Remote disconnection: reconnect the paired client and reload the persisted lifecycle before resuming.
- Cancellation after artifact creation: confirm cancellation; generated artifacts remain available and `started_at` remains set.
