import { app } from 'electron'
import { join } from 'node:path'

/**
 * Where the films the app ships are installed.
 *
 * Packaged, they sit beside the other shipped resources; from a checkout they are
 * read from `resources/`, which is the same tree `electron-builder.yml` copies.
 * One authority for the path, so the dev and packaged builds cannot disagree
 * about where a starter is.
 */
export function videoStartersRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'video-starters')
    : join(app.getAppPath(), 'resources', 'video-starters')
}
