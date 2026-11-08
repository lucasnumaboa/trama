; Trama installer (Inno Setup 6). Built by build-installer.bat.
#define MyAppName "Trama"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Trama"
#define MyAppURL "https://github.com/lucasnumaboa/trama"

[Setup]
AppId={{B7E2C1A4-5D3F-4E8A-9C21-7A6F0B3D2E10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\Trama
DefaultGroupName=Trama
OutputDir=output
OutputBaseFilename=Trama-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
SetupIconFile=trama.ico
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\public\favicon.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Server code, built interface and project files. Dependencies are installed on first start.
Source: "..\server\*"; DestDir: "{app}\server"; Excludes: "fixtures\*,*.test.js"; Flags: recursesubdirs ignoreversion
Source: "..\dist\*"; DestDir: "{app}\dist"; Flags: recursesubdirs ignoreversion
Source: "..\public\*"; DestDir: "{app}\public"; Flags: recursesubdirs ignoreversion
Source: "..\tools\*"; DestDir: "{app}\tools"; Flags: recursesubdirs ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package-lock.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\start-trama.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
; Data folder (settings and projects) is created empty: the user's API key is never packaged.

[Dirs]
Name: "{app}\data"

[Icons]
Name: "{group}\Trama"; Filename: "{app}\start-trama.bat"; WorkingDir: "{app}"; IconFilename: "{app}\public\favicon.ico"
Name: "{group}\{cm:UninstallProgram,Trama}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Trama"; Filename: "{app}\start-trama.bat"; WorkingDir: "{app}"; IconFilename: "{app}\public\favicon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\start-trama.bat"; Description: "{cm:LaunchProgram,Trama}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent shellexec
