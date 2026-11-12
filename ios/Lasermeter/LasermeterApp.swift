import SwiftUI

@main
struct LasermeterApp: App {
    var body: some Scene {
        WindowGroup {
            WebContainer().ignoresSafeArea()
        }
    }
}

/// Toont de web-app (index.html, app.js, geo.js) in een WKWebView met native bruggen.
struct WebContainer: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebViewController { WebViewController() }
    func updateUIViewController(_ uiViewController: WebViewController, context: Context) {}
}
