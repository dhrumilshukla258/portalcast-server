// PortalCast Server for Windows: the app people start (owner 2026-10-28: "an exe that starts the
// server, with a window showing its logs, like Jellyfin"). Built by the release workflow with
// the C# compiler that comes with Windows (.NET Framework 4.x, C# 5: nothing to install):
//   csc /target:winexe /win32icon:portalcast.ico /win32manifest:app.manifest
//       /r:System.Windows.Forms.dll /r:System.Drawing.dll /out:"PortalCast Server.exe" PortalCastServer.cs
//
// It sits in the install folder next to node\node.exe and launcher.js and:
//   - runs the server (node launcher.js --log-file ... --stop-on-stdin-end) with no console
//     window, inside a Windows job object, so the server never outlives the app
//   - shows the log (C:\ProgramData\PortalCast\logs\server.log), status and buttons
//   - lives in the tray when its window is closed; "Start with Windows" adds it to sign-in
//   - with the background service chosen in the installer (a startup task as SYSTEM), only
//     shows the log and status; Start/Stop then ask for administrator rights
// One copy runs at a time: starting it again shows the window.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace PortalCast
{
    static class Program
    {
        const string MutexName = "Local\\PortalCastServerApp";
        const string ShowEventName = "Local\\PortalCastServerApp.Show";

        [STAThread]
        static void Main(string[] args)
        {
            bool first;
            using (var mutex = new Mutex(true, MutexName, out first))
            {
                if (!first)
                {
                    // Already running: bring its window up instead of a second copy.
                    try { EventWaitHandle.OpenExisting(ShowEventName).Set(); } catch (Exception) { }
                    return;
                }
                var show = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
                foreach (var a in args)
                {
                    if (a == "--autostart-on") Autostart.Set(true);
                    if (a == "--autostart-off") Autostart.Set(false);
                }
                bool minimized = Array.IndexOf(args, "--minimized") >= 0;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                var form = new MainForm(minimized, show);
                Application.Run(form);
                GC.KeepAlive(mutex);
            }
        }
    }

    /// <summary>Where things are: next to this exe, and C:\ProgramData\PortalCast.</summary>
    static class Paths
    {
        public static readonly string AppDir = Path.GetDirectoryName(Application.ExecutablePath);
        public static readonly string Node = Path.Combine(AppDir, "node", "node.exe");
        public static readonly string Launcher = Path.Combine(AppDir, "launcher.js");
        public static readonly string Base = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PortalCast");
        public static readonly string Config = Path.Combine(Base, "portalcast.env");
        public static readonly string FirstRun = Path.Combine(Base, "FIRST-RUN.txt");
        public static readonly string Data = Path.Combine(Base, "data");
        public static readonly string Logs = Path.Combine(Base, "logs");
        public static readonly string Log = Path.Combine(Logs, "server.log");

        /// <summary>PORT from the settings file, else 3000.</summary>
        public static int Port()
        {
            try
            {
                foreach (var raw in File.ReadAllLines(Config))
                {
                    var line = raw.Trim();
                    if (!line.StartsWith("PORT=")) continue;
                    int p;
                    if (int.TryParse(line.Substring(5).Trim().Trim('"', '\''), out p) && p > 0 && p < 65536) return p;
                }
            }
            catch (Exception) { }
            return 3000;
        }
    }

    /// <summary>"Start with Windows": the per-user Run key.</summary>
    static class Autostart
    {
        const string Key = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        const string Name = "PortalCast Server";

        public static bool IsOn()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(Key)) { return k != null && k.GetValue(Name) != null; }
        }

        public static void Set(bool on)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(Key))
            {
                if (on) k.SetValue(Name, "\"" + Application.ExecutablePath + "\" --minimized");
                else if (k.GetValue(Name) != null) k.DeleteValue(Name);
            }
        }
    }

    /// <summary>The installer's "background service" choice (a startup task running as SYSTEM).</summary>
    static class Service
    {
        public const string Task = "PortalCast Server";

        public static bool Installed()
        {
            using (var k = Registry.LocalMachine.OpenSubKey("Software\\PortalCast"))
            {
                return k != null && Convert.ToString(k.GetValue("ServiceMode")) == "1";
            }
        }

        /// <summary>schtasks / stopping need administrator rights: Windows asks.</summary>
        public static void RunElevated(string file, string arguments)
        {
            try
            {
                var psi = new ProcessStartInfo(file, arguments) { Verb = "runas", UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden };
                using (var p = Process.Start(psi)) { if (p != null) p.WaitForExit(30000); }
            }
            catch (Exception) { /* the viewer said no */ }
        }

        public static void Start() { RunElevated("schtasks.exe", "/Run /TN \"" + Task + "\""); }

        public static void Stop()
        {
            var cmd = "schtasks /End /TN '" + Task + "'; Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '" + Paths.AppDir.Replace("'", "''") + "\\*' } | Stop-Process -Force";
            RunElevated("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"" + cmd + "\"");
        }
    }

    /// <summary>The server as a child of this app, in a job object that ends it with the app.</summary>
    sealed class Server
    {
        Process proc;
        readonly IntPtr job = Native.KillOnCloseJob();

        public bool Running { get { return proc != null && !proc.HasExited; } }

        public string Start()
        {
            if (Running) return null;
            if (!File.Exists(Paths.Node) || !File.Exists(Paths.Launcher)) return "This folder is missing node\\node.exe or launcher.js. Reinstall PortalCast Server.";
            Directory.CreateDirectory(Paths.Logs);
            var psi = new ProcessStartInfo(Paths.Node, "\"" + Paths.Launcher + "\" --log-file \"" + Paths.Log + "\" --stop-on-stdin-end")
            {
                WorkingDirectory = Paths.AppDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            try
            {
                proc = Process.Start(psi);
            }
            catch (Exception e)
            {
                return "Could not start the server: " + e.Message;
            }
            if (job != IntPtr.Zero) Native.AssignProcessToJobObject(job, proc.Handle);
            // The log file is what the window shows; the pipes only need draining.
            proc.OutputDataReceived += delegate { };
            proc.ErrorDataReceived += delegate { };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            return null;
        }

        /// <summary>Closing stdin asks the launcher to stop the server; after 10 s it is ended.</summary>
        public void Stop()
        {
            if (!Running) return;
            try { proc.StandardInput.Close(); } catch (Exception) { }
            if (!proc.WaitForExit(10000))
            {
                try { proc.Kill(); } catch (Exception) { }
            }
            proc = null;
        }
    }

    static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll")]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll")]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        /// <summary>A job whose processes end when this app ends, however it ends.</summary>
        public static IntPtr KillOnCloseJob()
        {
            try
            {
                var job = CreateJobObject(IntPtr.Zero, null);
                var info = new ExtendedLimits();
                info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                int size = Marshal.SizeOf(typeof(ExtendedLimits));
                IntPtr p = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(info, p, false);
                    SetInformationJobObject(job, 9, p, (uint)size); // JobObjectExtendedLimitInformation
                }
                finally { Marshal.FreeHGlobal(p); }
                return job;
            }
            catch (Exception) { return IntPtr.Zero; }
        }
    }

    sealed class MainForm : Form
    {
        static readonly Color BgColor = Color.FromArgb(11, 16, 32);
        static readonly Color PanelColor = Color.FromArgb(18, 26, 48);
        static readonly Color TextColor = Color.FromArgb(214, 226, 255);
        static readonly Color MutedColor = Color.FromArgb(140, 155, 190);
        static readonly Regex Ansi = new Regex("\\x1B\\[[0-9;]*m");

        readonly Server server = new Server();
        readonly bool serviceMode = Service.Installed();
        readonly NotifyIcon tray = new NotifyIcon();
        readonly Label status = new Label();
        readonly LinkLabel link = new LinkLabel();
        readonly TextBox log = new TextBox();
        readonly Button startBtn, stopBtn;
        readonly CheckBox autostart = new CheckBox();
        readonly System.Windows.Forms.Timer tailTimer = new System.Windows.Forms.Timer();
        readonly System.Windows.Forms.Timer statusTimer = new System.Windows.Forms.Timer();
        long logPos = -1;
        bool exiting, toldAboutTray, checking;
        readonly bool startHidden;

        public MainForm(bool minimized, EventWaitHandle show)
        {
            startHidden = minimized;
            Text = "PortalCast Server";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            BackColor = BgColor;
            ForeColor = TextColor;
            Font = new Font("Segoe UI", 9.5f);
            MinimumSize = new Size(720, 420);
            Size = new Size(980, 620);
            StartPosition = FormStartPosition.CenterScreen;

            var top = new Panel { Dock = DockStyle.Top, Height = 118, BackColor = PanelColor, Padding = new Padding(16, 12, 16, 8) };
            status.AutoSize = true;
            status.Font = new Font("Segoe UI Semibold", 13f);
            status.Location = new Point(16, 12);
            status.Text = "Starting…";
            link.AutoSize = true;
            link.Location = new Point(18, 42);
            link.LinkColor = Color.FromArgb(96, 165, 250);
            link.ActiveLinkColor = link.LinkColor;
            link.LinkClicked += delegate { OpenBrowser(); };

            var buttons = new FlowLayoutPanel { Location = new Point(12, 70), Size = new Size(940, 40), Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top, WrapContents = false };
            buttons.Controls.Add(MakeButton("Open PortalCast", delegate { OpenBrowser(); }, true));
            startBtn = MakeButton("Start", delegate { StartServer(); }, false);
            stopBtn = MakeButton("Stop", delegate { StopServer(); }, false);
            buttons.Controls.Add(startBtn);
            buttons.Controls.Add(stopBtn);
            buttons.Controls.Add(MakeButton("Restart", delegate { StopServer(); StartServer(); }, false));
            buttons.Controls.Add(MakeButton("Settings", delegate { OpenFile(Paths.Config); }, false));
            buttons.Controls.Add(MakeButton("Sign-in details", delegate { OpenFile(Paths.FirstRun); }, false));
            buttons.Controls.Add(MakeButton("Logs folder", delegate { OpenFolder(Paths.Logs); }, false));
            autostart.Text = "Start with Windows";
            autostart.AutoSize = true;
            autostart.ForeColor = MutedColor;
            autostart.Margin = new Padding(12, 9, 0, 0);
            autostart.Visible = !serviceMode;
            try { autostart.Checked = Autostart.IsOn(); } catch (Exception) { }
            autostart.CheckedChanged += delegate { try { Autostart.Set(autostart.Checked); } catch (Exception) { } };
            buttons.Controls.Add(autostart);
            top.Controls.Add(status);
            top.Controls.Add(link);
            top.Controls.Add(buttons);

            log.Multiline = true;
            log.ReadOnly = true;
            log.ScrollBars = ScrollBars.Both;
            log.WordWrap = false;
            log.Dock = DockStyle.Fill;
            log.BackColor = BgColor;
            log.ForeColor = TextColor;
            log.BorderStyle = BorderStyle.None;
            log.Font = new Font("Consolas", 9.5f);
            Controls.Add(log);
            Controls.Add(top);

            var menu = new ContextMenuStrip();
            menu.Items.Add("Open PortalCast", null, delegate { OpenBrowser(); });
            menu.Items.Add("Show window", null, delegate { ShowWindow(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Start server", null, delegate { StartServer(); });
            menu.Items.Add("Stop server", null, delegate { StopServer(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(serviceMode ? "Close this window app" : "Quit (stops the server)", null, delegate { Quit(); });
            tray.Icon = Icon;
            tray.Text = "PortalCast Server";
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            tray.DoubleClick += delegate { ShowWindow(); };

            // A second start of the app shows this window.
            ThreadPool.RegisterWaitForSingleObject(show, delegate { if (IsHandleCreated) BeginInvoke(new Action(ShowWindow)); }, null, -1, false);

            tailTimer.Interval = 500;
            tailTimer.Tick += delegate { Tail(); };
            statusTimer.Interval = 2000;
            statusTimer.Tick += delegate { CheckStatus(); };
        }

        Button MakeButton(string text, EventHandler onClick, bool primary)
        {
            var b = new Button
            {
                Text = text,
                AutoSize = true,
                FlatStyle = FlatStyle.Flat,
                BackColor = primary ? Color.FromArgb(37, 99, 235) : Color.FromArgb(30, 41, 70),
                ForeColor = Color.White,
                Margin = new Padding(4, 2, 4, 2),
                Padding = new Padding(8, 2, 8, 2),
                Height = 32,
            };
            b.FlatAppearance.BorderSize = 0;
            b.Click += onClick;
            return b;
        }

        protected override void SetVisibleCore(bool value)
        {
            // Started with --minimized (Windows sign-in): straight to the tray.
            if (startHidden && !IsHandleCreated) { CreateHandle(); value = false; }
            base.SetVisibleCore(value);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Tail();
            tailTimer.Start();
            statusTimer.Start();
            if (!serviceMode) StartServer();
            CheckStatus();
        }

        void StartServer()
        {
            if (serviceMode) { Service.Start(); CheckStatus(); return; }
            if (server.Running) return;
            int port = Paths.Port();
            if (PortTaken(port))
            {
                var answer = MessageBox.Show(this,
                    "Another program is already using port " + port + ".\n\nPortalCast may not open at http://localhost:" + port + " while it runs. Stop that program, or change PORT in Settings and start again.\n\nStart anyway?",
                    "PortalCast Server", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (answer != DialogResult.Yes) { CheckStatus(); return; }
            }
            var error = server.Start();
            if (error != null) MessageBox.Show(this, error, "PortalCast Server", MessageBoxButtons.OK, MessageBoxIcon.Error);
            CheckStatus();
        }

        void StopServer()
        {
            if (serviceMode) { Service.Stop(); CheckStatus(); return; }
            Cursor = Cursors.WaitCursor;
            try { server.Stop(); } finally { Cursor = Cursors.Default; }
            CheckStatus();
        }

        static bool PortTaken(int port)
        {
            try
            {
                foreach (var ep in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
                    if (ep.Port == port) return true;
            }
            catch (Exception) { }
            return false;
        }

        /// <summary>Running, starting or stopped, from the process and /api/health (off the UI thread).</summary>
        void CheckStatus()
        {
            if (checking) return;
            checking = true;
            int port = Paths.Port();
            bool own = server.Running;
            ThreadPool.QueueUserWorkItem(delegate
            {
                bool healthy = false;
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
                    req.Timeout = 1500;
                    req.Proxy = null;
                    using (var res = (HttpWebResponse)req.GetResponse())
                    using (var reader = new StreamReader(res.GetResponseStream()))
                        healthy = res.StatusCode == HttpStatusCode.OK && reader.ReadToEnd().Contains("\"ok\"");
                }
                catch (Exception) { }
                bool taken = !healthy && PortTaken(port);
                try
                {
                    BeginInvoke(new Action(delegate
                    {
                        checking = false;
                        string url = "http://localhost:" + port;
                        if (serviceMode)
                            status.Text = healthy ? "● Running as a background service" : "○ The background service is not running";
                        else if (own)
                            status.Text = healthy ? "● Running" : "◌ Starting…";
                        else if (healthy)
                            status.Text = "● Another PortalCast Server is already running";
                        else
                            status.Text = taken ? "○ Stopped — port " + port + " is used by another program" : "○ Stopped";
                        status.ForeColor = healthy ? Color.FromArgb(74, 222, 128) : taken ? Color.FromArgb(251, 191, 36) : MutedColor;
                        link.Text = healthy ? url : "";
                        startBtn.Enabled = serviceMode || !own;
                        stopBtn.Enabled = serviceMode || own;
                        tray.Text = "PortalCast Server — " + (healthy ? "running" : "stopped");
                    }));
                }
                catch (Exception) { checking = false; }
            });
        }

        /// <summary>Shows what was added to the log since the last look (the last 256 KB at first).</summary>
        void Tail()
        {
            try
            {
                if (!File.Exists(Paths.Log)) return;
                using (var fs = new FileStream(Paths.Log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    long len = fs.Length;
                    if (logPos < 0) logPos = Math.Max(0, len - 256 * 1024);
                    if (len < logPos) { logPos = 0; AppendLog("\r\n— log restarted —\r\n"); } // rotated
                    if (len == logPos) return;
                    fs.Seek(logPos, SeekOrigin.Begin);
                    var buf = new byte[Math.Min(len - logPos, 4 * 1024 * 1024)];
                    int n = fs.Read(buf, 0, buf.Length);
                    logPos += n;
                    var text = Ansi.Replace(Encoding.UTF8.GetString(buf, 0, n), "").Replace("\r\n", "\n").Replace("\n", "\r\n");
                    AppendLog(text);
                }
            }
            catch (Exception) { }
        }

        void AppendLog(string text)
        {
            // Keep the box to about 2 MB of text.
            if (log.TextLength > 2 * 1024 * 1024) log.Text = log.Text.Substring(log.TextLength / 2);
            log.AppendText(text);
        }

        void OpenBrowser()
        {
            try { Process.Start("http://localhost:" + Paths.Port()); } catch (Exception) { }
        }

        void OpenFile(string path)
        {
            if (!File.Exists(path)) { MessageBox.Show(this, "Not created yet: " + path + "\n\nStart the server once first.", "PortalCast Server"); return; }
            try { Process.Start("notepad.exe", "\"" + path + "\""); } catch (Exception) { }
        }

        void OpenFolder(string path)
        {
            try { Directory.CreateDirectory(path); Process.Start("explorer.exe", "\"" + path + "\""); } catch (Exception) { }
        }

        void ShowWindow()
        {
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        void Quit()
        {
            exiting = true;
            tray.Visible = false;
            if (!serviceMode) server.Stop();
            Application.Exit();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing)
            {
                exiting = true;
                tray.Visible = false;
                if (!serviceMode) server.Stop();
            }
            if (!exiting)
            {
                // The window closes to the tray; the server keeps running.
                e.Cancel = true;
                Hide();
                if (!toldAboutTray)
                {
                    toldAboutTray = true;
                    tray.ShowBalloonTip(4000, "PortalCast Server is still running",
                        "It is in the tray. Right-click its icon to open it or quit.", ToolTipIcon.Info);
                }
                return;
            }
            base.OnFormClosing(e);
        }
    }
}
