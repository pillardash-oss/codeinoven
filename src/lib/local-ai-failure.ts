/**
 * Why an MLX server stopped being able to serve, read from its own output.
 *
 * `mlx_lm.server` loads the model inside the thread that generates answers, and
 * that thread catching an exception is the end of the server's usefulness: it
 * keeps the port, answers `/health` with 503 forever, and says nothing else. The
 * only place the reason exists is the one line it logs, so this module owns the
 * reading of it, apart from the page, where a test can exercise the real engine's
 * output instead of a guess at its wording.
 *
 * Kept out of the controller because the controller talks to the page's IPC; the
 * line itself is plain text.
 */

/**
 * The engine's own message when its generation thread dies.
 *
 * The line as written (telemetry prefix included):
 * `2026-11-15 19:00:26,598 - ERROR - mlx_lm.server generation thread died: Model
 * type lfm3_omni not supported.`
 */
const GENERATION_FAILURE = /mlx_lm\.server generation thread died: (?<reason>.+)$/u

/** The reason the generation thread died, or null when this is any other line. */
export function generationFailureReason(line: string): string | null {
  const reason = GENERATION_FAILURE.exec(line)?.groups?.['reason']?.trim() ?? ''
  return reason.length > 0 ? reason : null
}

/**
 * A failed load, in words the card can show.
 *
 * The engine reports an architecture it cannot build as a dead thread, so the
 * bare reason reads like a crash. The weights are still MLX, and the runtime that
 * implements this family is `mlx-vlm`, so that is what the card names: pointing at
 * a GGUF conversion would be advice for a different checkpoint.
 */
export function describeGenerationFailure(reason: string): string {
  // Metal reports a working-set overrun as a command buffer failure, which reads
  // like a crash but is memory: the weights plus the prompt cache's KV tensors no
  // longer fit in unified RAM. The cache is unbounded unless the server is told
  // otherwise, so that is the lever to name.
  if (/Insufficient Memory|OutOfMemory/iu.test(reason)) {
    return `${reason} This is memory, not a crash: the model weights plus the server's prompt cache no longer fit this Mac's unified memory. Add --prompt-cache-bytes 1000000000 (or --kv-bits 4) to this server's extra flags, or stop another local model, then start it again.`
  }
  if (!/^Model type \S+ not supported\.?$/u.test(reason)) return reason
  return `${reason} This mlx-lm build has no architecture for that model: omni and vision MLX models are served by mlx-vlm, not mlx-lm. Its weights are already on disk.`
}
