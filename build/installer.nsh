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

!define CIO_CLOSE_APP_SCRIPT "${__FILEDIR__}\close-windows-app.ps1"

; The native launcher and Electron runtime have different executable names.
; Override the single-image fallback so the runtime cannot retain old files
; after the launcher is stopped. Match exact paths, not every app with that name.
!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\close-windows-app.ps1 "${CIO_CLOSE_APP_SCRIPT}"
  ${If} ${isUpdated}
    ; The app's shutdown pipeline starts before NSIS, but finishes asynchronously.
    Sleep 5000
  ${EndIf}
  ${Do}
    nsExec::ExecToStack /TIMEOUT=30000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\close-windows-app.ps1" -InstallDirectory "$INSTDIR" -LauncherFileName "${APP_EXECUTABLE_FILENAME}"'
    Pop $R0
    Pop $R2
    ${If} $R0 == 0
      ${ExitDo}
    ${EndIf}
    ${If} $R0 == 10
      ; Anything still running may have unsaved work. Confirm before force cleanup.
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDCANCEL IDOK +2
      Quit
      DetailPrint "$(appClosing)"
      nsExec::ExecToStack /TIMEOUT=30000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\close-windows-app.ps1" -InstallDirectory "$INSTDIR" -LauncherFileName "${APP_EXECUTABLE_FILENAME}" -Stop'
      Pop $R0
      Pop $R2
      ${If} $R0 == 0
        ${ExitDo}
      ${EndIf}
    ${EndIf}
    DetailPrint "$R2"
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
    Quit
  ${Loop}
!macroend

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
