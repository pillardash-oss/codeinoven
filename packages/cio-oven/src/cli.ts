import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { restart, start, status, stop, type CommonOptions, type StartOptions } from './commands'
import { defaultDataRoot } from './paths'
import { closePrompts } from './prompt'
import { banner, fail, out } from './output'

const HELP = `Usage: cio-oven <command> [options]

Turn this machine into a CodeInOven Oven, then register it in the app with the
code this prints.

Commands
  start      Install and start the durable Oven service in the background
  stop       Stop the Oven service
  restart    Replace the running service with this release
  status     Show whether the service is installed and running
  help       Show this message

Options
  --name <name>        Oven name shown in the app  [default: this machine's host name]
  --port <port>        SSH port the app connects on [default: the sshd port, else 22]
  --identity           Provision a dedicated SSH key (default when asked)
  --no-identity        Register against your existing SSH identity instead
  --data-root <path>   Where the service keeps its state  [default: ~/.config/pillardash/codeinoven/ovens]
  --force, -f          Replace a running service without asking
  --yes, -y            Accept every default without prompting
  --json               Machine-readable output for status, start, and stop
  --version, -v        Print the version
  --help, -h           Show this message

Examples
  npx cio-oven start
  npx cio-oven start --yes --port 2222
  npx cio-oven status
  npx cio-oven stop
`

function packageVersion(): string {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

interface Parsed {
  command: string
  dataRoot: string
  json: boolean
  yes: boolean
  force: boolean
  name?: string
  port?: number
  identity?: boolean
}

function parse(argv: string[]): Parsed {
  let values: Record<string, string | boolean | undefined>
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
      options: {
        'data-root': { type: 'string' },
        port: { type: 'string' },
        name: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        force: { type: 'boolean', short: 'f' },
        identity: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' }
      }
    })
    values = parsed.values as Record<string, string | boolean | undefined>
    positionals = parsed.positionals
  } catch (error) {
    fail(error instanceof Error ? error.message : 'That command line could not be parsed.')
  }
  if (values['help'])
    return { command: 'help', dataRoot: '', json: false, yes: false, force: false }
  if (values['version'])
    return { command: 'version', dataRoot: '', json: false, yes: false, force: false }
  const dataRoot =
    (values['data-root'] as string | undefined) ??
    process.env['CODEINOVEN_OVEN_DATA_ROOT'] ??
    defaultDataRoot()
  const rawPort = values['port'] as string | undefined
  const port = rawPort === undefined ? undefined : Number(rawPort)
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535))
    fail('--port must be a number between 1 and 65535.')
  return {
    command: positionals[0] ?? 'help',
    dataRoot,
    json: values['json'] === true,
    yes: values['yes'] === true,
    force: values['force'] === true,
    ...(values['name'] === undefined ? {} : { name: values['name'] as string }),
    ...(port === undefined ? {} : { port }),
    ...(values['identity'] === undefined ? {} : { identity: values['identity'] === true })
  }
}

/** Run one command. The bin script supplies `process.argv`. */
export async function main(argv: string[]): Promise<void> {
  const parsed = parse(argv)
  const common: CommonOptions = { dataRoot: parsed.dataRoot, json: parsed.json }
  const startOptions: StartOptions = {
    ...common,
    yes: parsed.yes,
    force: parsed.force,
    ...(parsed.name === undefined ? {} : { name: parsed.name }),
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
    ...(parsed.identity === undefined ? {} : { identity: parsed.identity })
  }
  try {
    switch (parsed.command) {
      case 'start':
        banner()
        await start(startOptions)
        return
      case 'restart':
        banner()
        await restart(startOptions)
        return
      case 'stop':
        await stop(common)
        return
      case 'status':
        await status(common)
        return
      case 'version':
        out(packageVersion())
        return
      case 'help':
        out(HELP)
        return
      default:
        fail(`Unknown command "${parsed.command}". Run cio-oven help to see the commands.`)
    }
  } finally {
    closePrompts()
  }
}
