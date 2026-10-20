import FaceEngine
import FaceModel
import Foundation

// golden-record [--out dir] [--check] [scenario…]
// No scenario names = all. --check records everything twice into temp dirs, asserts byte-identical output, and
// compares it with what is already in the out dir (stale fixtures fail too).

let gzipThreshold = 0  // always gzip: keeps the repo small
let defaultOut = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("fixtures/golden")

var outDir = defaultOut
var check = false
var names: [String] = []
var args = CommandLine.arguments.dropFirst()
while let a = args.popFirst() {
    switch a {
    case "--out": outDir = URL(fileURLWithPath: args.popFirst() ?? ".")
    case "--check": check = true
    case "--list": allScenarios().forEach { print($0.name) }; exit(0)
    default: names.append(a)
    }
}

let all = allScenarios()
let chosen = names.isEmpty ? all : names.map { n in
    guard let s = all.first(where: { $0.name == n }) else { FileHandle.standardError.write("unknown scenario \(n)\n".data(using: .utf8)!); exit(2) }
    return s
}

/// Writes one scenario into `dir`; returns the file name written.
@MainActor func write(_ sc: Scenario, into dir: URL, verbose: Bool) -> String {
    let rec = record(sc)
    let json = dir.appendingPathComponent("\(sc.name).json")
    let gz = dir.appendingPathComponent("\(sc.name).json.gz")
    try? FileManager.default.createDirectory(at: json.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: json)
    try? FileManager.default.removeItem(at: gz)
    try! Data(rec.text.utf8).write(to: json)
    var file = json
    if rec.text.utf8.count > gzipThreshold {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
        p.arguments = ["-n", "-9", "-f", json.path]   // -n: no name/timestamp, so output is byte-stable
        try! p.run(); p.waitUntilExit()
        precondition(p.terminationStatus == 0, "gzip failed for \(sc.name)")
        file = gz
    }
    if verbose {
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        var note = ""
        if let k = sc.until, !rec.seen.contains(k) { note = "  WARNING: \(k.rawValue) never became active" }
        print("\(file.lastPathComponent)  frames \(rec.frameCount)  \(size) bytes\(note)")
    }
    return String(file.path.dropFirst(dir.path.count + 1))  // relative to dir (emotion/… lives in a subfolder)
}

@MainActor func writeLayout(into dir: URL) {
    let layout = J.obj([
        ("pose", .arr(ParamLayout.names.map { .str($0) })),
        ("brows", .arr(BrowLayout.names.map { .str($0) })),
        ("oneShotKinds", .arr(OneShotKind.allCases.map { .str($0.rawValue) })),
        ("agentStates", .arr(AgentState.allCases.map { .str($0.rawValue) })),
    ])
    var s = ""; layout.write(to: &s); s += "\n"
    try! Data(s.utf8).write(to: dir.appendingPathComponent("layout.json"))
}

try! FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

if check {
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("golden-check-\(ProcessInfo.processInfo.processIdentifier)")
    let a = tmp.appendingPathComponent("a"), b = tmp.appendingPathComponent("b")
    for d in [a, b] { try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }
    defer { try? FileManager.default.removeItem(at: tmp) }
    var failed = false
    for sc in chosen {
        let fa = write(sc, into: a, verbose: false)
        _ = write(sc, into: b, verbose: false)
        let da = try! Data(contentsOf: a.appendingPathComponent(fa))
        let db = try! Data(contentsOf: b.appendingPathComponent(fa))
        let existing = try? Data(contentsOf: outDir.appendingPathComponent(fa))
        let deterministic = da == db
        let fresh = existing == da
        if !deterministic || !fresh { failed = true }
        print("\(fa)  \(deterministic ? "deterministic" : "NOT DETERMINISTIC")  \(fresh ? "matches fixture" : (existing == nil ? "fixture missing" : "fixture STALE"))")
    }
    exit(failed ? 1 : 0)
}

writeLayout(into: outDir)
for sc in chosen { _ = write(sc, into: outDir, verbose: true) }
