import CoreBluetooth
import Foundation

/// Verbinding met Bosch-lasermeters (GLM … C, PLR … C, AdvancedDistance 50C).
/// Zoekt een kenmerk 02a6c0dX met notify + write, zet notificaties aan en stuurt
/// het "auto-sync"-commando zodat elke meting automatisch doorkomt.
/// De ruwe bytes gaan naar de web-app, die ze ontleedt.
final class BoschBLE: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    struct Found {
        let peripheral: CBPeripheral
        let name: String
        var rssi: Int
    }

    var onStatus: ((String, String?) -> Void)?
    var onData: ((Data) -> Void)?
    var onLog: ((String) -> Void)?
    var choose: (([Found], @escaping (CBPeripheral?) -> Void) -> Void)?

    private var central: CBCentralManager!
    private var found: [UUID: Found] = [:]
    private var peripheral: CBPeripheral?
    private var peripheralName: String?
    private var channel: CBCharacteristic?
    private var wantScan = false
    private var manualClose = false
    private let autosync: [UInt8] = [0xC0, 0x55, 0x02, 0x01, 0x00, 0x1A]

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    func connect() {
        manualClose = false
        if central.state == .poweredOn {
            startScan()
        } else {
            wantScan = true
            onStatus?("busy", "Bluetooth starten…")
        }
    }

    func disconnect() {
        manualClose = true
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        onStatus?("off", nil)
    }

    func write(_ bytes: [UInt8]) {
        guard let p = peripheral, let c = channel else {
            onLog?("Schrijven mislukt: niet verbonden")
            return
        }
        let type: CBCharacteristicWriteType = c.properties.contains(.write) ? .withResponse : .withoutResponse
        p.writeValue(Data(bytes), for: c, type: type)
        onLog?("→ " + bytes.map { String(format: "%02x", $0) }.joined(separator: " "))
    }

    private func startScan() {
        found = [:]
        onStatus?("busy", "Zoeken…")
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { [weak self] in
            self?.finishScan()
        }
    }

    private func finishScan() {
        central.stopScan()
        let list = found.values.sorted { a, b in
            let ab = Self.looksBosch(a.name), bb = Self.looksBosch(b.name)
            if ab != bb { return ab }
            return a.rssi > b.rssi
        }
        if list.isEmpty {
            onLog?("Geen Bluetooth-toestellen gevonden")
            onStatus?("off", nil)
            return
        }
        choose?(list) { [weak self] p in
            guard let self = self else { return }
            guard let p = p else {
                self.onStatus?("off", nil)
                return
            }
            self.peripheralName = list.first(where: { $0.peripheral.identifier == p.identifier })?.name
            self.open(p)
        }
    }

    static func looksBosch(_ name: String) -> Bool {
        let u = name.uppercased()
        return u.hasPrefix("AD ") || u.hasPrefix("GLM") || u.hasPrefix("PLR") || u.contains("BOSCH")
    }

    private func open(_ p: CBPeripheral) {
        peripheral = p
        channel = nil
        p.delegate = self
        onStatus?("busy", "Verbinden…")
        central.connect(p, options: nil)
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if wantScan {
                wantScan = false
                startScan()
            }
        case .unauthorized:
            onLog?("Geen toestemming voor Bluetooth – zet het aan in Instellingen → Lasermeter")
            onStatus?("off", nil)
        case .poweredOff:
            onLog?("Bluetooth staat uit")
            onStatus?("off", nil)
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name
        guard let n = name, !n.isEmpty else { return }
        found[peripheral.identifier] = Found(peripheral: peripheral, name: n, rssi: RSSI.intValue)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        onLog?("Verbonden, services zoeken…")
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        onLog?("Verbinden mislukt: \(error?.localizedDescription ?? "onbekend")")
        onStatus?("off", nil)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        channel = nil
        onLog?("Verbinding verbroken")
        onStatus?("off", nil)
        if !manualClose {
            // iOS wacht tot de meter weer aan staat of in bereik is en verbindt dan vanzelf opnieuw
            central.connect(peripheral, options: nil)
        }
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        let services = peripheral.services ?? []
        onLog?("Services: " + services.map { $0.uuid.uuidString }.joined(separator: ", "))
        for s in services { peripheral.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard channel == nil else { return }
        for c in service.characteristics ?? [] {
            let id = c.uuid.uuidString.lowercased()
            let p = c.properties
            let canNotify = p.contains(.notify) || p.contains(.indicate)
            let canWrite = p.contains(.write) || p.contains(.writeWithoutResponse)
            if id.hasPrefix("02a6c0d") && canNotify && canWrite {
                channel = c
                onLog?("Meetkanaal: " + id)
                peripheral.setNotifyValue(true, for: c)
                return
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if let e = error {
            onLog?("Notificaties aanzetten mislukt: \(e.localizedDescription)")
            return
        }
        guard characteristic.isNotifying else { return }
        write(autosync)
        onStatus?("on", peripheralName ?? peripheral.name)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let v = characteristic.value else { return }
        onData?(v)
    }
}
