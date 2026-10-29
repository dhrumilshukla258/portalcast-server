; PortalCast Server — Windows installer (Inno Setup 6).
; Built by .github/workflows/release.yml:
;   iscc /DAppVersion=1.2.0 /DBundleDir=<bundle dir> /DOutDir=<dir> packaging\windows\portalcast.iss
;
; Installs to Program Files\PortalCast Server, keeps config + data in C:\ProgramData\PortalCast
; (kept on uninstall). Two ways to run it:
;   - the app "PortalCast Server.exe" (default): a window with the log and Start/Stop, in the
;     tray when closed, optionally started at sign-in; the server runs as the signed-in user
;   - "background service": a startup task running the server as SYSTEM at boot, no window
;     (a PC nobody signs in to); the app then only shows its log and status
; The bundle dir holds "PortalCast Server.exe" (packaging/windows/PortalCastServer.cs, built
; by the workflow) next to node\, app\ and launcher.js.

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
UninstallDisplayIcon={app}\PortalCast Server.exe
SetupIconFile=portalcast.ico
; "Start with Windows" is the signed-in user's own setting (HKCU), removed on uninstall.
UsedUserAreasWarning=no

[Tasks]
Name: "autostart"; Description: "Start PortalCast Server when I sign in to Windows"
Name: "desktopicon"; Description: "Desktop shortcut"; Flags: unchecked
Name: "service"; Description: "Instead, run as a background service at startup, with no window (for a PC nobody signs in to)"; Flags: unchecked

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Dirs]
Name: "{commonappdata}\PortalCast\logs"

[Icons]
Name: "{group}\PortalCast Server"; Filename: "{app}\PortalCast Server.exe"
Name: "{group}\Open PortalCast in the browser"; Filename: "http://localhost:3000"
Name: "{group}\PortalCast settings"; Filename: "{commonappdata}\PortalCast\portalcast.env"
Name: "{group}\Getting started"; Filename: "{commonappdata}\PortalCast\FIRST-RUN.txt"
Name: "{group}\Uninstall PortalCast Server"; Filename: "{uninstallexe}"
Name: "{autodesktop}\PortalCast Server"; Filename: "{app}\PortalCast Server.exe"; Tasks: desktopicon

[Registry]
; The app reads this to know whether the background service runs the server.
Root: HKLM; Subkey: "Software\PortalCast"; ValueType: string; ValueName: "ServiceMode"; ValueData: "1"; Tasks: service; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\PortalCast"; ValueType: string; ValueName: "ServiceMode"; ValueData: "0"; Tasks: not service; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "PortalCast Server"; Flags: uninsdeletevalue dontcreatekey

[Run]
; First-run config (random JWT secret) in C:\ProgramData\PortalCast; the admin account is
; created in the browser on the first visit.
Filename: "{app}\node\node.exe"; Parameters: """{app}\launcher.js"" --init-config"; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""PortalCast Server"""; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""PortalCast Server"" dir=in action=allow protocol=TCP localport=3000"; Flags: runhidden waituntilterminated
; Background service: a startup task as SYSTEM that also writes the log the app shows.
Filename: "{sys}\schtasks.exe"; Parameters: "/Create /F /TN ""PortalCast Server"" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR ""\""{app}\node\node.exe\"" \""{app}\launcher.js\"" --log-file \""{commonappdata}\PortalCast\logs\server.log\"""""; Flags: runhidden waituntilterminated; Tasks: service
Filename: "{sys}\schtasks.exe"; Parameters: "/Run /TN ""PortalCast Server"""; Flags: runhidden waituntilterminated; Tasks: service
; The app: no startup task (an older install's is removed), and the signed-in user may write
; the config and data the server it runs keeps in C:\ProgramData\PortalCast.
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN ""PortalCast Server"""; Flags: runhidden waituntilterminated; Tasks: not service
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\PortalCast"" /grant ""{username}:(OI)(CI)M"" /T /C /Q"; Flags: runhidden waituntilterminated; Tasks: not service
Filename: "{app}\PortalCast Server.exe"; Parameters: "--autostart-on"; Description: "Start PortalCast Server"; Flags: postinstall nowait skipifsilent runasoriginaluser; Tasks: autostart and not service
Filename: "{app}\PortalCast Server.exe"; Parameters: "--autostart-off"; Description: "Start PortalCast Server"; Flags: postinstall nowait skipifsilent runasoriginaluser; Tasks: not autostart and not service
Filename: "{app}\PortalCast Server.exe"; Description: "Show the server's log"; Flags: postinstall nowait skipifsilent runasoriginaluser unchecked; Tasks: service
Filename: "{commonappdata}\PortalCast\FIRST-RUN.txt"; Description: "Show getting started"; Flags: postinstall shellexec skipifsilent unchecked

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ""PortalCast Server.exe"""; Flags: runhidden; RunOnceId: "KillApp"
Filename: "{sys}\schtasks.exe"; Parameters: "/End /TN ""PortalCast Server"""; Flags: runhidden; RunOnceId: "EndTask"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN ""PortalCast Server"""; Flags: runhidden; RunOnceId: "DeleteTask"
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Get-Process node -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '{app}\*' } | Stop-Process -Force"""; Flags: runhidden; RunOnceId: "KillNode"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""PortalCast Server"""; Flags: runhidden; RunOnceId: "DeleteFirewall"

[Code]
// An install from before the app ran the server as a startup task: keep that way by default.
function OldServiceTaskExists(): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\schtasks.exe'), '/Query /TN "PortalCast Server"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpSelectTasks) and OldServiceTaskExists() then
    WizardSelectTasks('service');
end;

// Stop a running server before files are replaced (upgrade): close the app (its server ends
// with it), end the startup task and any node.exe running from this install folder. Never
// touches other Node.js processes.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM "PortalCast Server.exe"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN "PortalCast Server"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' + ExpandConstant('{app}') + '\*'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
