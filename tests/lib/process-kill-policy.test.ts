import { describe, expect, it } from 'vitest'
import { unmanagedProcessKillReason } from '../../src/lib/agent-control-policy'

const shell = (command: string): string | null => unmanagedProcessKillReason('bash', { command })

describe('process lifecycle guard', () => {
  it('ignores non-shell tools', () => {
    expect(unmanagedProcessKillReason('read', { path: 'kill.ts' })).toBeNull()
    expect(unmanagedProcessKillReason('write', { content: 'kill 1' })).toBeNull()
  })

  it('ignores empty commands', () => {
    expect(shell('')).toBeNull()
    expect(shell('   ')).toBeNull()
  })

  it('allows ordinary shell work', () => {
    expect(shell('ls -la')).toBeNull()
    expect(shell('bun run check')).toBeNull()
    expect(shell('ps aux | grep node')).toBeNull()
    expect(shell('lsof -ti:5173')).toBeNull()
    expect(shell('git log --grep=kill')).toBeNull()
    expect(shell('grep -c "killall" file.ts')).toBeNull()
  })

  it('allows quoted search patterns that mention a killer', () => {
    expect(shell('rg -n "pkill|killall" src')).toBeNull()
    expect(shell('rg -n "kill|fuser -k" docs')).toBeNull()
    expect(shell('echo "kill 123"')).toBeNull()
    expect(shell('git commit -m "docs: explain why kill is blocked"')).toBeNull()
  })

  it('allows signal listing, which stops nothing', () => {
    expect(shell('kill -l')).toBeNull()
    expect(shell('/bin/kill -0 1234')).toBeNull()
  })

  it('refuses every direct killer', () => {
    expect(shell('kill 123')).toContain('Not executed')
    expect(shell('kill -9 123')).toContain('Not executed')
    expect(shell('kill 1 2')).toContain('Not executed')
    expect(shell('kill 18595 2>/dev/null')).toContain('Not executed')
    expect(shell('pkill -f vite')).toContain('Not executed')
    expect(shell('killall node')).toContain('Not executed')
    expect(shell('fuser -k 5173/tcp')).toContain('Not executed')
    expect(shell('taskkill /F /PID 123')).toContain('Not executed')
    expect(shell('Stop-Process -Id 123')).toContain('Not executed')
    expect(shell('npx kill-port 5173')).toContain('Not executed')
  })

  it('refuses a kill anywhere in a compound command', () => {
    expect(shell('echo x > f && kill 5')).toContain('Not executed')
    expect(shell('kill 5; rm -f f')).toContain('Not executed')
    expect(shell('cd /tmp && sleep 1 && kill 5')).toContain('Not executed')
    expect(shell('lsof -ti:5173 | xargs kill -9')).toContain('Not executed')
  })

  it('refuses a pid resolved at run time', () => {
    expect(shell('kill $(lsof -ti:5173)')).toContain('Not executed')
    expect(shell('kill `pgrep -f vite`')).toContain('Not executed')
    expect(shell('fuser -k 3000/tcp')).toContain('Not executed')
  })

  it('refuses kill through a wrapper', () => {
    expect(shell('sudo kill 1')).toContain('Not executed')
    expect(shell('sudo -u root kill 1')).toContain('Not executed')
    expect(shell('nohup kill 1')).toContain('Not executed')
    expect(shell('timeout 5 kill 1')).toContain('Not executed')
  })

  it('refuses a nested shell', () => {
    expect(shell('bash -c "lsof -ti:5173 | xargs kill -9"')).toContain('Not executed')
    expect(shell("sh -c 'kill 1'")).toContain('Not executed')
    expect(shell('zsh -lc "pkill -f vite"')).toContain('Not executed')
    expect(shell('bash -lc "rg -n kill src"')).toBeNull()
  })

  it('refuses an interpreter that stops a process', () => {
    expect(shell('node -e "process.kill(1)"')).toContain('Not executed')
    expect(shell('bun -e "process.kill(process.pid, 9)"')).toContain('Not executed')
    expect(shell('python3 -c "import os; os.kill(1, 9)"')).toContain('Not executed')
    expect(shell('ruby -e "Process.kill(9, 1)"')).toContain('Not executed')
    expect(shell('node -e "console.log(1 + 1)"')).toBeNull()
  })

  it('refuses -exec and heredoc forms', () => {
    expect(shell('find . -name "*.ts" -exec kill {} +')).toContain('Not executed')
    expect(shell('cat <<EOF\nkill 1\nEOF')).toBeNull()
    expect(shell('bash <<SH\nkill 1\nSH')).toContain('Not executed')
    expect(shell('bash <<SH\nrg -n kill src\nSH')).toBeNull()
  })

  it('refuses Windows PowerShell name matching', () => {
    expect(
      unmanagedProcessKillReason('powershell', { command: 'Stop-Process -Name node' })
    ).toContain('Not executed')
    expect(unmanagedProcessKillReason('powershell', { command: 'Get-Process node' })).toBeNull()
  })

  it('points at the app-owned process path', () => {
    const reason = shell('pkill -f vite')
    expect(reason).toContain('cio_process_stop')
    expect(reason).toContain('cio_process_list')
    expect(reason).toContain('another port')
    expect(reason).not.toContain('cio_app_call')
    expect(reason).not.toContain('taskManager:')
  })
})
