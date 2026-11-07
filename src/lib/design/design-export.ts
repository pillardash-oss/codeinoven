export const DESIGN_EXPORT_FORMATS = ['html', 'pdf', 'zip', 'markdown'] as const
export type DesignExportFormat = (typeof DESIGN_EXPORT_FORMATS)[number]
export interface DesignExportResult {
  /** The folder the export wrote, relative to `root`. */
  directory: string
  /** The files the export wrote, relative to `directory`. */
  files: string[]
  /**
   * The absolute root the two paths above are relative to: the exporting
   * conversation's own workspace for an assistant, chat or browser thread, and
   * the project checkout otherwise. Revealing the export needs it because a
   * conversation's paths do not resolve against the project root.
   */
  root: string
}
