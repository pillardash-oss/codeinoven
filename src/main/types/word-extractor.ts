/** Ambient declarations for `word-extractor` (ships no TypeScript types). */
declare module 'word-extractor' {
  export interface WordDocument {
    /** Main body text of the document, paragraphs separated by line breaks. */
    getBody(options?: { filterUnicode?: boolean }): string
    getFootnotes(options?: { filterUnicode?: boolean }): string
    getEndnotes(options?: { filterUnicode?: boolean }): string
    getHeaders(options?: { filterUnicode?: boolean }): string
    getFooters(options?: { filterUnicode?: boolean }): string
    getAnnotations(options?: { filterUnicode?: boolean }): string
    getTextboxes(options?: { filterUnicode?: boolean }): string
  }

  export class WordExtractor {
    /** Extracts content from a `.doc` (OLE) or `.docx`/ODF zip source. */
    extract(source: string | Buffer): Promise<WordDocument>
  }

  export default WordExtractor
}
