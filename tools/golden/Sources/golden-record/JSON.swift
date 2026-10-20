import Foundation

/// A tiny ordered JSON value. Numbers are stored already formatted, so what is written is exactly what the
/// recorder replays (args are parsed back from the same text) and output bytes never depend on a formatter.
indirect enum J: Sendable {
    case num(String)
    case str(String)
    case bool(Bool)
    case arr([J])
    case obj([(String, J)])
    case null

    /// Float args: 9 significant digits round-trip Float32 exactly.
    static func f(_ v: Float) -> J { v.isFinite ? .num(String(format: "%.9g", Double(v))) : .null }
    static func d(_ v: Double) -> J { v.isFinite ? .num(String(format: "%.17g", v)) : .null }
    static func i(_ v: Int) -> J { .num(String(v)) }
    static func v2(_ v: SIMD2<Float>) -> J { .arr([f(v.x), f(v.y)]) }
    static func v3(_ v: SIMD3<Float>) -> J { .arr([f(v.x), f(v.y), f(v.z)]) }

    // MARK: Reading (args)

    var float: Float {
        guard case .num(let s) = self, let v = Float(s) else { fatalError("expected a number, got \(self)") }
        return v
    }
    var double: Double {
        guard case .num(let s) = self, let v = Double(s) else { fatalError("expected a number, got \(self)") }
        return v
    }
    var int: Int { Int(double) }
    var string: String {
        guard case .str(let s) = self else { fatalError("expected a string, got \(self)") }
        return s
    }
    var boolValue: Bool {
        guard case .bool(let b) = self else { fatalError("expected a bool, got \(self)") }
        return b
    }
    var array: [J] {
        guard case .arr(let a) = self else { fatalError("expected an array, got \(self)") }
        return a
    }
    var isNull: Bool { if case .null = self { true } else { false } }
    var simd2: SIMD2<Float> { let a = array; return SIMD2(a[0].float, a[1].float) }
    var simd3: SIMD3<Float> { let a = array; return SIMD3(a[0].float, a[1].float, a[2].float) }
    subscript(key: String) -> J? {
        guard case .obj(let kv) = self else { return nil }
        return kv.first { $0.0 == key }?.1
    }

    // MARK: Writing

    func write(to out: inout String) {
        switch self {
        case .num(let s): out += s
        case .str(let s): writeString(s, to: &out)
        case .bool(let b): out += b ? "true" : "false"
        case .null: out += "null"
        case .arr(let a):
            out += "["
            for (i, v) in a.enumerated() { if i > 0 { out += "," }; v.write(to: &out) }
            out += "]"
        case .obj(let kv):
            out += "{"
            for (i, (k, v)) in kv.enumerated() {
                if i > 0 { out += "," }
                writeString(k, to: &out); out += ":"; v.write(to: &out)
            }
            out += "}"
        }
    }
}

func writeString(_ s: String, to out: inout String) {
    out += "\""
    for c in s.unicodeScalars {
        switch c {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        default: if c.value < 0x20 { out += String(format: "\\u%04x", c.value) } else { out.unicodeScalars.append(c) }
        }
    }
    out += "\""
}

/// Frame values: 7 significant digits (keeps files small; the TS tolerance is 1e-3 abs / 1e-4 rel).
/// Non-finite values are written as null.
@inline(__always) func num7(_ v: Float, to out: inout String) {
    if !v.isFinite { out += "null"; return }
    if v == 0 { out += v.sign == .minus ? "-0" : "0"; return }
    if v == v.rounded(), abs(v) < 1e7 { out += String(Int(v)); return }
    out += String(format: "%.7g", Double(v))
}
