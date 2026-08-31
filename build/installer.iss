; Inno Setup script para Vigía.
; Genera el instalador de Windows a partir de la carpeta dist\Vigia
; (creada con: pyinstaller --noconfirm build/vigia.spec).
;
; La configuración y las grabaciones viven en %APPDATA%\Vigia, NO dentro de
; la carpeta del programa, así que al actualizar o desinstalar/reinstalar se
; conserva todo lo guardado.
;
; Para compilar:
;   ISCC.exe build\installer.iss   (o:  build\build_windows.bat)

#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#ifndef MyAppSource
  #define MyAppSource "..\dist\Vigia\*"
#endif

#define MyAppName "Vigia"
#define MyAppPublisher "Vigia"
#define MyAppURL "https://github.com/gtrespana-bit/Goofy-Burger"
#define MyAppExeName "Vigia.exe"
#define MyIcon "icon.ico"

[Setup]
; NOTA: este AppId debe ser único. Si distribuyes tu propia versión,
; genera otro con Tools > Generate GUID en Inno Setup.
AppId={{c70d685a-1a5e-4cae-951e-d5d3f5e95278}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={userpf}\Vigia
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=Vigia-Setup-{#MyAppVersion}
SetupIconFile={#MyIcon}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
; Desinstalar borra el programa pero NO la carpeta %APPDATA%\Vigia (datos).
[InstallDelete]
Type: filesandordirs; Name: "{app}\_internal"

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Crear un acceso directo en el escritorio"; GroupDescription: "Accesos directos:"
Name: "autostart"; Description: "Iniciar Vigia automaticamente al iniciar sesion"; GroupDescription: "Arranque:"

[Files]
Source: {#MyAppSource}; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\Desinstalar {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; Clave para arrancar con Windows si se marcó la tarea.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "Vigia"; ValueData: """{app}\{#MyAppExeName}"""; \
  Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Iniciar {#MyAppName} ahora"; Flags: nowait postinstall skipifsilent
