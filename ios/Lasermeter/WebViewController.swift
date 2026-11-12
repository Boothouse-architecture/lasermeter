import CoreBluetooth
import RoomPlan
import UIKit
import WebKit

/// Zwakke verwijzing zodat WKUserContentController de controller niet vasthoudt.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}

final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var web: WKWebView!
    private let ble = BoschBLE()
    private let haptic = UIImpactFeedbackGenerator(style: .medium)

    static let storageKeys = ["lasermeter.projects.v1", "lasermeter.metingen.v1"]

    override func loadView() {
        let ucc = WKUserContentController()
        ucc.add(WeakHandler(self), name: "lasermeter")
        ucc.addUserScript(WKUserScript(source: Self.bootScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let cfg = WKWebViewConfiguration()
        cfg.userContentController = ucc
        cfg.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        if #available(iOS 16.4, *) { web.isInspectable = true }
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        ble.onStatus = { [weak self] state, name in
            self?.js("LasermeterNative.onStatus(\(Self.q(state)), \(Self.q(name ?? "")))")
        }
        ble.onData = { [weak self] data in
            let hex = data.map { String(format: "%02x", $0) }.joined()
            self?.js("LasermeterNative.onData('\(hex)')")
        }
        ble.onLog = { [weak self] msg in
            self?.js("LasermeterNative.onLog(\(Self.q(msg)))")
        }
        ble.choose = { [weak self] list, done in
            self?.chooseDevice(list, done)
        }
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
    }

    // MARK: - JavaScript

    /// Tekst als JSON-string (veilig om in JavaScript te plakken).
    static func q(_ s: String) -> String {
        if let d = try? JSONSerialization.data(withJSONObject: [s]), let str = String(data: d, encoding: .utf8) {
            return String(str.dropFirst().dropLast())
        }
        return "\"\""
    }

    private func js(_ code: String) {
        web.evaluateJavaScript("try{\(code)}catch(e){}", completionHandler: nil)
    }

    // MARK: - Opslag (bestanden in Documenten, zichtbaar in de Bestanden-app)

    static var docs: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }

    static func file(for key: String) -> URL {
        docs.appendingPathComponent(key.replacingOccurrences(of: ".", with: "-") + ".json")
    }

    /// Wordt vóór de pagina uitgevoerd: mogelijkheden doorgeven en opgeslagen data terugzetten
    /// als de webopslag leeg zou zijn.
    static func bootScript() -> String {
        var store: [String: String] = [:]
        for key in storageKeys {
            if let s = try? String(contentsOf: file(for: key), encoding: .utf8) { store[key] = s }
        }
        let caps: [String: Any] = ["scan": RoomCaptureSession.isSupported, "platform": "ios"]
        let storeJSON = (try? JSONSerialization.data(withJSONObject: store)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let capsJSON = (try? JSONSerialization.data(withJSONObject: caps)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return """
        window.__lasermeterNative = \(capsJSON);
        (function () {
          var d = \(storeJSON);
          for (var k in d) { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, d[k]); } catch (e) {} }
        })();
        """
    }

    // MARK: - Berichten vanuit de web-app

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "connect":
            ble.connect()
        case "disconnect":
            ble.disconnect()
        case "write":
            if let h = body["hex"] as? String { ble.write(Self.bytes(h)) }
        case "haptic":
            haptic.impactOccurred()
        case "persist":
            if let k = body["key"] as? String, let v = body["value"] as? String, Self.storageKeys.contains(k) {
                try? v.write(to: Self.file(for: k), atomically: true, encoding: .utf8)
            }
        case "share":
            if let name = body["name"] as? String, let b64 = body["base64"] as? String,
               let data = Data(base64Encoded: b64) {
                share(name: name, data: data)
            }
        case "scan":
            startScan()
        default:
            break
        }
    }

    static func bytes(_ hex: String) -> [UInt8] {
        var out: [UInt8] = []
        var i = hex.startIndex
        while let j = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex), i < hex.endIndex {
            if let b = UInt8(hex[i..<j], radix: 16) { out.append(b) }
            i = j
        }
        return out
    }

    // MARK: - Delen

    private func share(name: String, data: Data) {
        let safe = name.replacingOccurrences(of: "/", with: "_")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safe)
        do { try data.write(to: url, options: .atomic) } catch { return }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        anchor(vc.popoverPresentationController)
        present(vc, animated: true)
    }

    private func anchor(_ pop: UIPopoverPresentationController?) {
        guard let pop = pop else { return }
        pop.sourceView = view
        pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        pop.permittedArrowDirections = []
    }

    // MARK: - Toestel kiezen

    private func chooseDevice(_ list: [BoschBLE.Found], _ done: @escaping (CBPeripheral?) -> Void) {
        let ac = UIAlertController(title: "Kies je lasermeter", message: "Bosch-toestellen staan bovenaan.", preferredStyle: .actionSheet)
        for f in list.prefix(12) {
            ac.addAction(UIAlertAction(title: f.name, style: .default) { _ in done(f.peripheral) })
        }
        ac.addAction(UIAlertAction(title: "Annuleren", style: .cancel) { _ in done(nil) })
        anchor(ac.popoverPresentationController)
        present(ac, animated: true)
    }

    // MARK: - LiDAR-scan

    private func startScan() {
        guard RoomCaptureSession.isSupported else {
            js("LasermeterNative.onScanError('Dit toestel heeft geen LiDAR-sensor')")
            return
        }
        let vc = ScanViewController()
        vc.modalPresentationStyle = .fullScreen
        vc.onFinish = { [weak self] json in
            guard let self = self else { return }
            self.dismiss(animated: true)
            if let json = json { self.js("LasermeterNative.onScan(\(Self.q(json)))") }
        }
        present(vc, animated: true)
    }
}
