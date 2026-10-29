!include "MUI2.nsh"

!ifndef BUILD_EXE
  !define BUILD_EXE "..\server\target\release\kasugai_canvas.exe"
!endif
!ifndef SAMPLE_PROJECTS
  !define SAMPLE_PROJECTS "..\installer\projects"
!endif
!ifndef WEB_DIR
  !define WEB_DIR "..\web"
!endif

!define APP_NAME "KASUGAI Canvas"
!define APP_EXE "kasugai_canvas.exe"
!define CONFIG_FILE_NAME "kasugai_canvas.kasc"
!define PROJECT_MANIFEST_FILE_NAME "project.json"
!define INSTALL_DIR "C:\kasugai\kasugai_canvas"

Name "${APP_NAME}"
; icon.ico は 16x16 から 256x256 までのマルチサイズ ICO を含む
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
; SETUP_OUT: run.py /D override
!ifndef SETUP_OUT
  !define SETUP_OUT "kasugai_canvas_setup.exe"
!endif
OutFile "..\download\${SETUP_OUT}"
InstallDir "${INSTALL_DIR}"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "InstallLocation"
RequestExecutionLevel user
ManifestDPIAware true
Unicode True

VIProductVersion "6.4.0.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "FileVersion" "6.4.0"
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

  SetOutPath "$INSTDIR\web"
  ; vendor/ (vendored gsimaps) is served from the CDN and must not be bundled.
  ; The /x exclusion also covers a locally re-fetched web/vendor/.
  File /r /x "vendor" "${WEB_DIR}\*"

  SetOutPath "$INSTDIR\projects"
  ; /x "default" は相対パスではなく項目名にマッチするため、
  ; default/ と default_local\default/ の両方がここで除外される
  File /nonfatal /r /x "default" "${SAMPLE_PROJECTS}\*"

  CreateDirectory "$INSTDIR\projects\default"
  CreateDirectory "$INSTDIR\data"
  ; ユーザーが編集し得るプロジェクト(.kasc・DATA 等)は既存ファイルを
  ; 上書きせず、不足分のみ補充する(SetOverwrite off)。
  ; /x で抜けた default/ と default_local\default/ の両方が対象
  SetOverwrite off
  SetOutPath "$INSTDIR\projects\default"
  File /nonfatal /r "${SAMPLE_PROJECTS}\default\*"
  SetOutPath "$INSTDIR\projects\default_local\default"
  File /nonfatal /r "${SAMPLE_PROJECTS}\default_local\default\*"
  SetOverwrite on

  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\KASUGAI Canvas"
  CreateShortcut "$SMPROGRAMS\KASUGAI Canvas\kasugai_canvas.lnk" "$INSTDIR\${APP_EXE}" "--open-browser"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas" "InstallLocation" "$INSTDIR"

  WriteRegStr HKCU "Software\Classes\.kasc" "" "KASUGAI.Canvas"
  WriteRegStr HKCU "Software\Classes\KASUGAI.Canvas" "" "KASUGAI Canvas ${U+30D7}${U+30ED}${U+30B8}${U+30A7}${U+30AF}${U+30C8}"
  WriteRegStr HKCU "Software\Classes\KASUGAI.Canvas\DefaultIcon" "" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "Software\Classes\KASUGAI.Canvas\shell\open\command" "" '"$INSTDIR\${APP_EXE}" "--open-browser" "%1"'
  ; Windows 8+ ファイルの関連付け反映
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)r'
SectionEnd

Function CreateDesktopShortcut
  CreateShortcut "$DESKTOP\kasugai_canvas.lnk" "$INSTDIR\${APP_EXE}" "--open-browser"
FunctionEnd

Section "Uninstall"
  Delete "$DESKTOP\kasugai_canvas.lnk"
  Delete "$SMPROGRAMS\KASUGAI Canvas\kasugai_canvas.lnk"
  RMDir "$SMPROGRAMS\KASUGAI Canvas"
  RMDir /r "$INSTDIR\web"
  RMDir /r "$INSTDIR\projects"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\kasugai_canvas.update.json"
  Delete "$INSTDIR\kasugai_canvas.cloud.json"
  Delete "$INSTDIR\kasugai_canvas.projects.json"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KASUGAI Canvas"
  DeleteRegKey HKCU "Software\Classes\KASUGAI.Canvas"
  DeleteRegKey HKCU "Software\Classes\.kasc"
SectionEnd
