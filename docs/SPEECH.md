# Local speech

CodeInOven treats speech as an app-owned local subsystem. The renderer captures audio, but it does not run inference, read model files, or receive absolute paths from the application data directory. Typed IPC connects the renderer to bounded main-process services and packaged workers.

## Runtime policy

The recommended runtime is platform-specific:

| Platform | Architecture  | Recommended runtime |
| -------- | ------------- | ------------------- |
| macOS    | Apple Silicon | MLX                 |
| Windows  | x64           | sherpa-onnx         |
| Linux    | x64 or arm64  | sherpa-onnx         |

The macOS package targets Apple Silicon. Intel macOS is not a supported target.

A user may override the recommendation with another installed, compatible runtime. An unavailable override fails with a compatibility error; CodeInOven never changes runtime, model, or network path silently after a failure.

Runtime executables and native libraries ship inside the application. The packaged feature never resolves a speech worker from `PATH` and never requires Bun, Python, or an interactive shell. Model weights are separate downloads and never belong in the application bundle.

Chromium's MediaRecorder output is decoded to mono 16 kHz WAV by the pinned packaged `ffmpeg-static` executable inside the sherpa worker thread before ASR. Decoding never runs on the renderer or Electron main event loop, and its temporary WAV is removed after inference.

## Model catalog and admission

`resources/speech/model-catalog.json` groups artifacts by logical family while keeping runtime-specific facts separate. A shared family name does not promise equal latency, memory use, accuracy, language coverage, voices, or licensing.

The initial families are:

- Parakeet TDT 0.6B v2 (English-optimized) and v3 (multilingual) for local ASR through sherpa-onnx — ranked first in the ASR tab, with **Best for English** (v2) and **Best for Multilingual** (v3) badges.
- Whisper Base for local ASR through MLX or sherpa-onnx — ranked after Parakeet, with platform badges and Hugging Face links.
- Kokoro English for local TTS through MLX or sherpa-onnx — shown in the TTS tab with **MLX / ONNX** runtime badges and Hugging Face links.
- Qwen3 1.7B and 0.6B official GGUF Q8_0 quantizations for local **instruct** cleanup and lesson learning. These run through a llama.cpp `llama-server` process that is either discovered on the machine or downloaded at the user's request; see the llama.cpp runtime section below.

### llama.cpp runtime (discover or download)

Transcript cleanup and lesson learning require a real instruction-following model, so CodeInOven never bundles an inference runtime. Instead it mirrors the CUA-driver model:

1. **Discovery first.** At startup the speech service scans `$CODEINOVEN_LLAMA_SERVER_PATH`, the canonical `~/.local/bin` location, Homebrew prefixes, and every `PATH` directory for a `llama-server` binary and probes its version. An existing install is reused transparently and preferred when it matches the pinned release line.
2. **Consented download.** If nothing is found, Sound → Models shows a download action stating exactly what will be fetched: the pinned prebuilt CPU release of llama.cpp (`b10644`), its size, and that it will be installed into the CodeInOven configuration directory (`speech/runtime/llama-b10644`). The archive's SHA-256 is verified against a pinned digest before extraction; partial installs are impossible.
3. **Serving.** Cleanup inference runs in a locally spawned `llama-server` bound to `127.0.0.1` on an ephemeral port. The same resident-process policy applies as for ASR/TTS: instant reuse while active, unloaded after the configured idle delay.

Downloads are per-platform: macOS arm64/x64, Ubuntu arm64/x64, and Windows x64/arm64 CPU builds from the official ggml-org release assets.

Every downloadable file has a pinned repository revision, HTTPS URL, exact byte count, and SHA-256 digest. A catalog entry remains a non-selectable `candidate` until all of these admission gates pass:

1. The model family, backend, platform, architecture, languages, and voices are accurate.
2. Every file matches its declared byte count and SHA-256 digest.
3. The model and each selected voice have a reviewed license and attribution.
4. The packaged runtime loads the artifact without repository code or an external interpreter.
5. Peak memory, latency, real-time factor where applicable, and task-specific quality are measured on named hardware and operating-system versions.
6. A reviewer promotes the artifact only after compatibility, checksum, license, and benchmark records are complete.

Run `bun run speech:catalog` during development to validate the manifest and list blocked candidates. The same command accepts an explicit packaged-worker path and bounded sample set once workers are available. It prints measurements for CodeInOven's lifecycle evidence; it does not silently rewrite the reviewed catalog.

### User model import

Sound → **Models** is a tabbed surface with three sub-tabs — **ASR**, **TTS**, and **LLM** (cleanup) — each showing its artifacts as individual cards in a fixed-height, internally scrollable container (`max-h-[520px] overflow-y-auto`). Cards are ranked: Parakeet TDT v2 (**Best for English**) then v3 (**Best for Multilingual**) first in ASR, followed by Whisper variants; Kokoro variants in TTS; Qwen MLX then sherpa punctuation in LLM. Each card shows a **runtime badge** (MLX / ONNX / GGUF), a ranking/best-for badge where applicable, size, license, qualification, languages, and a **Hugging Face link** (`sourcePageUrl`). Each card has its **own Import and Paste Path buttons** (in addition to per-sub-tab header buttons), so the user can paste and import directly from any card; a fixed-height scroll keeps the section bounded. Users can import their own models by pointing at a local folder or file via **Import** (native file picker) or **Paste Path** (paste a filesystem path). Both actions share the same validation and registration path. Import registers a **user-owned external reference** only — CodeInOven never copies or deletes the referenced files. A `.mlx` model is registered to the MLX runtime and is gated to Apple Silicon; a `.gguf` model is registered to the GGUF/llama.cpp runtime (either a single `.gguf` file or a folder containing `.gguf` files); anything else is rejected with an unsupported-format error. Unregistering an imported model removes the reference only and never touches the external files on disk. Imported models appear under an “Imported models” group within the Models tab.

Pasting a path opens **Paste model path** — a modal with a focused input that validates live on paste and on edit. The modal trims surrounding whitespace and matching outer quotes before validation and shows when normalization occurred. Validation runs in the main process (filesystem access never leaves the renderer) and is debounced to avoid blocking the UI. The modal shows:

- **Supported model found** (with detected type: MLX or GGUF) — Import enabled.
- **Empty** — guidance with supported formats.
- **Not found** — no file or folder exists at that path.
- **Permission denied** — the path cannot be read.
- **Unsupported format / platform** — wrong extension, directory vs file mismatch (e.g. a `.gguf` directory), or MLX on non-Apple Silicon.

Import remains disabled until validation passes. The modal is fully keyboard-accessible: focus lands on the input when opened, **Escape** closes it, **Enter** imports when valid, and tab order is trapped by the shared modal behavior. No network download is performed from the paste flow; it only validates and registers a local path.

Pasting also shows a **detected model breakup** directly from the filesystem path: the modal parses the basename (e.g. `parakeet-tdt-0.6b-v2`) into family/variant/size/version/quantization and displays a structured preview with confidence, detail chips, and raw token breakup. This preview is live on edit (debounced main validation) and also appears for imported models in the **Imported models** list. The parse is heuristic and never blocks validation. See `src/lib/speech/model-path-validation.ts` (`parseModelIdentityFromPath`) and `docs/SPEECH.md`.

### Active model and single-resident policy

Each capability — **ASR**, **TTS**, and **LLM (cleanup)** — has at most **one active model** at a time (`sound.asrArtifactId`, `sound.ttsArtifactId`, `sound.cleanupArtifactId` in `src/lib/speech/types.ts`). The Sound → Models header shows the current active for the selected sub-tab (e.g. “Active for ASR: Parakeet TDT 0.6B v2 — only this model stays resident”) and a **Clear** action; when no active is set the UI explains that the first qualified installed model is used. Each catalog card that is installed shows **Set Active** (which displaces the previous active for that capability) or an **Active** badge and highlight when it is the active model; imported models show the same parsed identity breakup and an **Active** toggle per capability. Activating a model for a capability implicitly displaces the previous one — only the active model is considered resident in memory — and the selection is persisted in app config (`src/main/ipc/ipc-handlers.ts`). Catalog and imported models share the same activation path; imported models are validated contextually per tab (`src/main/speech/speech-service.ts:validateModelPath`) and registered with their capability (`speech:importModel`).

IPC: `speech:validateModelPath` (main-process filesystem validation, returns `ModelPathValidationResult`) and `speech:importModel` (shared registration for both picker and paste, now `speech:importModel(path, capability)`). See `src/lib/speech/model-path-validation.ts` for the shared normalization and extension allowlist, and `src/main/speech/speech-service.ts` for the main-process validation and registration logic.

### History retention

Speech history defaults to 30 attempts (1–500) and evicts oldest-first at the configured limit, removing the evicted attempt's app-owned audio. Every attempt — success or failure — records the audio plus its raw transcript and cleaned transcript; retries append results without duplicating retained audio. Explicit deletion always requires confirmation.

Apple Silicon packages build the pinned Swift worker with `bun run speech:build-mlx`. Packaging copies that executable and the checksum-verified MLX Metal library into the application resources; model weights remain separate downloads. Whisper Base and Kokoro BF16 are qualified on an Apple M1 Pro with the exact measurements recorded in the catalog. Kokoro's verified English G2P resources are part of its downloadable artifact so first synthesis does not perform a hidden network fetch.

## Recording and storage

Recording begins and ends only through the microphone control unless permission is revoked, the capture device disappears, the application shuts down, storage fails, or disk space becomes insufficient. There is no duration cutoff.

Media chunks are fixed-size and backpressured. Main writes them into a staging file beneath the CodeInOven configuration directory, finalizes that file atomically, and records an opaque audio ID. Audio, transcripts, model state, history, and learned rules never go into the user's repository.

Speech history defaults to 30 attempts and can be set from 1 through 500. Every permission, capture, ASR, cleanup, cancellation, success, and failure outcome belongs to its original attempt. Retries append results without duplicating retained audio. After a new history index is committed, oldest-first eviction removes the evicted attempt's app-owned audio. Explicit deletion always requires confirmation.

Unlimited recording can still consume substantial disk space. The Sound page reports duration and byte use. Low-disk detection stops capture with a visible failed attempt rather than risking broader application storage.

## Dictation and clipboard

Every agent-directed editor receives the same microphone control immediately before its send or submit action. The control is a slim `h-8 w-8` icon button that matches the send button: its `Mic` SVG turns filled red and pulses while capturing, shows a small animated waveform while the recording is being processed, and returns to the plain `Mic` when idle. There is no recording-duration display. Clicking once starts capture; clicking again stops it. Distinct cues mark active capture, successful stop, and finalized transcription.

In the chat composer the mic swaps into the send-button slot whenever nothing is sendable (idle and empty), and sits beside the send button when there is content to send. Other agent-directed editors keep the mic before their send/submit action.

The controller snapshots the editor and its selection before the microphone button moves focus. Final text replaces that selected range or inserts at the saved caret without overwriting adjacent text. If the target disappears or changes, CodeInOven keeps the transcript in history and the operating-system clipboard but does not insert it into an unrelated editor.

Writing finalized dictation replaces the current operating-system clipboard contents. This is intentional so supported operating systems can include the transcript in clipboard history.

### Voice recording without a local model

The mic is hidden on machines with no installed local speech-to-text model unless the user explicitly enables **Enable voice recording** in the Sound page. This toggle is OFF by default and is the only exception that allows audio bytes to leave the device: when ON and no local ASR is installed, a finished recording is sent as an audio attachment to an audio-capable conversation model (a disposable, tool-free session) for transcription, and the resulting transcript then flows through cleanup as usual. When a local ASR model is installed it remains the preferred path. Audio never leaves the device while this toggle is OFF.

## Cleanup and privacy

Local cleanup is enabled by default. It sends the transcript, together with the user's enabled learned lessons for the current scope, to the local instruct cleanup model served by llama-server. The model itself applies punctuation, formatting, and the style lessons — there is no rule or pattern-matching layer. If no cleanup model is installed (or the runtime is unavailable), CodeInOven inserts the raw transcript unchanged, records `modelMissing` in the attempt provenance, and the Sound → Models page shows a prominent download call-to-action. Cleanup failure never switches backend or contacts a remote model.

Remote cleanup is a separate `Switch` that defaults off. Enabling it requires an explicit fixed model or the current conversation model. Only transcript text and minimal formatting context may leave the machine: view kind, project or thread labels, active branch, and the bounded lesson set scoped to the current mode. Audio bytes, source files, full conversation history, and unrelated project content are excluded.

The former separate "Local-LLM base URL" preference was removed: the discover-or-download llama.cpp runtime described above is the local LLM path.

## Model memory

Speech models are kept resident so later use is instant, and are unloaded after a per-subsystem idle delay. Each subsystem (speech-to-text, cleanup LLM, text-to-speech) exposes an unload option of `30 minutes`, `1 hour`, or `keep until the application closes`. The defaults are 30 minutes. Unloading runs as part of application-close cleanup and is scheduled with batched, non-blocking timers so it never stalls the main thread.

## Lesson learning

When the user edits a dictation before sending it, CodeInOven compares the inserted transcript with the sent text. Whitespace-only differences are ignored. For a real edit, the local instruct cleanup model receives both texts and distills what changed — vocabulary substitutions, punctuation habits, phrasing rewrites, formatting or stylistic transforms — into **structured lessons**: a short imperative instruction plus concrete example pairs. This is deliberately not regex substitution and never fine-tunes model weights.

Lessons are bucketed per mode: lessons learned while dictating inside a project apply only in that project's views, lessons learned in chat/inbox apply across chats, and the store also allows a global layer for universal habits (caps: 500 global, 200 per context; disabled/lowest-confidence/oldest-reinforced lessons are evicted first). Reinforcing an existing lesson raises its confidence toward 0.99.

Every lesson is visible in Sound → Learning with kind, scope, confidence, evidence count, and examples. Lessons can be toggled per-lesson and deleted after confirmation.

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

The Apple Silicon Whisper and Kokoro artifacts are qualified and selectable after their verified downloads complete. Portable sherpa artifacts and standalone cleanup-model candidates remain blocked until their own platform-specific gates pass; a shared family name never inherits another backend's results. Package and release commands rebuild the pinned MLX worker, and packaged verification rejects missing runtime resources or bundled model weights. These gates fail closed and never enable sherpa or a remote provider silently.

The Sound page persists the default-off remote-cleanup consent and model-source choice. When enabled for an active conversation, cleanup runs in a disposable, tool-free session using either that conversation's model or an explicitly entered model ID on the same harness and provider. Its request contains only the transcript; it does not include audio, attachments, source files, or conversation history. Local or remote cleanup failure continues to return the raw transcript without switching paths.
