/**
 * Making a Windows Oven's SSH server survive a restart.
 *
 * Windows ships its OpenSSH server as a *manual* service. A manual service does
 * not start with the machine, so a Windows Oven answers nothing after a restart
 * until someone opens an elevated shell and starts SSH by hand: every other part
 * of the Oven can be healthy and the app still cannot reach it. That is the one
 * part of this restart path the app cannot repair blindly, because changing a
 * service's start type needs administrator rights. An OpenSSH session to an
 * administrator account already carries them on Windows, so the attempt is worth
 * making from the session the app already has, and reporting honestly when the
 * machine refuses.
 *
 * This module is free of Electron and of process control: it builds the script
 * and reads its answer, which is what makes both testable without a Windows box.
 */

/** The service name Windows' optional OpenSSH server feature installs. */
export const WINDOWS_SSHD_SERVICE = 'sshd'

/** The command a person runs when the app is not allowed to change the service. */
export const WINDOWS_SSHD_STARTUP_COMMAND =
  'Set-Service -Name sshd -StartupType Automatic; Start-Service sshd'

/**
 * The script the setup step runs on the Oven.
 *
 * It reports the resulting start type on stdout and fails loudly when it cannot
 * change it, so a refusal is a fact the app can report instead of a silent no.
 */
export function windowsSshdStartupScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$service = Get-Service -Name ${WINDOWS_SSHD_SERVICE}`,
    `if ($service.StartType -ne 'Automatic') { Set-Service -Name ${WINDOWS_SSHD_SERVICE} -StartupType Automatic }`,
    `(Get-Service -Name ${WINDOWS_SSHD_SERVICE}).StartType.ToString()`
  ].join('; ')
}

/** Whether the Oven reported that its SSH server now starts with the machine. */
export function sshdStartsAutomatically(output: string): boolean {
  return /\bAutomatic\b/iu.test(output)
}

/** What a Windows Oven's setup says about this step while it runs. */
export function windowsSshdStepDetail(): string {
  return 'Windows starts this Oven\u2019s SSH server only when someone starts it by hand, so the Oven stops answering after a restart. This gives that service the automatic start it needs to come back on its own.'
}
