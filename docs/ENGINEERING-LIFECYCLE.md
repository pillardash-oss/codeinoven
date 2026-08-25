# Engineering lifecycle

The Engineering Toolbox stores a set of independent stage switches per project thread and an optional **Auto Pilot** flag. Any combination of `brainstorm`, `prd`, `spec`, `assignment`, and `achievement` can be enabled at once; the lifecycle runs the enabled stages in canonical order (`brainstorm → prd → spec → assignment → achievement`), skipping stages that are not enabled. Selecting a stage does not mark it as started. The first start sets `started_at`; that timestamp is permanent and keeps the Toolbox filled after completion, cancellation, failure, reload, or restart.

## Circle completion (implementation mode)

Manual (non-Auto-Pilot) mode is **circular**, not chained. When a stage's circle completes (Brainstorm is finalized, PRD is finalized, Spec is approved and implemented, an Assignment is approved and run, an Achievement goal is audited to done), the engine:

- marks the stage complete and **turns that stage's switch OFF** (removes it from the selection),
- clears `active_stage`, so the thread drops to **implementation mode**.

It does **not** auto-advance to the next selected stage in manual mode. The remaining stages keep their switches ON but stay parked. The only way to start the next stage is a **designated button**: the Brainstorm/PRD Studio "Next step" menu (Generate PRD / Generate Spec), the Spec Studio "Review / Implement" buttons, the assignment "Generate assignment" action, or the audit "Start audit" actions. `Auto Pilot` and a manual run that includes `achievement` keep the chained behavior so the audit/rework loop can drive the pipeline forward.

A plain chat message sent while the lifecycle is parked is answered normally in implementation mode. The model is instructed not to re-enter brainstorming, generate a new specification, or reformulate problem statements unless one of those designated buttons is used; if the user asks it to implement/advance from a plain message, it points them at the Engineering Studio buttons (or to forking a branch and disabling Engineering mode instead).

## Stage behavior

Dependencies cascade when a switch is enabled: **Assignment and Achievement both imply Spec**, so enabling either one leaves the Spec switch on. Achievement is a loop mode and never enables Assignment. Turning on PRD or Spec never turns on Brainstorm — instead, PRD and Spec require context, so the **engineer entry card** ("Brainstorm first | Jump directly into PRD/Spec") is shown at the point of sending a message, never when the switch is toggled. Jumping in still lets the Sr. Engineer ask alignment questions; it simply skips the Brainstorm document and generates the PRD or Spec from the message instead.

Single-stage runs stop after their selected stage. PRD finalization does not select Spec. Spec approval does not start implementation on its own. Assignment and Achievement require an approved Spec.

After a Brainstorm session, the studio offers a **Next step** menu instead of a single "Prepare spec" action: Prototype Lo-Fi, Prototype Hi-Fi, Generate PRD, or Generate Spec. Prototype steps steer the Sr. Engineer to extend the Brainstorm; PRD and Spec steps finalize the Brainstorm and produce the requested document. Likewise, after a PRD finalizes, the PRD Studio offers a **Next step** menu to Generate Spec.

### Auto Pilot

Auto Pilot replaces the old "Run all" toggle. It is a full-autonomy mode: the lifecycle runs `brainstorm → prd → spec → assignment → achievement` and keeps the achievement audit/rework loop active until the goal passes or reaches a hard terminal failure. Auto Pilot generates only what the pipeline needs — the Brainstorm may be skipped, the message is used as input (alignment questions are still allowed), a Spec is generated, worker tasks are assigned to the re-used workers from the last run or the agent defaults, and the run proceeds without waiting for human intervention.

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
