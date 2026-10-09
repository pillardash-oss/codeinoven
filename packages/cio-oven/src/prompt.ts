import { createInterface, type Interface } from 'node:readline/promises'

/**
 * One prompt session for the whole command.
 *
 * A CLI that opens a fresh interface per question leaves the cursor and the
 * terminal mode in a different state after every answer, so the session is
 * shared and closed once.
 */
let session: Interface | undefined

/** Whether an attached terminal can actually answer a question. */
export function promptsAvailable(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

function prompt(): Interface {
  session ??= createInterface({ input: process.stdin, output: process.stdout })
  return session
}

export function closePrompts(): void {
  session?.close()
  session = undefined
}

/** Ask for free text, keeping the offered value when the answer is empty. */
export async function askText(question: string, offered: string): Promise<string> {
  const answer = (await prompt().question(`${question} [${offered}]: `)).trim()
  return answer || offered
}

/** A port answer, and whether the user named it or accepted the offer. */
export interface PortAnswer {
  port: number
  /** True when a port was typed, false when the offered one was accepted. */
  explicit: boolean
}

/** Ask for a TCP port, re-asking until the answer is one a client could dial. */
export async function askPort(question: string, offered: number): Promise<PortAnswer> {
  while (true) {
    const answer = (await prompt().question(`${question} [${offered}]: `)).trim()
    if (!answer) return { port: offered, explicit: false }
    const port = Number(answer)
    if (Number.isSafeInteger(port) && port >= 1 && port <= 65535) return { port, explicit: true }
    process.stdout.write('Enter a port between 1 and 65535.\n')
  }
}

/** Ask a yes/no question, keeping the offered answer when the answer is empty. */
export async function askConfirm(question: string, offered: boolean): Promise<boolean> {
  const suffix = offered ? '[Y/n]' : '[y/N]'
  while (true) {
    const answer = (await prompt().question(`${question} ${suffix}: `)).trim().toLowerCase()
    if (!answer) return offered
    if (answer === 'y' || answer === 'yes') return true
    if (answer === 'n' || answer === 'no') return false
    process.stdout.write('Answer yes or no.\n')
  }
}
