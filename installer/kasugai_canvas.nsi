!include "MUI2.nsh"

!ifndef BUILD_EXE
  !define BUILD_EXE "..\server\target\release\kasugai_canvas.exe"
!endif

!define APP_NAME "KASUGAI Canvas"
!define APP_EXE "kasugai_canvas.exe"
!define INSTALL_DIR "C:\kasugai\kasugai_canvas"

Name "${APP_NAME}"
; icon.ico は 16x16 から 256x256 までのマルチサイズ ICO を含む
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
OutFile "..\download\kasugai_canvas_setup.exe"
InstallDir "${INSTALL_DIR}"
InstallDirRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "InstallLocation"
RequestExecutionLevel admin
Unicode True

VIProductVersion "0.4.0.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "CompanyName" "KASUGAI"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_PARAMETERS "--open-browser"
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Japanese"

Section "Install"
  SetOutPath "$INSTDIR"
  File "${BUILD_EXE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\KASUGAI Canvas"
  CreateShortcut "$SMPROGRAMS\KASUGAI Canvas\KASUGAI Canvas.lnk" "$INSTDIR\${APP_EXE}" "--open-browser"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "InstallLocation" "$INSTDIR"
SectionEnd

Function CreateDesktopShortcut
  CreateShortcut "$DESKTOP\KASUGAI Canvas.lnk" "$INSTDIR\${APP_EXE}" "--open-browser"
FunctionEnd

Section "Uninstall"
  Delete "$DESKTOP\KASUGAI Canvas.lnk"
  Delete "$SMPROGRAMS\KASUGAI Canvas\KASUGAI Canvas.lnk"
  RMDir "$SMPROGRAMS\KASUGAI Canvas"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas"
SectionEnd
