import { probeVideo } from './video-inspection'

/** How far a clip may read past its recorded asset length before the recorded
 *  length is treated as stale. Matches the tolerance the editor's own
 *  validation allows, so refreshing can never reject what validation accepts. */
const SOURCE_SLACK = 0.1

/** Most assets one read will probe, so a hopeless document cannot turn into a
 *  burst of media processes on every open. */
const MAX_PROBES = 8

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Refresh the recorded length of any asset its clips read past.
 *
 * An asset's `duration` is metadata copied from the media when it was imported.
 * Replacing or re-encoding that file outside the editor leaves the number stale,
 * and validation then refuses the whole composition over a clip the file can play
 * perfectly well, with no way back into the editor. The file is the authority, so
 * the recorded length is refreshed from it before validation runs.
 *
 * Only extensions are applied: an asset is never shortened and no clip is moved,
 * so a document that is genuinely inconsistent still fails, now naming the asset
 * and the range it cannot read instead of a bare sentence.
 */
export async function refreshVideoEditAssetDurations(
  folder: string,
  raw: unknown,
  signal: AbortSignal
): Promise<void> {
  const edit = record(record(raw)?.edit)
  if (!edit) return
  const assets = Array.isArray(edit.assets) ? edit.assets : []
  const clips = Array.isArray(edit.clips) ? edit.clips : []
  const required = new Map<string, number>()
  for (const value of clips) {
    const clip = record(value)
    if (!clip) continue
    const assetId = typeof clip.assetId === 'string' ? clip.assetId : null
    const duration = finite(clip.duration)
    if (!assetId || duration === null) continue
    const need = (finite(clip.sourceStart) ?? 0) + duration * Math.max(finite(clip.speed) ?? 1, 0)
    required.set(assetId, Math.max(required.get(assetId) ?? 0, need))
  }
  if (required.size === 0) return
  let probes = 0
  for (const value of assets) {
    if (probes >= MAX_PROBES) return
    const asset = record(value)
    if (!asset) continue
    const assetId = typeof asset.id === 'string' ? asset.id : null
    const source = typeof asset.source === 'string' ? asset.source : null
    const recorded = finite(asset.duration) ?? 0
    const need = assetId ? required.get(assetId) : undefined
    if (!assetId || !source || need === undefined || need <= recorded + SOURCE_SLACK) continue
    probes += 1
    // A probe failure leaves the recorded length alone: the save path already
    // proves every asset file exists, and an unreadable file must not be turned
    // into a silently invented duration.
    const info = await probeVideo(folder, source, signal).catch(() => null)
    if (info?.duration && info.duration > recorded + SOURCE_SLACK) asset.duration = info.duration
  }
}
