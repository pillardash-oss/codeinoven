'use strict'
/**
 * CodeInOven bundled-harness bridge for Electron `utilityProcess.fork`.
 *
 * Problem it solves: the app's helper harnesses (the bundled Pi runtime) are
 * pure JS modules executed under Electron via `ELECTRON_RUN_AS_NODE`. Spawning
 * `process.execPath` directly — even from inside a helper — registers a
 * standalone LaunchServices app on macOS, and macOS shows a bouncing
 * terminal-like Dock icon for each one.
 *
 * The Electron-standard fix: run the harness module **in-process** inside one
 * `utilityProcess` helper per invocation. Utility-process children are managed
 * by the app and never surface as separate apps/windows.
 *
 * Because the tooling runtime inside the helper executes `main()`-style CLI
 * entrypoints, this bridge installs virtual `process.stdin`/`process.stdout`/
 * `process.stderr` and intercepts `process.exit`, relaying raw chunks and the
 * final exit status back to the main process over postMessage.
 *
 * Message protocol (JSON-serializable payloads only, binary is base64):
 *   main -> child: { t: 'run', modulePath, argv?, cwd?, env? }
 *   main -> child: { t: 'stdin-data', b64 } | { t: 'stdin-end' }
 *   child -> main: { t: 'pid', pid }
 *   child -> main: { t: 'data', stream: 'out' | 'err', b64 }
 *   child -> main: { t: 'error', message }
 *   child -> main: { t: 'exit', code }
 */
const { Writable, Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')

function send(message) {
  process.parentPort.postMessage(message)
}

function chunkToBase64(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

function makeOutputStream(tag) {
  return new Writable({
    write(chunk, _encoding, callback) {
      send({ t: 'data', stream: tag, b64: chunkToBase64(chunk).toString('base64') })
      callback()
    },
    /**
     * Some harness output paths use `fs.write(1, ...)`-style raw descriptors or
     * the stream may be destroyed on abrupt exits; swallow user-space write
     * errors so a crashed module cannot crash the bridge before it reports exit.
     */
    destroy(error, callback) {
      callback()
    }
  })
}

function makeInputStream() {
  const input = new Readable({ read() {} })
  // The harness runtime must see a TTY-style "not interactive" terminal rather
  // than an eternally pending one; an immediate end would break stdin consumers
  // during startup, so the stream stays open until the main process ends it.
  return input
}

async function runHarnessModule(request) {
  if (typeof request.modulePath !== 'string' || request.modulePath.length === 0) {
    send({ t: 'error', message: 'Utility bridge start message is missing modulePath' })
    send({ t: 'exit', code: 1 })
    return
  }

  if (request.env && typeof request.env === 'object') {
    for (const [key, value] of Object.entries(request.env)) {
      if (typeof value === 'string') process.env[key] = value
    }
  }
  if (typeof request.cwd === 'string' && request.cwd.length > 0) {
    try {
      process.chdir(request.cwd)
    } catch {
      // A missing cwd does not invalidate the harness; the module handles a
      // failed project path itself.
    }
  }
  if (Array.isArray(request.argv) && request.argv.length > 0) {
    process.argv = request.argv.slice()
  }

  const rawExit = process.exit.bind(process)
  let exitCached = null
  const reportAndExit = (rawCode) => {
    if (exitCached === null) {
      exitCached = rawCode
      send({ t: 'exit', code: rawCode })
    }
    setImmediate(() => rawExit(rawCode))
  }
  process.exit = reportAndExit

  process.on('uncaughtException', (error) => {
    send({ t: 'error', message: error instanceof Error ? `${error.stack ?? error.message}` : String(error) })
    reportAndExit(1)
  })
  process.on('unhandledRejection', (error) => {
    send({ t: 'error', message: error instanceof Error ? `${error.stack ?? error.message}` : String(error) })
    reportAndExit(1)
  })

  Object.defineProperty(process, 'stdin', { value: makeInputStream() })
  Object.defineProperty(process, 'stdout', { value: makeOutputStream('out') })
  Object.defineProperty(process, 'stderr', { value: makeOutputStream('err') })

  try {
    // Harness entrypoints (cli.js, rpc-entry.js) run their own main() at module
    // evaluation time, so a plain import is the entire invocation. Relative and
    // bare paths must be turned into absolute file URLs for ESM resolution.
    await import(pathToFileURL(request.modulePath).href)
    // Long-running harness processes (rpc mode) keep the event loop busy; the
    // module only "finishes" here when it completes without calling exit —
    // Node then empties the loop and fires beforeExit, which becomes exit 0.
    process.on('beforeExit', (code) => reportAndExit(exitCached ?? code))
  } catch (error) {
    if (exitCached === null) {
      send({
        t: 'error',
        message: error instanceof Error ? `${error.stack ?? error.message}` : String(error)
      })
      reportAndExit(1)
    }
  }
}

process.parentPort.on('message', (event) => {
  const message = event?.data
  if (!message || typeof message !== 'object') return
  if (message.t === 'run') {
    // Report the helper's own OS pid before anything else. Electron leaves
    // `utilityProcess.fork().pid` undefined until the helper has spawned, so the
    // main process cannot read it synchronously after the fork; this handshake
    // is what lets a bundled harness be registered with the task manager and
    // orphan reaping exactly like a natively spawned one.
    send({ t: 'pid', pid: process.pid })
    void runHarnessModule(message)
    return
  }
  if (message.t === 'stdin-data' || message.t === 'stdin-end') {
    const input = process.stdin
    if (input instanceof Readable) {
      if (message.t === 'stdin-data' && typeof message.b64 === 'string') {
        input.push(Buffer.from(message.b64, 'base64'))
      } else if (message.t === 'stdin-end') {
        input.push(null)
      }
    }
  }
})
