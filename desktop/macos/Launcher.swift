import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private let appName = "Shark Clip"
    private var window: NSWindow!
    private var webView: WKWebView!
    private var process: Process?
    private var backendInput: FileHandle?
    private var nativeDialogOpen = false
    private var stdoutBuffer = Data()
    private var appURL: URL?
    private var isClosing = false
    private var started = false
    private var timeout: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 850),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = appName
        window.minSize = NSSize(width: 760, height: 620)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("<!doctype html><html lang='zh-CN'><meta charset='utf-8'><body style='font:18px system-ui;padding:32px;color:#141414;background:#fff'>正在启动 \(appName)…</body></html>", baseURL: nil)
        startBackend()
    }

    private func makeMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 \(appName)", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let edit = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu
        menu.addItem(edit)
        NSApp.mainMenu = menu
    }

    @objc private func showAbout() {
        let alert = NSAlert()
        alert.messageText = "\(appName) · 预览版"
        alert.informativeText = "在你的电脑上从自己的云盘提取视频片段。\n\n运行时、媒体工具和开源许可随安装包附带。此版本尚未完成 Apple 开发者签名与公证；发行目标仅为 M 系列 Mac 与 Windows x64，Windows 仍需真机验收。"
        alert.runModal()
    }

    private func startBackend() {
        guard let resources = Bundle.main.resourceURL else { showError("安装包资源缺失。"); return }
        let backend = Process()
        backend.executableURL = resources.appendingPathComponent("app/bin/node")
        backend.arguments = [resources.appendingPathComponent("app/desktop/main.mjs").path]
        backend.currentDirectoryURL = resources.appendingPathComponent("app")
        var environment = ProcessInfo.processInfo.environment
        for key in ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "CLIP_FETCHER_PORT", "CLIP_FETCHER_OUTPUT_DIR", "CLIP_FETCHER_DATA_DIR", "CLIP_FETCHER_NATIVE_DIALOGS"] { environment.removeValue(forKey: key) }
        environment["HOME"] = NSHomeDirectory()
        environment["CLIP_FETCHER_NATIVE_DIALOGS"] = "1"
        environment["CLIP_FETCHER_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        environment["PATH"] = resources.appendingPathComponent("app/bin").path + ":/usr/bin:/bin:/usr/sbin:/sbin"
        backend.environment = environment
        let output = Pipe()
        let errors = Pipe()
        backend.standardOutput = output
        backend.standardError = errors
        let input = Pipe()
        backend.standardInput = input
        backendInput = input.fileHandleForWriting
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consumeOutput(data) }
        }
        // Drain stderr but do not persist URLs, tokens, filenames or login data.
        errors.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }
        backend.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard let self = self, !self.isClosing else { return }
                self.showError("本机取材服务已停止（退出代码 \(child.terminationStatus)）。请退出后重新打开；未完成的任务需要重新提交。")
            }
        }
        do { try backend.run(); process = backend }
        catch { showError("无法启动安装包内的运行环境。请确认安装包已完整解压，并使用适合这台 Mac 的版本。"); return }
        let timer = DispatchWorkItem { [weak self] in
            guard let self = self, !self.started else { return }
            self.showError("本机取材服务启动超时。请退出后重新打开。")
        }
        timeout = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: timer)
    }

    private func consumeOutput(_ data: Data) {
        stdoutBuffer.append(data)
        if stdoutBuffer.count > 8192 { showError("启动信息格式异常。"); return }
        while let end = stdoutBuffer.firstIndex(of: 10) {
            let lineData = stdoutBuffer.prefix(upTo: end)
            stdoutBuffer.removeSubrange(...end)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            if line.hasPrefix("CLIP_FETCHER_NATIVE_REQUEST=") {
                handleNativeRequest(String(line.dropFirst("CLIP_FETCHER_NATIVE_REQUEST=".count)))
                continue
            }
            if line == "CLIP_FETCHER_FOCUS=1", started, !isClosing {
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                continue
            }
            if started { continue }
            if line.hasPrefix("CLIP_FETCHER_ALREADY_RUNNING=") {
                isClosing = true
                timeout?.cancel()
                let alert = NSAlert()
                alert.messageText = "\(appName) 已经在运行"
                alert.informativeText = "请使用已有应用窗口。重复启动不会创建第二个取材服务。"
                alert.addButton(withTitle: "好")
                alert.runModal()
                NSApp.terminate(nil)
                return
            }
            guard line.hasPrefix("CLIP_FETCHER_URL=") else { continue }
            let raw = String(line.dropFirst("CLIP_FETCHER_URL=".count))
            guard let url = URL(string: raw), url.scheme == "http", url.host == "127.0.0.1", let port = url.port,
                  port > 0 && port <= 65535, url.user == nil, url.password == nil,
                  (url.path.isEmpty || url.path == "/"), url.query == nil, url.fragment == nil else {
                showError("本机服务返回了无效地址。"); return
            }
            started = true
            appURL = url
            timeout?.cancel()
            webView.load(URLRequest(url: url))
            break
        }
    }

    private func nativeResponse(_ id: String, path: String?) {
        guard let input = backendInput, process?.isRunning == true else { return }
        let response: [String: Any] = ["id": id, "path": path as Any? ?? NSNull()]
        guard var data = try? JSONSerialization.data(withJSONObject: response) else { return }
        data.append(10)
        try? input.write(contentsOf: data)
    }

    private func handleNativeRequest(_ raw: String) {
        guard started, !isClosing, let data = raw.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let id = request["id"] as? String, UUID(uuidString: id) != nil,
              let kind = request["kind"] as? String, ["file", "directory"].contains(kind) else { return }
        if nativeDialogOpen { nativeResponse(id, path: nil); return }
        nativeDialogOpen = true
        // A user may also open this local panel in their browser. Bring the
        // owning window forward so its chooser cannot remain hidden behind it.
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = kind == "directory"
        panel.canChooseFiles = kind == "file"
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = kind == "directory"
        panel.message = kind == "directory" ? "选择素材保存文件夹" : "选择用于取片的本地视频"
        panel.prompt = "选择"
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self = self else { return }
            self.nativeDialogOpen = false
            self.nativeResponse(id, path: result == .OK ? panel.url?.path : nil)
        }
    }

    private func sameOrigin(_ url: URL) -> Bool {
        guard let local = appURL else { return false }
        return url.scheme == local.scheme && url.host == local.host && url.port == local.port && url.user == nil && url.password == nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.absoluteString == "about:blank" || sameOrigin(url) { decisionHandler(.allow); return }
        // Only a deliberate click may open a normal HTTPS link in the system browser.
        // The app never embeds cloud login pages or exposes a JavaScript native bridge.
        if action.navigationType == .linkActivated && url.scheme == "https" && url.user == nil && url.password == nil {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, action.navigationType == .linkActivated {
            if sameOrigin(url) { webView.load(URLRequest(url: url)) }
            else if url.scheme == "https" && url.user == nil && url.password == nil { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    private func showError(_ message: String) {
        guard !isClosing else { return }
        timeout?.cancel()
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "\(appName) 暂时无法运行"
        alert.informativeText = message
        alert.addButton(withTitle: "退出")
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        isClosing = true
        timeout?.cancel()
        if let child = process, child.isRunning {
            child.terminate()
            // The Node backend owns cancellation/cleanup and has a bounded shutdown.
        }
        webView?.stopLoading()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
