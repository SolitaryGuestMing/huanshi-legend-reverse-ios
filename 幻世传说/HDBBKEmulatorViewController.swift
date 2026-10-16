//
//  HDBBKEmulatorViewController.swift
//  幻世传说
//
//  步步高外语通 9188/9288「幻世传说」模拟器:
//  WKWebView 通过自定义 scheme(bbk-local://) 加载 bundle 内 bbk-emulator 目录
//  (index.html + mips.js + os.js + realtime.js + hss.exe + font.bin)。
//  用 scheme handler 而非 loadHTMLString, 是为了让相对资源(<script src>)与 fetch('hss.exe')
//  都走同源、拿到带 Content-Type 的 HTTPURLResponse。全部虚拟按键由 HTML 提供。
//  独立版: 直接继承 UIViewController(不依赖 FMJ App 的 HDBaseViewController)。
//
import UIKit
import WebKit

class HDBBKEmulatorViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {

    private var webView: WKWebView!
    private var schemeHandler: BBKLocalSchemeHandler!
    private let activity = UIActivityIndicatorView(style: .large)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        title = "幻世传说"
        setupWebView()
        setupLoading()
    }

    // MARK: - WebView
    private func setupWebView() {
        let cfg = WKWebViewConfiguration()
        schemeHandler = BBKLocalSchemeHandler(root: bbkRootURL())
        cfg.setURLSchemeHandler(schemeHandler, forURLScheme: "bbk-local")

        webView = WKWebView(frame: view.bounds, configuration: cfg)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = true
        webView.backgroundColor = .black
        if #available(iOS 11.0, *) {
            webView.scrollView.contentInsetAdjustmentBehavior = .never
        }
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        view.addSubview(webView)

        if let url = URL(string: "bbk-local://hss/index.html") {
            webView.load(URLRequest(url: url))
        }
    }

    /// bbk-emulator 目录 URL(index.html 的父目录)
    private func bbkRootURL() -> URL {
        if let idx = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "bbk-emulator") {
            return idx.deletingLastPathComponent()
        }
        let res = Bundle.main.resourceURL ?? URL(fileURLWithPath: "/")
        return res.appendingPathComponent("bbk-emulator", isDirectory: true)
    }

    private func setupLoading() {
        activity.color = .white
        activity.hidesWhenStopped = true
        activity.frame = CGRect(x: 0, y: 0, width: 60, height: 60)
        activity.center = view.center
        activity.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleTopMargin, .flexibleBottomMargin]
        view.addSubview(activity)
        activity.startAnimating()
    }

    // MARK: - Orientation (横竖屏都要, 跟随设备旋转)
    override var shouldAutorotate: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        return [.portrait, .landscapeLeft, .landscapeRight]
    }

    // MARK: - WKNavigationDelegate
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 自动点击"装载并开始"触发 boot()(boot 在 realtime.js 的 IIFE 内, 只能经 #run 按钮 click 进入)
        webView.evaluateJavaScript("var b=document.getElementById('run'); if(b && !b.__clicked){ b.__clicked=1; b.click(); }", completionHandler: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            self.activity.stopAnimating()
        }
    }
}

/// 把 bbk-local://hss/<path> 映射到 bundle 内 bbk-emulator 目录的对应文件,
/// 返回带正确 Content-Type 的 HTTPURLResponse(供 <script src> 与 fetch('hss.exe'/'font.bin') 使用)。
final class BBKLocalSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL
    init(root: URL) { self.root = root }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: "bbk-local", code: -1))
            return
        }
        var rel = url.path
        if rel.hasPrefix("/") { rel.removeFirst() }
        if rel.isEmpty { rel = "index.html" }

        let fileURL = root.appendingPathComponent(rel)
        guard let data = try? Data(contentsOf: fileURL) else {
            let resp = HTTPURLResponse(url: url, statusCode: 404,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/plain"])!
            urlSchemeTask.didReceive(resp)
            urlSchemeTask.didReceive("404 \(rel)".data(using: .utf8)!)
            urlSchemeTask.didFinish()
            return
        }

        let mime = BBKLocalSchemeHandler.mimeType(forExt: fileURL.pathExtension.lowercased())
        let resp = HTTPURLResponse(url: url, statusCode: 200,
                                   httpVersion: "HTTP/1.1",
                                   headerFields: [
                                    "Content-Type": mime,
                                    "Content-Length": "\(data.count)",
                                    "Cache-Control": "no-store",
                                    "Access-Control-Allow-Origin": "*"
                                   ])!
        urlSchemeTask.didReceive(resp)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private static func mimeType(forExt ext: String) -> String {
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs":   return "application/javascript; charset=utf-8"
        case "css":         return "text/css; charset=utf-8"
        case "json":        return "application/json; charset=utf-8"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "bin", "exe":  return "application/octet-stream"
        default:            return "application/octet-stream"
        }
    }
}
