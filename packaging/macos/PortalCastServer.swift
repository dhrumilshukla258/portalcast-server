// PortalCast Server for macOS: the app people open (owner 2026-10-28: "an app that starts the
// server, with a window showing its logs, like Jellyfin"). Built by packaging/macos/build-dmg.sh:
//   swiftc -O -o "PortalCast Server" PortalCastServer.swift -framework AppKit
//
// The server runs as a per-user LaunchAgent (~/Library/LaunchAgents/com.portalcast.server.plist:
// starts at login, restarted if it stops), so it keeps running with the window closed. This app
// starts and stops that agent, shows the log (~/Library/Logs/PortalCast/server.log), the status
// (from /api/health) and lives in the menu bar.

import AppKit

let label = "com.portalcast.server"
let home = FileManager.default.homeDirectoryForCurrentUser
let support = home.appendingPathComponent("Library/Application Support/PortalCast")
let configFile = support.appendingPathComponent("portalcast.env")
let firstRunFile = support.appendingPathComponent("FIRST-RUN.txt")
let logDir = home.appendingPathComponent("Library/Logs/PortalCast")
let logFile = logDir.appendingPathComponent("server.log")
let agentFile = home.appendingPathComponent("Library/LaunchAgents/\(label).plist")
let resources = Bundle.main.resourceURL!.appendingPathComponent("portalcast")
let nodeBin = resources.appendingPathComponent("node/bin/node")
let launcher = resources.appendingPathComponent("launcher.js")

/// PORT from the settings file, else 3000.
func port() -> Int {
    guard let text = try? String(contentsOf: configFile, encoding: .utf8) else { return 3000 }
    for raw in text.split(separator: "\n") {
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("PORT="), let p = Int(line.dropFirst(5).trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))), p > 0, p < 65536 { return p }
    }
    return 3000
}

@discardableResult
func run(_ path: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
}

let uid = String(getuid())

/// Writes the agent (start at login, keep alive) and loads it.
func startServer() {
    try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
    try? FileManager.default.createDirectory(at: agentFile.deletingLastPathComponent(), withIntermediateDirectories: true)
    run(nodeBin.path, [launcher.path, "--init-config"])
    let plist: [String: Any] = [
        "Label": label,
        "ProgramArguments": [nodeBin.path, launcher.path, "--log-file", logFile.path],
        "WorkingDirectory": resources.appendingPathComponent("app").path,
        "RunAtLoad": true,
        "KeepAlive": true,
        // The launcher writes the log itself; launchd keeps only what escapes it.
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": logDir.appendingPathComponent("launchd.log").path,
    ]
    if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
        try? data.write(to: agentFile)
    }
    run("/bin/launchctl", ["bootout", "gui/\(uid)/\(label)"])
    run("/bin/launchctl", ["bootstrap", "gui/\(uid)", agentFile.path])
}

/// Unloads the agent and removes it, so it does not start at the next login either.
func stopServer() {
    run("/bin/launchctl", ["bootout", "gui/\(uid)/\(label)"])
    try? FileManager.default.removeItem(at: agentFile)
}

func agentInstalled() -> Bool { FileManager.default.fileExists(atPath: agentFile.path) }

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let statusLabel = NSTextField(labelWithString: "Starting…")
    let urlButton = NSButton(title: "", target: nil, action: nil)
    var logView: NSTextView!
    var statusItem: NSStatusItem!
    var logOffset: UInt64 = 0
    var started = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenuBar()
        buildWindow()
        // First open, or the server was stopped: start it (as opening the old app did).
        if !agentInstalled() { startServer() }
        let firstRunShown = support.appendingPathComponent("FIRST-RUN.txt.shown")
        if FileManager.default.fileExists(atPath: firstRunFile.path) && !FileManager.default.fileExists(atPath: firstRunShown.path) {
            NSWorkspace.shared.open(firstRunFile)
            FileManager.default.createFile(atPath: firstRunShown.path, contents: nil)
        }
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tail() }
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.checkStatus() }
        tail()
        checkStatus()
    }

    func buildMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "▶︎ PortalCast"
        let menu = NSMenu()
        menu.addItem(withTitle: "Open PortalCast", action: #selector(openBrowser), keyEquivalent: "o")
        menu.addItem(withTitle: "Show window", action: #selector(showWindow), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Start server", action: #selector(start), keyEquivalent: "")
        menu.addItem(withTitle: "Stop server", action: #selector(stop), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit this window app (the server keeps running)", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items where item.action != nil { item.target = self }
        statusItem.menu = menu
    }

    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 600),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "PortalCast Server"
        window.minSize = NSSize(width: 700, height: 400)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.appearance = NSAppearance(named: .darkAqua)

        statusLabel.font = .boldSystemFont(ofSize: 15)
        urlButton.isBordered = false
        urlButton.contentTintColor = .systemBlue
        urlButton.target = self
        urlButton.action = #selector(openBrowser)

        let buttons = NSStackView(views: [
            button("Open PortalCast", #selector(openBrowser)),
            button("Start", #selector(start)),
            button("Stop", #selector(stop)),
            button("Restart", #selector(restart)),
            button("Settings", #selector(openSettings)),
            button("Sign-in details", #selector(openFirstRun)),
            button("Logs folder", #selector(openLogs)),
        ])
        buttons.spacing = 8

        let scroll = NSTextView.scrollableTextView()
        logView = scroll.documentView as? NSTextView
        logView.isEditable = false
        logView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        logView.backgroundColor = NSColor(red: 0.043, green: 0.063, blue: 0.125, alpha: 1)
        logView.textColor = NSColor(red: 0.84, green: 0.886, blue: 1, alpha: 1)

        let header = NSStackView(views: [statusLabel, urlButton, buttons])
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = 8
        header.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 10, right: 16)
        let root = NSStackView(views: [header, scroll])
        root.orientation = .vertical
        root.spacing = 0
        scroll.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = root
        root.translatesAutoresizingMaskIntoConstraints = false
        scroll.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func button(_ title: String, _ action: Selector) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded
        return b
    }

    /// Adds what was written to the log since the last look (the last 256 KB at first).
    func tail() {
        guard let handle = try? FileHandle(forReadingFrom: logFile) else { return }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        if !started { logOffset = size > 262_144 ? size - 262_144 : 0; started = true }
        if size < logOffset { logOffset = 0 } // the log was rotated
        if size == logOffset { return }
        try? handle.seek(toOffset: logOffset)
        let data = handle.readData(ofLength: Int(min(size - logOffset, 4_194_304)))
        logOffset += UInt64(data.count)
        let text = String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        guard let storage = logView.textStorage else { return }
        if storage.length > 2_000_000 { storage.deleteCharacters(in: NSRange(location: 0, length: storage.length / 2)) }
        storage.append(NSAttributedString(string: text, attributes: [.font: logView.font!, .foregroundColor: logView.textColor!]))
        logView.scrollToEndOfDocument(nil)
    }

    func checkStatus() {
        let p = port()
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(p)/api/health")!)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { data, res, _ in
            let ok = (res as? HTTPURLResponse)?.statusCode == 200 && String(decoding: data ?? Data(), as: UTF8.self).contains("\"ok\"")
            DispatchQueue.main.async {
                let installed = agentInstalled()
                self.statusLabel.stringValue = ok ? "● Running" : installed ? "◌ Starting…" : "○ Stopped"
                self.statusLabel.textColor = ok ? .systemGreen : .secondaryLabelColor
                self.urlButton.title = ok ? "http://localhost:\(p)" : ""
                self.statusItem.button?.title = ok ? "▶︎ PortalCast" : "■ PortalCast"
            }
        }.resume()
    }

    @objc func openBrowser() { NSWorkspace.shared.open(URL(string: "http://localhost:\(port())")!) }
    @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func start() { startServer(); checkStatus() }
    @objc func stop() { stopServer(); checkStatus() }
    @objc func restart() { stopServer(); startServer(); checkStatus() }
    @objc func openSettings() { open(configFile) }
    @objc func openFirstRun() { open(firstRunFile) }
    @objc func openLogs() {
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(logDir)
    }
    @objc func quit() { NSApp.terminate(nil) }

    func open(_ file: URL) {
        if FileManager.default.fileExists(atPath: file.path) {
            NSWorkspace.shared.open([file], withApplicationAt: URL(fileURLWithPath: "/System/Applications/TextEdit.app"), configuration: NSWorkspace.OpenConfiguration())
        } else {
            let alert = NSAlert()
            alert.messageText = "Not created yet"
            alert.informativeText = "\(file.path)\n\nStart the server once first."
            alert.runModal()
        }
    }

    // The window closes; the app stays in the menu bar and the server keeps running.
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
