import { join } from 'node:path'
import { appResourcesRoot } from '../bootstrap/app-resources'

/**
 * Where the films the app ships are installed.
 *
 * Packaged, they sit beside the other shipped resources; from a checkout they are
 * read from `resources/`, which is the same tree `electron-builder.yml` copies.
 * One authority for the path, so the dev and packaged builds cannot disagree
 * about where a starter is.
 */
export function videoStartersRoot(): string {
  return join(appResourcesRoot(), 'video-starters')
}
