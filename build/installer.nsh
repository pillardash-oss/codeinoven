; CodeInOven   Windows shell integration (\"Open in CodeInOven\").
;
; Windows has no document-type registration file: shell verbs live in the
; registry, so the installer adds them and the uninstaller removes them. The
; electron-builder NSIS templates include this file through `nsis.include` and
; invoke `customInstall` / `customUnInstall` from their install and uninstall
; sections, where `$appExe` and `SHELL_CONTEXT` are already set.
;
; `SHELL_CONTEXT` follows the install mode electron-builder configured (HKCU for
; per-user installs, HKLM for all-users), which is exactly how the rest of the
; installer writes registry state, so the verbs land in the same hive as the
; uninstall entry.
;
; Three keys cover every way a user reaches the command:
;   Directory\shell          right-clicking a folder
;   Directory\Background\shell   right-clicking the empty space inside a folder
;   *\shell                  right-clicking any file (opened on its own)
;
; The verb is registered as an on-demand menu item only   no file type is made
; to default to CodeInOven, so double-clicking a folder or document keeps its
; current behavior.

!macro CodeInOvenShellVerbRegister KEY LABEL ARGUMENT
  WriteRegStr SHELL_CONTEXT "${KEY}" "" "${LABEL}"
  WriteRegStr SHELL_CONTEXT "${KEY}" "Icon" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "${KEY}\command" "" '"$appExe" "${ARGUMENT}"'
!macroend

!macro CodeInOvenShellVerbRemove KEY
  DeleteRegKey SHELL_CONTEXT "${KEY}"
!macroend

!macro customInstall
  !insertmacro CodeInOvenShellVerbRegister "Software\Classes\Directory\shell\CodeInOven" "Open in CodeInOven" "%1"
  !insertmacro CodeInOvenShellVerbRegister "Software\Classes\Directory\Background\shell\CodeInOven" "Open in CodeInOven" "%V"
  !insertmacro CodeInOvenShellVerbRegister "Software\Classes\*\shell\CodeInOven" "Open in CodeInOven" "%1"
  ; Let Explorer pick the new verbs up without a restart.
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  !insertmacro CodeInOvenShellVerbRemove "Software\Classes\Directory\shell\CodeInOven"
  !insertmacro CodeInOvenShellVerbRemove "Software\Classes\Directory\Background\shell\CodeInOven"
  !insertmacro CodeInOvenShellVerbRemove "Software\Classes\*\shell\CodeInOven"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
