!include "MUI2.nsh"

!ifndef BUILD_EXE
  !define BUILD_EXE "..\server\target\release\kasugai_canvas.exe"
!endif

!define APP_NAME "KASUGAI Canvas"
!define APP_EXE "kasugai_canvas.exe"
!define INSTALL_DIR "C:\kasugai\kasugai_canvas"

Name "${APP_NAME}"
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
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Japanese"

Section "Install"
  SetOutPath "$INSTDIR"
  File "${BUILD_EXE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\KASUGAI Canvas"
  CreateShortcut "$SMPROGRAMS\KASUGAI Canvas\KASUGAI Canvas.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$DESKTOP\KASUGAI Canvas.lnk" "$INSTDIR\${APP_EXE}"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "InstallLocation" "$INSTDIR"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\KASUGAI Canvas.lnk"
  Delete "$SMPROGRAMS\KASUGAI Canvas\KASUGAI Canvas.lnk"
  RMDir "$SMPROGRAMS\KASUGAI Canvas"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas"
SectionEnd
