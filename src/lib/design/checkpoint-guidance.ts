import type { AuthoredWorkKind } from '../ipc/design'

/** One checkpoint contract shared by the two authored-work playbooks. */
export function authoredWorkCheckpointGuidance(kind: AuthoredWorkKind): string {
  const subject = kind === 'design' ? 'screen' : 'composition'
  const steps =
    kind === 'design'
      ? 'hero section, title, image treatment, navbar or content section'
      : 'scene, title, caption, image treatment or transition'
  const examples =
    kind === 'design'
      ? '"Hero title updated", "Navbar finished"'
      : '"Opening scene completed", "Captions updated"'
  return `## Checkpoint each major step

Use operation \`checkpoint\` with \`directory\`, \`entry\` and a short user-facing \`label\`. Save a baseline before editing an existing ${subject}. Once the first ${subject} scaffold exists, checkpoint it; then checkpoint each completed ${steps} before starting the next step. Examples: ${examples}. Do not wait until the turn ends. Keep ${subject}-specific markup and visual styles with its entry, so screen undo can restore it independently. Save replacement images and other media under distinct filenames and retain assets referenced by earlier checkpoints, so restoring the screen also restores its old visual references. Unchanged content adds no duplicate step; when Git tracks the folder, the operation reports that Git owns its history. Never put these instructions or checkpoint labels into the authored page itself.`
}
