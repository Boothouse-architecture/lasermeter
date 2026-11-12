import RoomPlan
import UIKit

/// Ruimte scannen met LiDAR via Apple RoomPlan.
/// Geeft muren, deuren, ramen en openingen als JSON door aan de web-app,
/// die er een plan van maakt (Geo.roomFromScan).
final class ScanViewController: UIViewController, RoomCaptureViewDelegate {
    var onFinish: ((String?) -> Void)?

    private var captureView: RoomCaptureView!
    private var result: CapturedRoom?
    private var stopped = false
    private let doneButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        captureView = RoomCaptureView(frame: view.bounds)
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        captureView.delegate = self
        view.addSubview(captureView)

        style(cancelButton, title: "Annuleren", color: UIColor(white: 0.15, alpha: 0.85))
        style(doneButton, title: "Klaar", color: UIColor(red: 0.04, green: 0.48, blue: 0.24, alpha: 1))
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)

        NSLayoutConstraint.activate([
            cancelButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            cancelButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            doneButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            doneButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    private func style(_ b: UIButton, title: String, color: UIColor) {
        var cfg = UIButton.Configuration.filled()
        cfg.title = title
        cfg.cornerStyle = .capsule
        cfg.baseBackgroundColor = color
        cfg.baseForegroundColor = .white
        b.configuration = cfg
        b.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(b)
    }

    private func setDone(_ title: String, enabled: Bool) {
        var cfg = doneButton.configuration
        cfg?.title = title
        doneButton.configuration = cfg
        doneButton.isEnabled = enabled
    }

    @objc private func cancelTapped() {
        if !stopped { captureView.captureSession.stop() }
        onFinish?(nil)
    }

    @objc private func doneTapped() {
        if !stopped {
            stopped = true
            captureView.captureSession.stop()
            setDone("Verwerken…", enabled: false)
        } else if let r = result {
            onFinish?(Self.export(r))
        }
    }

    // MARK: - RoomCaptureViewDelegate

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        result = processedResult
        setDone("Gebruik scan", enabled: true)
    }

    // MARK: - Export naar JSON

    static func export(_ room: CapturedRoom) -> String {
        func wall(_ s: CapturedRoom.Surface) -> [String: Double] {
            let c = s.transform.columns.3, ax = s.transform.columns.0
            return [
                "cx": Double(c.x), "cy": Double(c.y), "cz": Double(c.z),
                "ax": Double(ax.x), "az": Double(ax.z),
                "w": Double(s.dimensions.x), "h": Double(s.dimensions.y),
            ]
        }
        func opening(_ s: CapturedRoom.Surface, _ type: String) -> [String: Any] {
            let c = s.transform.columns.3
            return [
                "type": type, "cx": Double(c.x), "cy": Double(c.y), "cz": Double(c.z),
                "w": Double(s.dimensions.x), "h": Double(s.dimensions.y),
            ]
        }
        var openings: [[String: Any]] = []
        openings += room.doors.map { opening($0, "deur") }
        openings += room.windows.map { opening($0, "raam") }
        openings += room.openings.map { opening($0, "opening") }
        let obj: [String: Any] = ["walls": room.walls.map(wall), "openings": openings]
        guard let d = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }
}
