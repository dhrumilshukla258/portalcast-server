; PortalCast Server — Windows installer (Inno Setup 6).
; Built by .github/workflows/release.yml:
;   iscc /DAppVersion=1.2.0 /DBundleDir=<bundle dir> /DOutDir=<dir> packaging\windows\portalcast.iss
;
; Installs to Program Files\PortalCast Server, keeps config + data in
; C:\ProgramData\PortalCast (kept on uninstall), and registers a "PortalCast Server" task
; that starts the server at boot as SYSTEM (no extra service wrapper needed).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef BundleDir
  #define BundleDir "..\..\build\bundle"
#endif
#ifndef OutDir
  #define OutDir "..\..\build"
#endif

[Setup]
AppId={{6D1E6C1A-4B7E-4F0B-9C3D-5A2F8E1B7C40}
AppName=PortalCast Server
AppVersion={#AppVersion}
AppPublisher=PortalCast
AppPublisherURL=https://github.com/dhrumilshukla258/portalcast-server
DefaultDirName={autopf}\PortalCast Server
DefaultGroupName=PortalCast Server
DisableProgramGroupPage=yes
OutputDir={#OutDir}
OutputBaseFilename=portalcast-server-{#AppVersion}-windows-x64-setup
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
WizardStyle=modern
UninstallDisplayName=PortalCast Server

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Open PortalCast"; Filename: "http://localhost:3000"
Name: "{group}\PortalCast settings"; Filename: "{commonappdata}\PortalCast\portalcast.env"
Name: "{group}\First-run sign-in details"; Filename: "{commonappdata}\PortalCast\FIRST-RUN.txt"
Name: "{group}\Uninstall PortalCast Server"; Filename: "{uninstallexe}"

[Run]
; First-run config (random JWT secret + admin password) in C:\ProgramData\PortalCast.
Filename: "{app}\node\node.exe"; Parameters: """{app}\launcher.js"" --init-config"; Flags: runhidden waituntilterminated
; Start at boot as SYSTEM, restart via the launcher's own supervisor.
Filename: "{sys}\schtasks.exe"; Parameters: "/Create /F /TN ""PortalCast Server"" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR ""\""{app}\node\node.exe\"" \""{app}\launcher.js\"""""; Flags: runhidden waituntilterminated
Filename: "{sys}\schtasks.exe"; Parameters: "/Run /TN ""PortalCast Server"""; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""PortalCast Server"" dir=in action=allow protocol=TCP localport=3000"; Flags: runhidden waituntilterminated
Filename: "{commonappdata}\PortalCast\FIRST-RUN.txt"; Description: "Show the admin sign-in details"; Flags: postinstall shellexec skipifsilent
Filename: "http://localhost:3000"; Description: "Open PortalCast"; Flags: postinstall shellexec skipifsilent unchecked

[UninstallRun]
Filename: "{sys}\schtasks.exe"; Parameters: "/End /TN ""PortalCast Server"""; Flags: runhidden; RunOnceId: "EndTask"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN ""PortalCast Server"""; Flags: runhidden; RunOnceId: "DeleteTask"
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Get-Process node -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '{app}\*' } | Stop-Process -Force"""; Flags: runhidden; RunOnceId: "KillNode"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""PortalCast Server"""; Flags: runhidden; RunOnceId: "DeleteFirewall"

[Code]
// Stop a running server before files are replaced (upgrade): end the startup task and any
// node.exe running from this install folder. Never touches other Node.js processes.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN "PortalCast Server"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' + ExpandConstant('{app}') + '\*'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
