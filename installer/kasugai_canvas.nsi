!include "MUI2.nsh"

!ifndef BUILD_EXE
  !define BUILD_EXE "..\server\target\release\kasugai_canvas.exe"
!endif
!ifndef SAMPLE_CONFIG
  !define SAMPLE_CONFIG "kasugai_canvas.config"
!endif
!ifndef SAMPLE_PROJECTS
  !define SAMPLE_PROJECTS "..\installer\projects"
!endif

!define APP_NAME "KASUGAI Canvas"
!define APP_EXE "kasugai_canvas.exe"
!define CONFIG_FILE_NAME "kasugai_canvas.config"
!define PROJECT_MANIFEST_FILE_NAME "project.json"
!define INSTALL_DIR "C:\kasugai\kasugai_canvas"

Name "${APP_NAME}"
; icon.ico は 16x16 から 256x256 までのマルチサイズ ICO を含む
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
OutFile "..\download\kasugai_canvas_setup.exe"
InstallDir "${INSTALL_DIR}"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "InstallLocation"
RequestExecutionLevel user
ManifestDPIAware true
Unicode True

VIProductVersion "1.0.24.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "FileVersion" "1.0.24"
VIAddVersionKey "CompanyName" "${U+5C71}${U+672C}${U+7ADC}${U+4E09}"
VIAddVersionKey "LegalCopyright" "Copyright ${U+00A9} ${U+5C71}${U+672C}${U+7ADC}${U+4E09}"

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

Function .onInit
  ExecWait '"$SYSDIR\taskkill.exe" /IM "${APP_EXE}" /T /F'
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File "${BUILD_EXE}"
  IfFileExists "$INSTDIR\${CONFIG_FILE_NAME}" config_exists
  File "${SAMPLE_CONFIG}"
config_exists:
  SetOutPath "$INSTDIR\projects"
  File /nonfatal /r /x "default" "${SAMPLE_PROJECTS}\*"

  CreateDirectory "$INSTDIR\projects\default"
  SetOutPath "$INSTDIR\projects\default"
  IfFileExists "$INSTDIR\projects\default\${CONFIG_FILE_NAME}" default_config_exists
  File "${SAMPLE_PROJECTS}\default\${CONFIG_FILE_NAME}"
default_config_exists:
  IfFileExists "$INSTDIR\projects\default\${PROJECT_MANIFEST_FILE_NAME}" default_manifest_exists
  File "${SAMPLE_PROJECTS}\default\${PROJECT_MANIFEST_FILE_NAME}"
default_manifest_exists:

  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\KASUGAI Canvas"
  CreateShortcut "$SMPROGRAMS\KASUGAI Canvas\kasugai_canvas.lnk" "$INSTDIR\${APP_EXE}" "--open-browser"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "InstallLocation" "$INSTDIR"
SectionEnd

Function CreateDesktopShortcut
  CreateShortcut "$DESKTOP\kasugai_canvas.lnk" "$INSTDIR\${APP_EXE}" "--open-browser"
FunctionEnd

Section "Uninstall"
  Delete "$DESKTOP\kasugai_canvas.lnk"
  Delete "$SMPROGRAMS\KASUGAI Canvas\kasugai_canvas.lnk"
  RMDir "$SMPROGRAMS\KASUGAI Canvas"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas"
SectionEnd
