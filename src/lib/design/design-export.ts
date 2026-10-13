export const DESIGN_EXPORT_FORMATS = ['html', 'pdf', 'zip', 'markdown'] as const
export type DesignExportFormat = (typeof DESIGN_EXPORT_FORMATS)[number]
export interface DesignExportResult {
  directory: string
  files: string[]
}
