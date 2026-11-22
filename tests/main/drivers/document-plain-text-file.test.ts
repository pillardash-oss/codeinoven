import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import JSZip from 'jszip'
import { readDocumentPlainTextFile } from '../../../src/main/drivers/document-attachment-core'

/**
 * The Sound Playground's read-aloud import reads a user-picked file through this
 * helper: rich documents come back as speakable prose, and formats with no local
 * text layer are refused by name instead of being read as bytes.
 */
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cio-doc-plain-text-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A minimal but valid DOCX package: content types, the package relationship,
 *  and one body part carrying a heading and a paragraph. */
async function writeDocx(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  )
  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  )
  zip.folder('word')?.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>**Chapter One**</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">The lantern burned [steadily](https://example.com).</w:t></w:r></w:p>
</w:body></w:document>`
  )
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
}

describe('readDocumentPlainTextFile', () => {
  it('returns cleaned prose for a supported document', async () => {
    const path = join(root, 'chapter.docx')
    await writeDocx(path)

    const result = await readDocumentPlainTextFile(path)

    expect(result).not.toBeNull()
    expect(result?.truncated).toBe(false)
    expect(result?.text).toContain('Chapter One')
    expect(result?.text).toContain('The lantern burned steadily.')
    // Markup syntax never reaches the voice.
    expect(result?.text).not.toContain('**')
    expect(result?.text).not.toContain('](')
    expect(result?.text).not.toContain('#')
  })

  it('reports truncation instead of returning more than the budget', async () => {
    const path = join(root, 'long.docx')
    await writeDocx(path)

    const result = await readDocumentPlainTextFile(path, 12)

    expect(result?.truncated).toBe(true)
    expect(result?.text).toHaveLength(12)
  })

  it('refuses a PDF by name instead of reading its bytes as text', async () => {
    const path = join(root, 'scan.pdf')
    // Binary payload that must never be handed to the voice.
    await writeFile(path, Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'))

    await expect(readDocumentPlainTextFile(path)).rejects.toThrow(
      /Read-aloud does not support PDF files/u
    )
  })

  it('refuses EPUB and RTF by name too', async () => {
    for (const extension of ['epub', 'rtf']) {
      const path = join(root, `book.${extension}`)
      await writeFile(path, Buffer.from('not prose'))
      await expect(readDocumentPlainTextFile(path)).rejects.toThrow(
        new RegExp(`Read-aloud does not support ${extension.toUpperCase()} files`, 'u')
      )
    }
  })

  it('rejects an extension the pipeline does not handle', async () => {
    const path = join(root, 'archive.zip')
    await writeFile(path, Buffer.from('PK\u0003\u0004'))

    await expect(readDocumentPlainTextFile(path)).rejects.toThrow(/Unsupported file type "\.zip"/u)
  })
})
