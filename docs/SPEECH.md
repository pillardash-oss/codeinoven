# Local speech

CodeInOven treats speech as an app-owned local subsystem. The renderer captures audio, but it does not run inference, read model files, or receive absolute paths from the application data directory. Typed IPC connects the renderer to bounded main-process services and packaged workers.

## Runtime policy

The recommended runtime is platform-specific:

| Platform | Architecture  | Recommended runtime |
| -------- | ------------- | ------------------- |
| macOS    | Apple Silicon | MLX                 |
| macOS    | Intel         | sherpa-onnx         |
| Windows  | x64           | sherpa-onnx         |
| Linux    | x64 or arm64  | sherpa-onnx         |

The current macOS package targets Apple Silicon. The Intel row remains part of the compatibility contract so runtime selection stays deterministic if packaging expands later.

A user may override the recommendation with another installed, compatible runtime. An unavailable override fails with a compatibility error; CodeInOven never changes runtime, model, or network path silently after a failure.

Runtime executables and native libraries ship inside the application. The packaged feature never resolves a speech worker from `PATH` and never requires Bun, Python, or an interactive shell. Model weights are separate downloads and never belong in the application bundle.

Chromium's MediaRecorder output is decoded to mono 16 kHz WAV by the pinned packaged `ffmpeg-static` executable inside the sherpa worker thread before ASR. Decoding never runs on the renderer or Electron main event loop, and its temporary WAV is removed after inference.

## Model catalog and admission

`resources/speech/model-catalog.json` groups artifacts by logical family while keeping runtime-specific facts separate. A shared family name does not promise equal latency, memory use, accuracy, language coverage, voices, or licensing.

The first candidates are:

- Whisper Base for local ASR through MLX or sherpa-onnx.
- Kokoro English for local TTS through MLX or sherpa-onnx.
- Qwen3 0.6B 4-bit for compact MLX cleanup.
- A sherpa-onnx English and Chinese punctuation model for portable cleanup.

Every downloadable file has a pinned repository revision, HTTPS URL, exact byte count, and SHA-256 digest. A catalog entry remains a non-selectable `candidate` until all of these admission gates pass:

1. The model family, backend, platform, architecture, languages, and voices are accurate.
2. Every file matches its declared byte count and SHA-256 digest.
3. The model and each selected voice have a reviewed license and attribution.
4. The packaged runtime loads the artifact without repository code or an external interpreter.
5. Peak memory, latency, real-time factor where applicable, and task-specific quality are measured on named hardware and operating-system versions.
6. A reviewer promotes the artifact only after compatibility, checksum, license, and benchmark records are complete.

Run `bun run speech:catalog` during development to validate the manifest and list blocked candidates. The same command accepts an explicit packaged-worker path and bounded sample set once workers are available. It prints measurements for CodeInOven's lifecycle evidence; it does not silently rewrite the reviewed catalog.

## Recording and storage

Recording begins and ends only through the microphone control unless permission is revoked, the capture device disappears, the application shuts down, storage fails, or disk space becomes insufficient. There is no duration cutoff.

Media chunks are fixed-size and backpressured. Main writes them into a staging file beneath the CodeInOven configuration directory, finalizes that file atomically, and records an opaque audio ID. Audio, transcripts, model state, history, and learned rules never go into the user's repository.

Speech history defaults to 30 attempts and can be set from 1 through 500. Every permission, capture, ASR, cleanup, cancellation, success, and failure outcome belongs to its original attempt. Retries append results without duplicating retained audio. After a new history index is committed, oldest-first eviction removes the evicted attempt's app-owned audio. Explicit deletion always requires confirmation.

Unlimited recording can still consume substantial disk space. The Sound page reports duration and byte use. Low-disk detection stops capture with a visible failed attempt rather than risking broader application storage.

## Dictation and clipboard

Every agent-directed editor receives the same microphone control immediately before its send or submit action. Clicking once starts capture; clicking again stops it. Distinct cues mark active capture, successful stop, and finalized transcription.

The controller snapshots the editor and its selection before the microphone button moves focus. Final text replaces that selected range or inserts at the saved caret without overwriting adjacent text. If the target disappears or changes, CodeInOven keeps the transcript in history and the operating-system clipboard but does not insert it into an unrelated editor.

Writing finalized dictation replaces the current operating-system clipboard contents. This is intentional so supported operating systems can include the transcript in clipboard history.

## Cleanup and privacy

Local cleanup is enabled by default. It applies the selected punctuation or formatting model and enabled correction rules. If local cleanup fails, CodeInOven inserts the raw transcript, records the error, and does not switch backend or contact a remote model.

Remote cleanup is a separate `Switch` that defaults off. Enabling it requires an explicit fixed model or the current conversation model. Only transcript text and minimal formatting context may leave the machine: view kind, project or thread labels, active branch, and the bounded glossary or rules. Audio bytes, source files, full conversation history, and unrelated project content are excluded.

## Correction learning

Learning compares the inserted dictation span with the text the user actually sends. It derives conservative vocabulary substitutions and formatting transformations; it never fine-tunes or changes model weights.

Rules may be global, project-specific, or Inbox/chat-specific. Clear spelling and formatting corrections may activate after one high-confidence observation. Broader patterns require repeated evidence. Every rule is visible, can be disabled and re-enabled, and can be deleted after confirmation.

Storage is capped at 500 global rules and 200 rules for each project or Inbox/chat context. When a scope is full, disabled or lowest-confidence rules with the oldest reinforcement are evicted first.

## Spoken responses

Completed agent responses expose one speaker control beside copy and fork. Only one playback session exists at a time. Starting another response stops the current session.

Markdown normalization preserves reading order. Headings, paragraphs, and list items are spoken naturally. Link labels are followed by the word “link”; raw destinations are omitted. Fenced code blocks are skipped unless the user enables code reading in Sound settings.

Long responses are split at heading and sentence boundaries. The speech service retains only the playing segment and one prepared segment, which starts playback after the first segment is ready rather than waiting for the full response.

## Accessibility and controls

Microphone, download, retry, deletion, and playback controls keep stable dimensions. Every icon-only button has an action-specific `title` and `aria-label`, which also integrates with the shared tooltip host. Essential controls remain keyboard-visible and are never hover-only.

Every destructive action uses the shared confirmation modal. The modal focuses its first input, or the primary confirmation button when no input exists. Cancel and Escape leave data unchanged.

## Troubleshooting

- **Microphone unavailable:** Check the operating-system permission and the active capture device. CodeInOven grants media capture only to its trusted renderer; browser and remote origins do not inherit it.
- **Model cannot be selected:** The artifact may be missing, corrupt, incompatible with the active runtime, or still awaiting qualification.
- **Checksum mismatch:** Retry the download. Staging bytes are discarded and never become selectable.
- **Cleanup failed:** The raw transcript is retained and inserted. Details remain on the original history attempt.
- **Speech does not start offline:** Confirm that a compatible qualified model and packaged runtime are installed. No cloud fallback is attempted.
- **Imported model moved:** Imported folders remain user-owned references. Restore the folder or choose it again; removing the registration does not delete external files.

## Release qualification status

The shipped catalog intentionally keeps every initial artifact at `candidate` until real benchmark hardware, checksum, compatibility, and license review promote it. Candidate models cannot be downloaded or selected. The Apple Silicon MLX default additionally requires a signed packaged worker resource. A release must not claim local speech readiness until those catalog records are qualified, the MLX worker is installed at the packaged resource path, and the packaged verification commands pass. These gates fail closed and never enable sherpa or a remote provider silently.

The Sound page persists the default-off remote-cleanup consent and model-source choice, but provider invocation remains a release gate: no remote request is made until the dedicated minimal-payload auxiliary model adapter is connected and verified. Local cleanup failure continues to return raw text without networking.
