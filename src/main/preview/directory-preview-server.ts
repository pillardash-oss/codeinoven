import { createReadStream } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { APP_NAME } from '../../lib/brand'
import { mimeTypeForPath } from '../../lib/mime-types'
import { Logger } from '../system/logger'

/**
 * Loopback static file server whose origin root **is** the directory being
 * previewed.
 *
 * Why one server (and one port) per directory instead of a path prefix on a
 * shared server: a prefix breaks every root-absolute reference a page makes
 * (`/assets/app.css`, `/data.json`, `fetch('/api')`), and resolving those
 * against the origin root is exactly what a static site expects. Serving the
 * directory at `/` keeps both relative and absolute references working, which
 * is the whole point of the feature.
 *
 * The server is a deliberately plain static host: it renders a clickable
 * listing for every directory, streams any file with its real media type, and
 * sets no Content-Security-Policy, because running the previewed page's own
 * scripts and stylesheets is the feature.
 */

/** Upper bound on rendered listing rows; larger directories list names only. */
const MAX_LISTING_ENTRIES = 2_000
/** Concurrent `stat` calls while decorating a listing, kept small on purpose. */
const LISTING_STAT_CONCURRENCY = 48
const STREAM_HIGH_WATER_MARK = 256 * 1024
const MAX_RANGE_HEADER_LENGTH = 128

export interface DirectoryPreviewEndpoint {
  /** Origin URL to open in a browser (`http://127.0.0.1:<port>/`). */
  url: string
  port: number
}

interface ListingEntry {
  name: string
  href: string
  isDirectory: boolean
  isIndex: boolean
  size: number | null
  modifiedAt: number | null
}

interface DirectoryListing {
  entries: ListingEntry[]
  truncated: boolean
}

interface ListingOptions {
  root: string
  directory: string
  relativePath: string
  listing: DirectoryListing
  timeFormatter: Intl.DateTimeFormat
}

function inside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  )
}

/** Decode a URL pathname into path segments, or null when it is malformed. */
function decodePathSegments(pathname: string): string[] | null {
  const segments: string[] = []
  for (const raw of pathname.split('/')) {
    if (raw === '') continue
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (segment.includes('\0')) return null
    segments.push(segment)
  }
  return segments
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1_000) return `${bytes} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1_000
  let unitIndex = 0
  while (value >= 1_000 && unitIndex < units.length - 1) {
    value /= 1_000
    unitIndex += 1
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unitIndex]}`
}

function sendText(response: ServerResponse, status: number, message: string, method: string): void {
  const body = Buffer.from(`${message}\n`, 'utf8')
  response.statusCode = status
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.setHeader('Content-Length', String(body.length))
  if (method === 'HEAD') response.end()
  else response.end(body)
}

function sendNotFound(response: ServerResponse, method: string): void {
  sendText(response, 404, 'Not found', method)
}

/**
 * Parse a single-range `Range` header. Returns null when the request is not a
 * range request, `'invalid'` when it is unsatisfiable, and the resolved bounds
 * otherwise. Multi-range requests are answered with the full body.
 */
function parseRangeHeader(
  header: string | undefined,
  size: number
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  if (header.length > MAX_RANGE_HEADER_LENGTH) return 'invalid'
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (!match) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return 'invalid'
  if (size === 0) return 'invalid'
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  if (start >= size) return 'invalid'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return 'invalid'
  return { start, end }
}

function isIndexDocument(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'index.html' || lower === 'index.htm'
}

function compareEntries(
  left: { name: string; isDirectory: boolean },
  right: { name: string; isDirectory: boolean }
): number {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Read one directory into listing rows. Entries come from `readdir` with
 * `withFileTypes`; size and modification time are added by bounded batches of
 * `stat` calls so a directory with thousands of entries never queues
 * thousands of filesystem operations at once, and directories beyond the
 * listing cap list names only.
 */
async function readDirectoryListing(directory: string): Promise<DirectoryListing> {
  const dirents = await readdir(directory, { withFileTypes: true })
  const summarized = dirents
    .filter((dirent) => dirent.name !== '.DS_Store')
    .map((dirent) => ({ name: dirent.name, isDirectory: dirent.isDirectory() }))
  summarized.sort(compareEntries)
  const truncated = summarized.length > MAX_LISTING_ENTRIES
  const visible = truncated ? summarized.slice(0, MAX_LISTING_ENTRIES) : summarized
  const entries: ListingEntry[] = visible.map((entry) => ({
    name: entry.name,
    href: `${encodeURIComponent(entry.name)}${entry.isDirectory ? '/' : ''}`,
    isDirectory: entry.isDirectory,
    isIndex: !entry.isDirectory && isIndexDocument(entry.name),
    size: null,
    modifiedAt: null
  }))
  if (!truncated) {
    for (let index = 0; index < entries.length; index += LISTING_STAT_CONCURRENCY) {
      const batch = entries.slice(index, index + LISTING_STAT_CONCURRENCY)
      await Promise.all(
        batch.map(async (entry) => {
          // A symlink reports as neither file nor directory from `readdir`, so
          // the metadata check below is what classifies it; containment is
          // re-verified by the request handler on every read.
          const metadata = await stat(resolve(directory, entry.name)).catch(() => null)
          if (!metadata) return
          entry.isDirectory = metadata.isDirectory()
          entry.href = `${encodeURIComponent(entry.name)}${entry.isDirectory ? '/' : ''}`
          entry.size = metadata.isFile() ? metadata.size : null
          entry.modifiedAt = metadata.mtimeMs
        })
      )
    }
    entries.sort(compareEntries)
  }
  return { entries, truncated }
}

/** Breadcrumb segments from the served root down to the current directory. */
function crumbsFor(root: string, relativePath: string): { label: string; href: string }[] {
  const crumbs = [{ label: basename(root) || root, href: './' }]
  let href = './'
  for (const segment of relativePath.split('/').filter(Boolean)) {
    href += `${encodeURIComponent(segment)}/`
    crumbs.push({ label: segment, href })
  }
  return crumbs
}

function renderRow(entry: ListingEntry, timeFormatter: Intl.DateTimeFormat): string {
  const icon = entry.isDirectory ? 'folder' : entry.isIndex ? 'index' : 'file'
  const badge = entry.isIndex ? '<span class="badge">Start here</span>' : ''
  const when = entry.modifiedAt === null ? '' : timeFormatter.format(new Date(entry.modifiedAt))
  return (
    `<li data-name="${escapeHtml(entry.name.toLowerCase())}">` +
    `<a class="row" href="${escapeHtml(entry.href)}">` +
    `<svg class="icon" aria-hidden="true"><use href="#i-${icon}"></use></svg>` +
    `<span class="name"><span class="label">${escapeHtml(entry.name)}` +
    `${entry.isDirectory ? '/' : ''}</span>${badge}</span>` +
    `<span class="size">${formatBytes(entry.size)}</span>` +
    `<time class="when">${escapeHtml(when)}</time>` +
    `</a></li>`
  )
}

function renderDirectoryListing(options: ListingOptions): string {
  const { entries, truncated } = options.listing
  const crumbs = crumbsFor(options.root, options.relativePath)
  const label = crumbs[crumbs.length - 1]?.label ?? options.relativePath
  const title = options.relativePath ? `${label} · Files` : `${basename(options.root)} · Files`
  const parentRow =
    options.relativePath === ''
      ? ''
      : '<li data-name=".."><a class="row parent" href="../">' +
        '<svg class="icon" aria-hidden="true"><use href="#i-up"></use></svg>' +
        '<span class="name"><span class="label">Parent directory</span></span></a></li>'
  const notice = truncated
    ? `<p class="notice">Showing the first ${MAX_LISTING_ENTRIES} entries. This directory has more; use the filter above or the file tree for the rest.</p>`
    : ''
  const breadcrumbs = crumbs
    .map((crumb, index) =>
      index === crumbs.length - 1
        ? `<span class="current">${escapeHtml(crumb.label)}</span>`
        : `<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a><span class="sep">/</span>`
    )
    .join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root{
  color-scheme:light dark;
  --bg:#f7f6f2;--surface:#fff;--border:#e2e0d9;--fg:#081825;--muted:#5d6b76;--dim:#8a949c;
  --hover:#f1efe9;--accent:#8a6d12;--badge-bg:rgb(212 175 55/.16);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#081825;--surface:#0c2233;--border:#17384f;--fg:#f2efe8;--muted:#9fb0bd;--dim:#6f8493;
  --hover:#112c40;--accent:#d4af37;--badge-bg:rgb(212 175 55/.18);}
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--fg);font-family:var(--font);font-size:.875rem;line-height:1.5;
  -webkit-font-smoothing:antialiased}
.wrap{width:100%;max-width:72rem;margin:0 auto}
header{position:sticky;top:0;z-index:2;background:var(--surface);border-bottom:1px solid var(--border);
  padding:.75rem 1rem .7rem}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem;font-size:.8125rem;min-height:1.25rem}
.crumbs a{color:var(--muted);text-decoration:none;border-radius:.25rem;padding:.05rem .3rem}
.crumbs a:hover{background:var(--hover);color:var(--fg)}
.crumbs .sep{color:var(--dim)}
.crumbs .current{color:var(--fg);font-weight:600;padding:.05rem .3rem}
.root{margin:.4rem 0 0;font-family:var(--mono);font-size:.6875rem;color:var(--dim);
  overflow-wrap:anywhere}
.tools{display:flex;align-items:center;gap:.6rem;margin-top:.6rem}
.tools input{flex:1 1 auto;min-width:8rem;max-width:26rem;height:1.75rem;padding:0 .5rem;
  border:1px solid var(--border);border-radius:.375rem;background:var(--bg);color:var(--fg);
  font-family:var(--font);font-size:.8125rem}
.tools input:focus{outline:none;border-color:var(--accent)}
.count{font-size:.6875rem;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap}
main{padding:.5rem 1rem 1.5rem}
ul.rows{list-style:none;margin:0;padding:0}
.row{display:grid;grid-template-columns:1rem minmax(0,1fr) 4.5rem 9rem;align-items:center;
  gap:.75rem;padding:.3rem .4rem;border-radius:.375rem;color:var(--fg);text-decoration:none}
.row:hover{background:var(--hover)}
.row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.row.parent{grid-template-columns:1rem minmax(0,1fr);color:var(--muted);margin-bottom:.3rem}
.icon{width:.9375rem;height:.9375rem;fill:none;stroke:var(--dim);stroke-width:1.6;
  stroke-linecap:round;stroke-linejoin:round}
.row.parent .icon{stroke:var(--muted)}
li[data-name$=".html"] .icon,li[data-name$=".htm"] .icon{stroke:var(--accent)}
.name{display:flex;align-items:center;gap:.5rem;min-width:0}
.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.row.parent .label{font-weight:400}
.badge{flex:0 0 auto;font-size:.625rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;
  color:var(--accent);background:var(--badge-bg);border-radius:999px;padding:.05rem .4rem}
.size,.when{font-size:.6875rem;color:var(--dim);font-variant-numeric:tabular-nums;text-align:right;
  white-space:nowrap}
.notice{margin:1rem 0 0;font-size:.8125rem;color:var(--muted)}
.empty{margin:1.5rem 0 0;font-size:.8125rem;color:var(--muted)}
.empty[hidden]{display:none}
footer{padding:0 1rem 2rem;font-size:.6875rem;color:var(--dim)}
@media (max-width:40rem){
  .row{grid-template-columns:1rem minmax(0,1fr)}
  .row .size,.row .when{display:none}
}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">${breadcrumbs}</nav>
    <p class="root">${escapeHtml(options.directory)}</p>
    <div class="tools">
      <input id="filter" type="search" placeholder="Filter names ( / )" autocomplete="off"
        spellcheck="false" aria-label="Filter file names" />
      <span class="count" id="count">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span>
    </div>
  </div>
</header>
<main>
  <div class="wrap">
    <ul class="rows" id="rows">${parentRow}${entries
      .map((entry) => renderRow(entry, options.timeFormatter))
      .join('')}</ul>
    <p class="empty" id="empty" hidden>No names match this filter.</p>
    ${notice}
  </div>
</main>
<footer><div class="wrap">${escapeHtml(APP_NAME)} · local directory preview · read-only view of this folder</div></footer>
<svg hidden aria-hidden="true">
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3.5 6.5a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.6.8l.9 1.2h7.3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></symbol>
  <symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3.5H7.5a1.5 1.5 0 0 0-1.5 1.5v14a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4"/></symbol>
  <symbol id="i-index" viewBox="0 0 24 24"><path d="M14 3.5H7.5a1.5 1.5 0 0 0-1.5 1.5v14a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4"/><path d="M10.6 17v-4.6l-1.3.8"/><path d="M12.4 14.6h2.4"/><path d="M17 13.4v3.6"/></symbol>
  <symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></symbol>
</svg>
<script>
(function () {
  var input = document.getElementById('filter')
  var rows = Array.prototype.slice.call(document.querySelectorAll('#rows li'))
  var count = document.getElementById('count')
  var empty = document.getElementById('empty')
  var totalText = count.textContent
  var scheduled = false
  function apply() {
    scheduled = false
    var query = input.value.trim().toLowerCase()
    var shown = 0
    for (var index = 0; index < rows.length; index++) {
      var row = rows[index]
      var match = query === '' || (row.dataset.name || '').indexOf(query) !== -1
      if (row.hidden === match) row.hidden = !match
      if (match) shown++
    }
    count.textContent = query === '' ? totalText : shown + ' of ' + totalText
    empty.hidden = shown > 0
  }
  input.addEventListener('input', function () {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(apply)
  })
  document.addEventListener('keydown', function (event) {
    if (event.key === '/' && document.activeElement !== input) {
      event.preventDefault()
      input.focus()
    }
    if (event.key === 'Escape' && document.activeElement === input) {
      input.value = ''
      apply()
    }
  })
})()
</script>
</body>
</html>
`
}

export class DirectoryPreviewServer {
  private root: string
  private server: Server | null = null
  private endpoint: DirectoryPreviewEndpoint | null = null
  private starting: Promise<DirectoryPreviewEndpoint> | null = null
  private disposed = false

  /** @param directory the directory to serve; canonicalized on `start()`. */
  constructor(directory: string) {
    this.root = directory
  }

  /** Canonical path of the served directory once the server has started. */
  get canonicalRoot(): string {
    return this.root
  }

  async start(): Promise<DirectoryPreviewEndpoint> {
    if (this.disposed) throw new Error('Directory preview server is closed')
    if (this.endpoint) return this.endpoint
    if (this.starting) return this.starting
    const starting = (async (): Promise<DirectoryPreviewEndpoint> => {
      // Canonicalize the root here rather than trusting the caller: every
      // containment check compares `realpath` results against this value, so a
      // symlinked root (macOS `/var` for one) would otherwise reject its own
      // files.
      this.root = await realpath(this.root)
      const server = createServer((request, response) => {
        void this.respond(request, response)
      })
      this.server = server
      try {
        await new Promise<void>((resolveListening, rejectListening) => {
          server.once('error', rejectListening)
          server.listen(0, '127.0.0.1', resolveListening)
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('Directory preview port unavailable')
        }
        this.endpoint = { url: `http://127.0.0.1:${address.port}/`, port: address.port }
        return this.endpoint
      } catch (error) {
        if (this.server === server) this.server = null
        server.close()
        throw error
      }
    })()
    this.starting = starting
    try {
      return await starting
    } finally {
      if (this.starting === starting) this.starting = null
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.starting?.catch(() => undefined)
    const server = this.server
    this.server = null
    this.endpoint = null
    if (!server) return
    await new Promise<void>((resolveClosed) => {
      // A browser tab holding a keep-alive connection would otherwise delay
      // `close()` for the connection's whole idle window.
      server.closeAllConnections()
      server.close(() => resolveClosed())
    })
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const head = request.method === 'HEAD'
    const method = head ? 'HEAD' : 'GET'
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      sendText(response, 405, 'Method not allowed', method)
      return
    }
    try {
      const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
      const segments = decodePathSegments(parsed.pathname)
      if (!segments) {
        sendText(response, 400, 'Malformed request path', method)
        return
      }
      const requested = resolve(this.root, ...segments)
      if (!inside(this.root, requested)) {
        sendNotFound(response, method)
        return
      }
      // Both the requested path and its fully resolved target must stay inside
      // the served directory, so a symlink cannot expose a sibling tree.
      const actual = await realpath(requested).catch(() => null)
      if (!actual || !inside(this.root, actual)) {
        sendNotFound(response, method)
        return
      }
      const metadata = await stat(actual).catch(() => null)
      if (!metadata) {
        sendNotFound(response, method)
        return
      }
      if (metadata.isDirectory()) {
        const relativePath = segments.join('/')
        if (!parsed.pathname.endsWith('/')) {
          // The Location header is rebuilt from the decoded segments, never
          // echoed from the request: an echoed `//host` path would be read as
          // a scheme-relative URL and redirect the tab off this origin.
          const normalizedPath = `/${segments.map(encodeURIComponent).join('/')}`
          response.statusCode = 302
          response.setHeader('Location', `${normalizedPath}/${parsed.search}`)
          response.setHeader('Content-Length', '0')
          response.end()
          return
        }
        const html = renderDirectoryListing({
          root: this.root,
          directory: actual,
          relativePath,
          listing: await readDirectoryListing(actual),
          timeFormatter: new Intl.DateTimeFormat(undefined, {
            dateStyle: 'short',
            timeStyle: 'short'
          })
        })
        const body = Buffer.from(html, 'utf8')
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Content-Length', String(body.length))
        if (head) response.end()
        else response.end(body)
        return
      }
      if (!metadata.isFile()) {
        sendNotFound(response, method)
        return
      }
      this.sendFile(request, response, actual, metadata.size, head)
    } catch (error) {
      Logger.error('Directory preview request failed:', error)
      if (response.headersSent) response.destroy()
      else sendText(response, 500, 'Directory preview failed', method)
    }
  }

  private sendFile(
    request: IncomingMessage,
    response: ServerResponse,
    filePath: string,
    size: number,
    head: boolean
  ): void {
    response.setHeader('Content-Type', mimeTypeForPath(filePath))
    response.setHeader('Accept-Ranges', 'bytes')
    const range = parseRangeHeader(request.headers.range, size)
    if (range === 'invalid') {
      response.statusCode = 416
      response.setHeader('Content-Range', `bytes */${size}`)
      response.setHeader('Content-Length', '0')
      response.end()
      return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    response.statusCode = range ? 206 : 200
    response.setHeader('Content-Length', String(size === 0 ? 0 : end - start + 1))
    if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    if (head || size === 0) {
      response.end()
      return
    }
    const stream = createReadStream(filePath, {
      start,
      end,
      highWaterMark: STREAM_HIGH_WATER_MARK
    })
    stream.on('error', (error) => {
      Logger.error('Directory preview stream failed:', error)
      response.destroy()
    })
    stream.pipe(response)
  }
}
