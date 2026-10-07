import Foundation
import CryptoKit
import Security

/// 卡密与机器码：对齐安卓 LicenseCrypto.kt。
///
/// 关键同构点（已逐条核对，保证安卓发的卡密在 iOS 上可验签）：
/// - 公钥是 X.509 SPKI DER，`P256.Signing.PublicKey(derRepresentation:)` 直接加载
/// - 签名是 raw r‖s 64 字节，对应 `P256.Signing.ECDSASignature(rawRepresentation:)`
/// - `isValidSignature(_:for:)` 内部先 SHA256 摘要再验签，与安卓 `SHA256withECDSA` 等价
struct License {

    static let cardPrefix = "ORB1"
    static let cardVersion = 1
    static let payloadLen = 15
    static let sigLen = 64

    /// 安卓侧内联的公钥（X.509 SPKI DER 的 base64）。公钥公开，可内联、可入库。
    static let publicKeyDERBase64 =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAExuVEOkY4RMcZNneycaDOidhUPKnh" +
        "rXqKZ0G4OYfo90y70uptjPPkP4XwZnoLb5K0WhvwcyDwgx9lV2x+zXC5Lg=="

    struct Ticket {
        let ok: Bool
        let code: String          // ok / format / signature / version / expired
        let version: Int
        let kind: Int
        let expireDays: Int
        let machine: String
        let cardSeq: Int
        var expireAt: Int         // 激活后的绝对到期时间戳（秒），0 表示未激活
    }

    // MARK: - 机器码（Keychain 持久化，重装保留、抹掉失效）

    /// iOS 合规的一机一码：不读设备标识（Apple 禁止），用 Keychain 持久化的随机 UUID 派生。
    /// 首次生成后永久不变，因 Keychain 在 App 重装后仍然保留（除非用户抹掉设备）。
    static func machineCode() -> String {
        if let cached = Keychain.string(forKey: "orbit_machine") { return cached }
        let seed = UUID().uuidString
        let hash = SHA256.hash(data: Data(seed.utf8))
        let bytes = Array(hash.prefix(8))
        let code = String(CrockfordBase32.encode(bytes).prefix(10))
        Keychain.set(code, forKey: "orbit_machine")
        return code
    }

    // MARK: - 卡密校验

    static func verifyCard(_ card: String) -> Ticket {
        let c = card.replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
        guard c.uppercased().hasPrefix(cardPrefix) else { return bad() }

        let rest = String(c.dropFirst(cardPrefix.count)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let parts = rest.split(separator: "-", maxSplits: 1)
        guard parts.count == 2 else { return bad() }
        let payloadB32 = String(parts[0]).uppercased()
        let sigB64 = String(parts[1])

        guard let payload = try? CrockfordBase32.decode(payloadB32, expectLen: payloadLen) else { return bad() }
        guard let sig = base64URLDecode(sigB64), sig.count == sigLen else { return bad() }

        // 验签
        guard let der = base64Decode(publicKeyDERBase64),
              let pub = try? P256.Signing.PublicKey(derRepresentation: der),
              let ecSig = try? P256.Signing.ECDSASignature(rawRepresentation: sig) else {
            return bad()
        }
        guard pub.isValidSignature(ecSig, for: Data(payload)) else {
            return Ticket(ok: false, code: "signature", version: 0, kind: 0,
                          expireDays: 0, machine: "", cardSeq: 0, expireAt: 0)
        }

        guard Int(payload[0]) == cardVersion else {
            return Ticket(ok: false, code: "version", version: Int(payload[0]), kind: 0,
                          expireDays: 0, machine: "", cardSeq: 0, expireAt: 0)
        }

        let version = Int(payload[0])
        let kind = Int(payload[1])
        let expireDays = (Int(payload[2]) << 8) | Int(payload[3])
        let machine = String(data: Data(Array(payload[4..<14])), encoding: .utf8) ?? ""
        let cardSeq = Int(payload[14])
        return Ticket(ok: true, code: "ok", version: version, kind: kind,
                      expireDays: expireDays, machine: machine, cardSeq: cardSeq, expireAt: 0)
    }

    static func bad() -> Ticket {
        return Ticket(ok: false, code: "format", version: 0, kind: 0,
                      expireDays: 0, machine: "", cardSeq: 0, expireAt: 0)
    }

    // MARK: - 激活

    /// 激活并落盘到 OrbitConfig.license。
    ///
    /// ⚠ 与安卓的策略差异（重要）：安卓机器码由 androidId 派生，iOS 由 Keychain 派生，
    /// 两者不同会导致安卓卡在 iOS 上「机器不匹配」而失效。iOS 这里**只验签 + 版本 + 过期**，
    /// 激活即生效，方便用户已有的安卓卡密直接在 iOS 上复用。如需平台隔离，将来可在 payload.kind 区分。
    static func activate(_ card: String) -> Ticket {
        let t = verifyCard(card)
        guard t.ok else { return t }
        let now = Int(Date().timeIntervalSince1970)
        let expireAt = now + t.expireDays * 86400
        OrbitConfig.shared.set([
            "state": "activated",
            "kind": t.kind,
            "cardSeq": t.cardSeq,
            "expireAt": expireAt,
            "machine": t.machine,
            "activatedAt": now,
            "lastActivatedMachine": machineCode()
        ], forKeyPath: "license")
        var r = t
        r.expireAt = expireAt
        return r
    }

    static func status() -> [String: Any] {
        let lic = OrbitConfig.shared.dictionary(forKeyPath: "license")
        let expireAt = lic["expireAt"] as? Int ?? 0
        let now = Int(Date().timeIntervalSince1970)
        var state = lic["state"] as? String ?? "idle"
        if state == "activated" && expireAt > 0 && expireAt < now {
            state = "expired"
        }
        return [
            "state": state,
            "kind": lic["kind"] as? Int ?? 0,
            "cardSeq": lic["cardSeq"] as? Int ?? 0,
            "expireAt": expireAt,
            "machine": machineCode(),
            "activatedAt": lic["activatedAt"] as? Int ?? 0
        ]
    }

    // MARK: - base64 辅助

    private static func base64Decode(_ s: String) -> Data? {
        return Data(base64Encoded: s)
    }

    private static func base64URLDecode(_ s: String) -> Data? {
        var t = s.trimmingCharacters(in: .whitespaces)
        let pad = String(repeating: "=", count: (4 - t.count % 4) % 4)
        return Data(base64Encoded: t + pad)
    }
}

/// Crockford Base32：对齐安卓 LicenseCrypto.ALPHABET（剔除 I L O U）。
/// 与安卓实现逐位同构，保证机器码/卡密编解码互通。
struct CrockfordBase32 {
    private static let alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    static func encode(_ data: [UInt8]) -> String {
        var out = ""
        var acc = 0
        var nbits = 0
        for b in data {
            acc = (acc << 8) | Int(b)
            nbits += 8
            while nbits >= 5 {
                nbits -= 5
                let idx = (acc >> nbits) & 31
                out.append(alphabet[alphabet.index(alphabet.startIndex, offsetBy: idx)])
            }
        }
        if nbits > 0 {
            let idx = (acc << (5 - nbits)) & 31
            out.append(alphabet[alphabet.index(alphabet.startIndex, offsetBy: idx)])
        }
        return out
    }

    static func decode(_ s: String, expectLen: Int = 0) throws -> [UInt8] {
        var cleaned = ""
        for ch in s {
            switch ch {
            case "I", "L": cleaned.append("1")
            case "O": cleaned.append("0")
            case "U": cleaned.append("V")
            case " ", "-", "_", ":": break
            default: cleaned.append(ch.uppercased())
            }
        }
        var out: [UInt8] = []
        var acc = 0
        var nbits = 0
        for ch in cleaned {
            guard let idx = alphabet.firstIndex(of: ch) else {
                throw NSError(domain: "License", code: -1, userInfo: nil)
            }
            let v = alphabet.distance(from: alphabet.startIndex, to: idx)
            acc = (acc << 5) | v
            nbits += 5
            if nbits >= 8 {
                nbits -= 8
                out.append(UInt8((acc >> nbits) & 0xFF))
            }
        }
        if expectLen > 0 && out.count < expectLen { throw NSError(domain: "License", code: -2, userInfo: nil) }
        if expectLen > 0 && out.count > expectLen { return Array(out.prefix(expectLen)) }
        return out
    }
}

/// Keychain 轻量封装：仅存字符串（机器码）。不依赖任何设备标识，符合 Apple 规则。
enum Keychain {
    static func string(forKey key: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var ref: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &ref) == errSecSuccess,
              let data = ref as? Data,
              let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }

    static func set(_ value: String, forKey key: String) {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: key
        ]
        SecItemDelete(query as CFDictionary)
        let add: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: key,
            kSecValueData: value.data(using: .utf8) ?? Data()
        ]
        SecItemAdd(add as CFDictionary, nil)
    }
}
