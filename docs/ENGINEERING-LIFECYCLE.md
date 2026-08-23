# Engineering lifecycle

The Engineering Toolbox stores one canonical selection per project thread: `none`, `brainstorm`, `prd`, `spec`, `assignment`, `achievement`, or `run_all`. Selecting a stage does not mark it as started. The first start sets `started_at`; that timestamp is permanent and keeps the Toolbox filled after completion, cancellation, failure, reload, or restart.

## Stage behavior

Single-stage runs stop after their selected stage. PRD finalization does not select Spec. Spec approval does not start implementation. Assignment and Achievement require an approved Spec.

Run all advances in this order:

1. Brainstorm
2. Optional prototype work inside Brainstorm
3. PRD
4. Spec
5. Assignment
6. Achievement audit and rework

Run all remains selected while work is active or awaiting a human decision. Completed stages are persisted before the next stage starts. Resume tokens are bounded, single-use, and safe to replay: a repeated consumed token returns the current state without repeating work.

Human gates cover LoFi selection when HiFi is offered, Brainstorm finalization, PRD finalization, Spec approval, Assignment approval, and acknowledged terminal failures. A hard failure retains the failed stage and selection behind a single-use retry token; Retry re-enters that same stage, while Stop uses the normal confirmation flow. Replacing or stopping an active run requires confirmation. Existing documents and prototype artifacts are preserved after cancellation.

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
