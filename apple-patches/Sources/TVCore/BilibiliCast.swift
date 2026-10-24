#if os(tvOS) || os(macOS)
import Foundation
import Network
import Darwin

/// Receives casts (投屏) from the Bilibili phone app, the way Bilibili's own TV app does.
///
/// The phone finds TVs with SSDP: this answers its M-SEARCH and announces itself as a UPnP media
/// renderer that also offers Bilibili's NirvanaControl service. The phone then reads the device
/// description over HTTP and opens `SETUP /projection`, after which the same TCP connection carries
/// Bilibili's binary "NVA" frames: commands such as Play, Pause, Seek and Stop from the phone, and
/// OnPlayState / OnProgress reports back to it.
///
/// Multicast needs no entitlement on tvOS or macOS (iOS would need Apple's multicast entitlement).
public final class BilibiliCastReceiver: @unchecked Sendable {
    public enum Event: Sendable, Equatable {
        /// A video part (aid, cid) or a PGC episode (episode id); ids Bilibili left out are 0.
        case play(aid: Int, cid: Int, episode: Int)
        /// A live room.
        case live(room: Int)
        /// A plain media address from a DLNA controller, with the title it sent.
        case media(URL, title: String)
        case pause, resume, stop
        case seek(Double)
        case danmaku(Bool)
    }
    public struct Status: Sendable, Equatable {
        public var playing: Bool
        public var position: Double
        public var duration: Double
        public init(playing: Bool, position: Double, duration: Double) { self.playing = playing; self.position = position; self.duration = duration }
    }

    public static let shared = BilibiliCastReceiver()
    /// Called on a background queue.
    public var onEvent: (@Sendable (Event) -> Void)?
    /// The name phones list this device under.
    public var name = "Yingxia"

    private static let group = "239.255.255.250"
    private static let ssdpPort: UInt16 = 1900
    private static let httpPort: UInt16 = 9958
    private static let server = "Linux/3.0.0 UPnP/1.0 Platinum/1.0.5.13"
    private let queue = DispatchQueue(label: "tvbox.bilibili.cast")
    private let uuid: String
    private var listener: NWListener?
    private var socket: Int32 = -1
    private var reader: DispatchSourceRead?
    private var announcer: DispatchSourceTimer?
    private var sessions: [ObjectIdentifier: NVASession] = [:]
    private var status: Status?
    private var reported: Status?
    /// When a DLNA controller last handed over media, which counts as loading until the player reports.
    private var loadingSince: Date?
    private var currentURI = ""

    private init() {
        // The form Bilibili's TV app uses: 35 upper-case letters and digits.
        let key = "bilibiliCastDeviceID"
        if let saved = UserDefaults.standard.string(forKey: key) { uuid = saved }
        else {
            let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
            uuid = String((0..<35).map { _ in letters.randomElement()! })
            UserDefaults.standard.set(uuid, forKey: key)
        }
    }

    public func start() { queue.async { self.startOnQueue() } }
    public func stop() { queue.async { self.stopOnQueue() } }

    /// The player's state, sent to connected phones as it changes and once a second while playing.
    public func update(_ status: Status?) {
        queue.async {
            self.status = status
            if status != nil { self.loadingSince = nil }
        }
    }

    // MARK: Lifecycle

    private func startOnQueue() {
        guard listener == nil else { return }
        do {
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: Self.httpPort)!)
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            Diagnostics.shared.record(.warning, "cast", "http listener failed: \(error)")
            return
        }
        openSSDP()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.5, repeating: 1)
        var tick = 0
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if tick % 5 == 0 { self.announce() }
            tick += 1
            self.reportStatus()
        }
        timer.resume()
        announcer = timer
        Diagnostics.shared.record(.info, "cast", "receiver started ssdp=\(socket >= 0) address=\(Self.localAddress() ?? "-")")
    }

    private func stopOnQueue() {
        announcer?.cancel(); announcer = nil
        reader?.cancel(); reader = nil
        if socket >= 0 { close(socket); socket = -1 }
        listener?.cancel(); listener = nil
        for session in sessions.values { session.connection.cancel() }
        sessions = [:]
    }

    // MARK: SSDP

    private func openSSDP() {
        let fd = Darwin.socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { return }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &yes, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = Self.ssdpPort.bigEndian
        address.sin_addr = in_addr(s_addr: INADDR_ANY)
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        // Join on the LAN interface itself: with a VPN up, "any" would pick the tunnel.
        let interface = Self.localAddress().map { in_addr(s_addr: inet_addr($0)) } ?? in_addr(s_addr: INADDR_ANY)
        var membership = ip_mreq(imr_multiaddr: in_addr(s_addr: inet_addr(Self.group)), imr_interface: interface)
        let joined = setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &membership, socklen_t(MemoryLayout<ip_mreq>.size))
        var outgoing = interface
        setsockopt(fd, IPPROTO_IP, IP_MULTICAST_IF, &outgoing, socklen_t(MemoryLayout<in_addr>.size))
        guard bound == 0, joined == 0 else {
            Diagnostics.shared.record(.warning, "cast", "ssdp unavailable bind=\(bound) join=\(joined) errno=\(errno)")
            close(fd); return
        }
        socket = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.receiveSSDP() }
        source.resume()
        reader = source
    }

    private func receiveSSDP() {
        var buffer = [UInt8](repeating: 0, count: 4096)
        var sender = sockaddr_storage()
        var length = socklen_t(MemoryLayout<sockaddr_storage>.size)
        let count = withUnsafeMutablePointer(to: &sender) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(socket, &buffer, buffer.count, 0, $0, &length) }
        }
        guard count > 0 else { return }
        let text = String(decoding: buffer[0..<count], as: UTF8.self)
        guard text.hasPrefix("M-SEARCH") else { return }
        let target = Self.header("ST", in: text) ?? ""
        // Answer the searches a Bilibili phone makes; other UPnP controllers may find us too.
        let known = ["ssdp:all", "upnp:rootdevice", "urn:schemas-upnp-org:device:MediaRenderer:1", "urn:app-bilibili-com:service:NirvanaControl:3",
                     "urn:schemas-upnp-org:service:AVTransport:1", "uuid:" + uuid]
        guard known.contains(target) || target.hasPrefix("urn:app-bilibili-com") else { return }
        guard let location = location() else { return }
        // Answered as Bilibili's TV app answers (and as the phone app recognises it): root device, with
        // the "atvbilibili&" device name, whatever was searched for.
        let reply = ["HTTP/1.1 200 OK", "LOCATION: \(location)", "CACHE-CONTROL: max-age=30", "SERVER: \(Self.server)", "EXT:",
                     "BOOTID.UPNP.ORG: 1669443520", "CONFIGID.UPNP.ORG: 10177363", "USN: uuid:atvbilibili&\(uuid)::upnp:rootdevice",
                     "ST: upnp:rootdevice", "DATE: \(Self.date())", "", ""].joined(separator: "\r\n")
        Self.log("ssdp answer to \(target)")
        let data = Array(reply.utf8)
        _ = withUnsafePointer(to: &sender) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sendto(socket, data, data.count, 0, $0, length) }
        }
    }

    private func announce() {
        guard socket >= 0, let location = location() else { return }
        var destination = sockaddr_in()
        destination.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        destination.sin_family = sa_family_t(AF_INET)
        destination.sin_port = Self.ssdpPort.bigEndian
        destination.sin_addr = in_addr(s_addr: inet_addr(Self.group))
        for kind in ["urn:schemas-upnp-org:device:MediaRenderer:1"] {
            let notify = ["NOTIFY * HTTP/1.1", "HOST: \(Self.group):\(Self.ssdpPort)", "CACHE-CONTROL: max-age=30", "LOCATION: \(location)",
                          "SERVER: \(Self.server)", "NTS: ssdp:alive", "NT: \(kind)", "USN: uuid:\(uuid)::\(kind)", "", ""].joined(separator: "\r\n")
            let data = Array(notify.utf8)
            _ = withUnsafePointer(to: &destination) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sendto(socket, data, data.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
        }
    }

    private func location() -> String? { Self.localAddress().map { "http://\($0):\(Self.httpPort)/description.xml" } }

    /// The first IPv4 address on a Wi-Fi or Ethernet interface.
    static func localAddress() -> String? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var found: [String: String] = [:]
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let entry = pointer.pointee
            guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET), entry.ifa_flags & UInt32(IFF_UP) != 0 else { continue }
            let name = String(cString: entry.ifa_name)
            guard name.hasPrefix("en") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            found[name] = String(decoding: host.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        }
        return found.keys.sorted().first.flatMap { found[$0] }
    }

    private static func header(_ name: String, in text: String) -> String? {
        for line in text.components(separatedBy: "\r\n") {
            guard let colon = line.firstIndex(of: ":"), line[..<colon].trimmingCharacters(in: .whitespaces).caseInsensitiveCompare(name) == .orderedSame else { continue }
            return line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    private static func date() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return formatter.string(from: Date())
    }

    // MARK: HTTP

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        readRequest(connection, buffer: Data())
    }

    private func readRequest(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if complete || error != nil || buffer.count > 65536 { connection.cancel() } else { self.readRequest(connection, buffer: buffer) }
                return
            }
            let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
            let rest = buffer[end.upperBound...]
            let length = Int(Self.header("Content-Length", in: head) ?? "") ?? 0
            if rest.count < length, !complete, error == nil { self.readRequest(connection, buffer: buffer); return }
            self.respond(connection, head: head, rest: Data(rest.prefix(length)), leftover: Data(rest.dropFirst(length)))
        }
    }

    private func respond(_ connection: NWConnection, head: String, rest: Data, leftover: Data) {
        if !head.contains("#GetTransportInfo"), !head.contains("#GetPositionInfo") {
            Self.log("http \(head.components(separatedBy: "\r\n").prefix(6).joined(separator: " | "))")
        }
        let line = head.components(separatedBy: "\r\n").first?.split(separator: " ").map(String.init) ?? []
        let method = line.first ?? "", path = line.count > 1 ? line[1].components(separatedBy: "?")[0] : ""
        func send(_ status: String, _ type: String = "text/xml; charset=\"utf-8\"", body: String = "") {
            let data = Data(body.utf8)
            let response = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(data.count)\r\nServer: \(Self.server)\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(response.utf8) + data, completion: .contentProcessed { _ in connection.cancel() })
        }
        switch (method, path) {
        case ("SETUP", "/projection"):
            // From here on the connection speaks NVA.
            let session = NVASession(connection: connection, receiver: self)
            sessions[ObjectIdentifier(session)] = session
            // The answer names the NVA protocol, not HTTP: Bilibili's phone app drops the session otherwise.
            let headers = ["NVA 200 OK", "Session: \(Self.header("Session", in: head) ?? "")", "NvaVersion: 1", "Connection: Keep-Alive",
                           "UUID: \(uuid)", "User-Agent: \(Self.server)", "", ""].joined(separator: "\r\n")
            connection.send(content: Data(headers.utf8), completion: .contentProcessed { _ in })
            Diagnostics.shared.record(.info, "cast", "phone connected")
            session.receive(leftover)
        case ("GET", "/description.xml"): send("200 OK", body: description())
        case ("GET", "/dlna/NirvanaControl.xml"):
            send("200 OK", body: "<actionList>\n<action>\n<name>GetAppInfo</name>\n<argumentList></argumentList>\n</action>\n</actionList>\n")
        case ("GET", "/dlna/AVTransport.xml"): send("200 OK", body: Self.scpd(actions: ["SetAVTransportURI", "Play", "Pause", "Stop", "Seek", "GetPositionInfo", "GetTransportInfo"]))
        case ("POST", _):
            // DLNA control (SOAP), which Bilibili's phone app uses for the cast itself.
            let soapAction = (Self.header("SOAPAction", in: head) ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "\" "))
            let service = soapAction.components(separatedBy: "#").first ?? "urn:schemas-upnp-org:service:AVTransport:1"
            let action = soapAction.components(separatedBy: "#").last ?? ""
            let fields = dlna(action, body: String(decoding: rest, as: UTF8.self))
            let values = fields.map { "<\($0.0)>\(Self.escape($0.1))</\($0.0)>" }.joined()
            send("200 OK", body: "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:\(action)Response xmlns:u=\"\(service)\">\(values)</u:\(action)Response></s:Body></s:Envelope>")
        default: send("404 Not Found", "text/plain")
        }
    }

    /// The phone app lists a receiver as a 云视听小电视 (its own TV app) only when the description says so:
    /// manufacturer, model description and the NirvanaControl service. The name it shows is `name`.
    // MARK: DLNA

    /// One AVTransport (or RenderingControl) action: acts on it and returns the response's fields.
    private func dlna(_ action: String, body: String) -> [(String, String)] {
        func value(_ name: String) -> String? {
            guard let range = body.range(of: "<\(name)>"), let end = body.range(of: "</\(name)>", range: range.upperBound..<body.endIndex) else { return nil }
            return Self.unescape(String(body[range.upperBound..<end.lowerBound]))
        }
        func clock(_ seconds: Double) -> String {
            let s = Int(seconds.isFinite ? max(0, seconds) : 0)
            return String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
        }
        switch action {
        case "SetAVTransportURI":
            let uri = value("CurrentURI") ?? ""
            let meta = value("CurrentURIMetaData") ?? ""
            Self.log("dlna uri \(uri.prefix(900)) | meta \(meta.prefix(600))")
            currentURI = uri
            loadingSince = Date()
            status = nil
            if let event = Self.castEvent(uri: uri, metadata: meta) { onEvent?(event) }
            return []
        case "Play":
            if status != nil { onEvent?(.resume) }
            return []
        case "Pause": onEvent?(.pause); return []
        case "Stop": loadingSince = nil; onEvent?(.stop); return []
        case "Seek":
            let target = (value("Target") ?? "").split(separator: ":").compactMap { Double($0) }.reduce(0) { $0 * 60 + $1 }
            onEvent?(.seek(target)); return []
        case "GetTransportInfo":
            let state: String
            if let status { state = status.playing ? "PLAYING" : "PAUSED_PLAYBACK" }
            else if let loadingSince, Date().timeIntervalSince(loadingSince) < 30 { state = "TRANSITIONING" }
            else { state = "STOPPED" }
            return [("CurrentTransportState", state), ("CurrentTransportStatus", "OK"), ("CurrentSpeed", "1")]
        case "GetPositionInfo":
            let duration = clock(status?.duration ?? 0), position = clock(status?.position ?? 0)
            return [("Track", "1"), ("TrackDuration", duration), ("TrackMetaData", ""), ("TrackURI", currentURI),
                    ("RelTime", position), ("AbsTime", position), ("RelCount", "2147483647"), ("AbsCount", "2147483647")]
        case "GetMediaInfo":
            return [("NrTracks", "1"), ("MediaDuration", clock(status?.duration ?? 0)), ("CurrentURI", currentURI), ("CurrentURIMetaData", ""),
                    ("NextURI", ""), ("NextURIMetaData", ""), ("PlayMedium", "NETWORK"), ("RecordMedium", "NOT_IMPLEMENTED"), ("WriteStatus", "NOT_IMPLEMENTED")]
        case "GetTransportSettings": return [("PlayMode", "NORMAL"), ("RecQualityMode", "NOT_IMPLEMENTED")]
        case "GetCurrentTransportActions": return [("Actions", "Play,Pause,Stop,Seek")]
        case "GetVolume": return [("CurrentVolume", "30")]
        default:
            Self.log("dlna action \(action) \(body.prefix(300))")
            return []
        }
    }

    /// What a DLNA address plays. Bilibili's phone app puts the video's ids in an `nva_ext` parameter;
    /// anything else is played as the media address it is.
    static func castEvent(uri: String, metadata: String) -> Event? {
        func int(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? Int(value as? String ?? "") ?? 0 }
        let components = URLComponents(string: uri)
        if let ext = components?.queryItems?.first(where: { $0.name == "nva_ext" })?.value,
           let object = try? JSONSerialization.jsonObject(with: Data(ext.utf8)) as? [String: Any] {
            let content = object["content"] as? [String: Any] ?? object
            let room = int(content["roomId"])
            if room > 0 { return .live(room: room) }
            let aid = int(content["aid"]), cid = int(content["cid"]), episode = int(content["epid"] ?? content["epId"])
            if aid > 0 || episode > 0 { return .play(aid: aid, cid: cid, episode: episode) }
        }
        guard let url = URL(string: uri), url.scheme == "http" || url.scheme == "https" else { return nil }
        var title = ""
        if let range = metadata.range(of: "<dc:title>"), let end = metadata.range(of: "</dc:title>", range: range.upperBound..<metadata.endIndex) {
            title = unescape(String(metadata[range.upperBound..<end.lowerBound]))
        }
        return .media(url, title: title)
    }

    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
    static func unescape(_ text: String) -> String {
        text.replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">").replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&apos;", with: "'").replacingOccurrences(of: "&amp;", with: "&")
    }

    private func description() -> String {
        func escape(_ text: String) -> String { Self.escape(text) }
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <root xmlns:dlna="urn:schemas-dlna-org:device-1-0" xmlns="urn:schemas-upnp-org:device-1-0">
        <specVersion><major>1</major><minor>0</minor></specVersion>
        <device>
        <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
        <UDN>uuid:\(uuid)</UDN>
        <friendlyName>\(escape(name))</friendlyName>
        <manufacturer>Bilibili Inc.</manufacturer>
        <manufacturerURL>https://bilibili.com/</manufacturerURL>
        <modelDescription>云视听小电视</modelDescription>
        <modelName>BRAVIA 4K 2015</modelName>
        <modelNumber>1024</modelNumber>
        <modelURL>https://app.bilibili.com/</modelURL>
        <serialNumber>1024</serialNumber>
        <X_brandName>ATV</X_brandName>
        <hostVersion>25</hostVersion>
        <ottVersion>105500</ottVersion>
        <channelName>master</channelName>
        <capability>255</capability>
        <dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>
        <dlna:X_DLNACAP>playcontainer-1-0</dlna:X_DLNACAP>
        <serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><serviceId>urn:upnp-org:serviceId:AVTransport</serviceId><controlURL>AVTransport/action</controlURL><eventSubURL>AVTransport/event</eventSubURL><SCPDURL>dlna/AVTransport.xml</SCPDURL></service>
        <service><serviceType>urn:app-bilibili-com:service:NirvanaControl:3</serviceType><serviceId>urn:app-bilibili-com:serviceId:NirvanaControl</serviceId><controlURL>NirvanaControl/action</controlURL><eventSubURL>NirvanaControl/event</eventSubURL><SCPDURL>dlna/NirvanaControl.xml</SCPDURL></service>
        </serviceList>
        </device>
        </root>
        """
    }

    private static func scpd(actions: [String]) -> String {
        "<?xml version=\"1.0\"?><scpd xmlns=\"urn:schemas-upnp-org:service-1-0\"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>"
            + actions.map { "<action><name>\($0)</name><argumentList></argumentList></action>" }.joined() + "</actionList></scpd>"
    }

    // MARK: NVA

    /// Recent cast traffic in Caches/bilibili-cast.log (tvOS keeps no other writable place), for diagnosing phones.
    public static func log(_ line: String) {
        let file = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("bilibili-cast.log")
        let stamp = ISO8601DateFormatter().string(from: Date())
        var text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        text += "\(stamp) \(line.prefix(1500))\n"
        if text.utf8.count > 200_000 { text = String(text.suffix(150_000)) }
        try? text.write(to: file, atomically: true, encoding: .utf8)
    }

    fileprivate func ended(_ session: NVASession) {
        Self.log("session ended")
        sessions[ObjectIdentifier(session)] = nil
        Diagnostics.shared.record(.info, "cast", "phone disconnected")
    }

    fileprivate func handle(_ action: String, body: [String: Any], session: NVASession) {
        Diagnostics.shared.record(.info, "cast", "command \(action)")
        Self.log("nva \(action) \((try? JSONSerialization.data(withJSONObject: body)).map { String(decoding: $0, as: UTF8.self) } ?? "")")
        func int(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? Int(value as? String ?? "") ?? 0 }
        func play(_ item: [String: Any]) -> Event {
            let room = int(item["roomId"])
            return room > 0 ? .live(room: room) : .play(aid: int(item["aid"]), cid: int(item["cid"]), episode: int(item["epid"] ?? item["epId"]))
        }
        switch action {
        case "GetVolume": session.reply(["volume": 30]); return
        case "Play":
            session.empty()
            onEvent?(play(body))
        case "PlayUrl":
            session.empty()
            // Older phones send a URL whose nva_ext parameter carries the same JSON as Play.
            if let address = body["url"] as? String, let ext = URLComponents(string: address)?.queryItems?.first(where: { $0.name == "nva_ext" })?.value,
               let object = try? JSONSerialization.jsonObject(with: Data(ext.utf8)) as? [String: Any], let content = object["content"] as? [String: Any] {
                onEvent?(play(content))
            }
        case "Pause": session.empty(); onEvent?(.pause)
        case "Resume": session.empty(); onEvent?(.resume)
        case "Stop": session.empty(); onEvent?(.stop)
        case "Seek": session.empty(); onEvent?(.seek(Double(int(body["seekTs"]))))
        case "SwitchDanmaku": session.empty(); onEvent?(.danmaku((body["open"] as? Bool) ?? true))
        default: session.empty()
        }
    }

    private func reportStatus() {
        guard !sessions.isEmpty, let status else { reported = status; return }
        if status.playing != reported?.playing {
            for session in sessions.values { session.command("OnPlayState", ["playState": status.playing ? 4 : 5]) }
        }
        if status.playing || status != reported {
            for session in sessions.values { session.command("OnProgress", ["duration": Int(status.duration), "position": Int(status.position)]) }
        }
        reported = status
    }
}

/// One phone's NVA connection. Frames: a kind byte (0xe0 command, 0xc0 reply, 0xe4 ping), a part
/// count, a 4-byte big-endian sequence number, then for commands a 0x01 marker, the length-prefixed
/// words "Command" and the action, and with three parts a 4-byte length and a JSON body.
final class NVASession: @unchecked Sendable {
    let connection: NWConnection
    private weak var receiver: BilibiliCastReceiver?
    private var buffer = Data()
    private var sequence: UInt32 = 0

    init(connection: NWConnection, receiver: BilibiliCastReceiver) { self.connection = connection; self.receiver = receiver }

    func receive(_ data: Data) {
        buffer.append(data)
        while let consumed = parse() { buffer.removeFirst(consumed) }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            if complete || error != nil { self.connection.cancel(); self.receiver?.ended(self); return }
            self.receive(data ?? Data())
        }
    }

    /// Handles one frame at the start of the buffer and returns its length, or nil when it is incomplete.
    private func parse() -> Int? {
        let bytes = [UInt8](buffer)
        func word(_ at: Int) -> Int { (at..<at + 4).reduce(0) { $0 << 8 | Int(bytes[$1]) } }
        guard bytes.count >= 6 else { return nil }
        let kind = bytes[0], parts = Int(bytes[1])
        sequence = UInt32(truncatingIfNeeded: word(2))
        var cursor = 6
        if parts == 0 { return cursor }
        if kind != 0xe0 { BilibiliCastReceiver.log("nva frame kind=\(String(format: "%02x", kind)) parts=\(parts) bytes=\(bytes.prefix(24).map { String(format: "%02x", $0) }.joined())") }
        if kind != 0xe0 {
            // A reply: a 4-byte length and a JSON body.
            guard bytes.count >= cursor + 4 else { return nil }
            let length = word(cursor); cursor += 4
            return bytes.count >= cursor + length ? cursor + length : nil
        }
        guard bytes.count >= cursor + 2 else { return nil }
        cursor += 1
        let commandLength = Int(bytes[cursor]); cursor += 1
        guard bytes.count >= cursor + commandLength + 1 else { return nil }
        cursor += commandLength
        if parts == 1 { return cursor }
        let actionLength = Int(bytes[cursor]); cursor += 1
        guard bytes.count >= cursor + actionLength else { return nil }
        let action = String(decoding: bytes[cursor..<cursor + actionLength], as: UTF8.self); cursor += actionLength
        var body: [String: Any] = [:]
        if parts >= 3 {
            guard bytes.count >= cursor + 4 else { return nil }
            let length = word(cursor); cursor += 4
            guard bytes.count >= cursor + length else { return nil }
            body = (try? JSONSerialization.jsonObject(with: Data(bytes[cursor..<cursor + length]))) as? [String: Any] ?? [:]
            cursor += length
        }
        receiver?.handle(action, body: body, session: self)
        return cursor
    }

    private func next() -> [UInt8] { sequence &+= 1; return withUnsafeBytes(of: sequence.bigEndian, Array.init) }
    private func length(_ count: Int) -> [UInt8] { withUnsafeBytes(of: UInt32(count).bigEndian, Array.init) }
    private func json(_ object: [String: Any]) -> [UInt8] { Array((try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)) }
    private func write(_ bytes: [UInt8]) { connection.send(content: Data(bytes), completion: .contentProcessed { _ in }) }

    func empty() { write([0xc0, 0x00] + next()) }
    func reply(_ object: [String: Any]) {
        // 拆分长数组拼接表达式，避免编译器类型检查超时（YunYing 补丁）
        let body = json(object)
        let head = [0xc0, 0x01] + next() + length(body.count)
        write(head + body)
    }
    func command(_ action: String, _ object: [String: Any]) {
        // 拆分长数组拼接表达式，避免编译器类型检查超时（YunYing 补丁）
        let body = json(object)
        let name = Array("Command".utf8)
        let verb = Array(action.utf8)
        let header = [0xe0, 0x03] + next()
        let meta = [UInt8(name.count)] + name + [UInt8(verb.count)] + verb
        let head = header + meta + length(body.count)
        write(head + body)
    }
}
#endif
