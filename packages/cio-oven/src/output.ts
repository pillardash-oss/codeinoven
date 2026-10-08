/** Human-facing output. This CLI is the interface, so it writes to the streams directly. */

const VERSION_LINE = 'CodeInOven Oven'

export function banner(): void {
  blank()
  out(`  ${VERSION_LINE}`)
  out('  Turn this machine into an Oven and get a code for the app.')
}

export function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

export function blank(): void {
  process.stdout.write('\n')
}

export function step(text: string): void {
  out(`  ${text}`)
}

export function note(text: string): void {
  out(`  ${text}`)
}

/** A warning that does not stop the command. */
export function warn(text: string): void {
  process.stderr.write(`  warning: ${text}\n`)
}

export function fail(text: string): never {
  process.stderr.write(`\n  ${text}\n\n`)
  process.exit(1)
}

/** An aligned key/value block, used for the connection summary. */
export function field(label: string, value: string): void {
  const width = 12
  out(`  ${label.padEnd(width)}${value}`)
}

/** A titled section. */
export function section(title: string): void {
  blank()
  out(`  ${title}`)
  out(`  ${'-'.repeat(title.length)}`)
}

/** Text a user is expected to copy, fenced so its exact boundaries are obvious. */
export function code(value: string): void {
  blank()
  out(value)
  blank()
}
