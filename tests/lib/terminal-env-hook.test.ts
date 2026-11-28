import { describe, expect, it } from 'vitest'
import {
  bashRcFile,
  hookEnvironment,
  hookScript,
  parseHookRequest,
  responseScript,
  undoScript,
  terminalEnvHookBypass,
  terminalEnvHookShell,
  zshRcFiles
} from '../../src/lib/terminal-env-hook'

describe('terminal env hook shells', () => {
  it('recognises only a shell that has a pre-exec point', () => {
    expect(terminalEnvHookShell('/bin/zsh')).toBe('zsh')
    expect(terminalEnvHookShell('/usr/local/bin/bash')).toBe('bash')
    expect(terminalEnvHookShell('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash')
    expect(terminalEnvHookShell('/opt/homebrew/bin/fish')).toBe('fish')
    expect(terminalEnvHookShell('/bin/sh')).toBeNull()
    expect(terminalEnvHookShell('/bin/dash')).toBeNull()
    expect(terminalEnvHookShell('/usr/bin/pwsh')).toBeNull()
  })

  it('does not spend a request on a line that only moves the shell', () => {
    expect(terminalEnvHookBypass('')).toBe(true)
    expect(terminalEnvHookBypass('   ')).toBe(true)
    expect(terminalEnvHookBypass('cd packages/api')).toBe(true)
    expect(terminalEnvHookBypass('export STRIPE_KEY=1')).toBe(true)
    expect(terminalEnvHookBypass('source .env')).toBe(true)
    expect(terminalEnvHookBypass('bun run deploy')).toBe(false)
    expect(terminalEnvHookBypass('cdx deploy')).toBe(false)
  })

  it('points zsh at its startup directory and every shell at the session', () => {
    expect(hookEnvironment('zsh', '/private/session')).toEqual({
      CIO_ENV_HOOK_DIR: '/private/session',
      ZDOTDIR: '/private/session'
    })
    expect(hookEnvironment('bash', '/private/session')).toEqual({
      CIO_ENV_HOOK_DIR: '/private/session'
    })
  })

  it('installs zsh in preexec_functions and takes values back before the prompt', () => {
    const script = hookScript('zsh')
    expect(script).toContain('preexec_functions+=(__cio_env_hook_preexec)')
    expect(script).toContain('precmd_functions+=(__cio_env_hook_precmd)')
    expect(script).toContain('source "$__cio_env_hook_dir/undo.$__cio_seq"')
  })

  it('installs bash on a DEBUG trap that only answers the first command of a line', () => {
    const script = hookScript('bash')
    expect(script).toContain("trap '__cio_env_hook_preexec' DEBUG")
    expect(script).toContain('__cio_env_hook_armed=0')
    expect(script).toContain('PROMPT_COMMAND="__cio_env_hook_precmd')
  })

  it('installs fish on its own pre-exec and post-exec events', () => {
    const script = hookScript('fish')
    expect(script).toContain('--on-event fish_preexec')
    expect(script).toContain('--on-event fish_postexec')
  })
})

describe('terminal env hook response', () => {
  const saved = '__cio_env_hook_saved_STRIPE_KEY'
  const had = '__cio_env_hook_had_STRIPE_KEY'

  it('quotes a value so a shell reads it back unchanged', () => {
    const exportLine = "export STRIPE_KEY='sk_live_1'\n"
    expect(responseScript('zsh', { STRIPE_KEY: 'sk_live_1' })).toBe(
      'if [ "${STRIPE_KEY+x}" = x ]; then ' +
        `${had}=1; ${saved}=$STRIPE_KEY; else ${had}=; fi\n` +
        exportLine
    )
    expect(responseScript('bash', { STRIPE_KEY: "it's" })).toContain("export STRIPE_KEY='it'\\''s'")
    expect(responseScript('fish', { STRIPE_KEY: 'a b' })).toContain("set -gx STRIPE_KEY 'a b'")
  })

  it('remembers what the shell held, so a command never keeps a value it did not set', () => {
    const zsh = responseScript('zsh', { STRIPE_KEY: 'sk_live_1' })
    expect(zsh).toContain(`${had}=1`)
    expect(zsh).toContain(`${saved}=$STRIPE_KEY`)
    const fish = responseScript('fish', { STRIPE_KEY: 'sk_live_1' })
    expect(fish).toContain(`set -g ${saved} $STRIPE_KEY`)
    expect(fish).toContain(`set -e -g ${had}`)
  })

  it('keeps a value that spans lines inside one export', () => {
    expect(responseScript('zsh', { KEY: 'line one\nline two' })).toContain(
      "export KEY='line one\nline two'"
    )
  })

  it('writes no snippet when nothing is admitted', () => {
    expect(responseScript('zsh', {})).toBe('')
    expect(undoScript('zsh', {})).toBe('')
  })

  it('gives the shell its own value back, or unsets a name it never held', () => {
    expect(undoScript('zsh', { STRIPE_KEY: 'sk_live_1' })).toBe(
      'if [ -n "${' +
        `${had}-}" ]; then STRIPE_KEY=$__cio_env_hook_saved_STRIPE_KEY; else unset STRIPE_KEY; fi\n` +
        `unset ${had} ${saved}\n`
    )
    expect(undoScript('fish', { STRIPE_KEY: 'sk_live_1' })).toContain(
      'set -gx STRIPE_KEY $__cio_env_hook_saved_STRIPE_KEY'
    )
  })

  it('reads the working directory and the command back from a request', () => {
    expect(parseHookRequest('/repo\nbun run deploy\n')).toEqual({
      pwd: '/repo',
      command: 'bun run deploy'
    })
    expect(parseHookRequest('/repo\necho one\necho two')).toEqual({
      pwd: '/repo',
      command: 'echo one\necho two'
    })
  })
})

describe('terminal env hook startup files', () => {
  const input = {
    home: '/Users/someone',
    userZdotdir: '/Users/someone',
    deferred: ['STRIPE_KEY'],
    directory: '/config/runtime/env-hook/zsh-1'
  }

  it('keeps every zsh startup file the user wrote, and the hook last', () => {
    const files = zshRcFiles(input)
    expect(files.map((file) => file.name)).toEqual(['.zshenv', '.zprofile', '.zlogin', '.zshrc'])
    for (const file of files) {
      if (file.name === '.zshrc') continue
      expect(file.contents).toContain(`/Users/someone/${file.name}`)
    }
    const zshrc = files.find((file) => file.name === '.zshrc')?.contents ?? ''
    expect(zshrc).toContain("source '/Users/someone/.zshrc'")
    expect(zshrc).toContain('__cio_env_hook_preexec')
    expect(zshrc.trimEnd().endsWith('unset STRIPE_KEY')).toBe(true)
  })

  it('honours a non-default ZDOTDIR', () => {
    const files = zshRcFiles({ ...input, userZdotdir: '/Users/someone/.config/zsh' })
    expect(files[0]?.contents).toContain("source '/Users/someone/.config/zsh/.zshenv'")
  })

  it('loads the bash login profile, then .bashrc, then the hook', () => {
    const file = bashRcFile(input)
    const contents = file.contents
    expect(file.name).toBe('bashrc')
    expect(contents).toContain('. /etc/profile')
    expect(contents.indexOf('.bash_profile')).toBeLessThan(contents.indexOf('.bashrc'))
    expect(contents.indexOf('.bashrc')).toBeLessThan(contents.indexOf('__cio_env_hook_preexec'))
    expect(contents.trimEnd().endsWith('unset STRIPE_KEY')).toBe(true)
  })
})
