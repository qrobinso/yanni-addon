import CoreGraphics
import FaceModel
import FaceRendering
import Foundation
import ImageIO
import simd

// golden-render: renders picked golden-trace frames with the real Metal FaceRenderer and writes RGBA PNGs plus
// frames.json (the frame, style and FrameUniforms floats) for the WebGPU port's parity test.
//   swift run -c release golden-render [--out DIR]

let here = URL(fileURLWithPath: #filePath)  // tools/golden/Sources/golden-render/main.swift
let addon = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
let goldenDir = addon.appendingPathComponent("fixtures/golden")
var outDir = addon.appendingPathComponent("fixtures/render")
if let i = CommandLine.arguments.firstIndex(of: "--out"), i + 1 < CommandLine.arguments.count {
    outDir = URL(fileURLWithPath: CommandLine.arguments[i + 1])
}

precondition(MemoryLayout<FrameUniforms>.stride == 1264, "FrameUniforms stride is \(MemoryLayout<FrameUniforms>.stride)")
let uniformFloats = 316

// MARK: Traces

typealias Rec = [String: Any]
var traceCache: [String: [Rec]] = [:]
@MainActor func frames(_ scenario: String) -> [Rec] {
    if let c = traceCache[scenario] { return c }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/gunzip")
    p.arguments = ["-c", goldenDir.appendingPathComponent("\(scenario).json.gz").path]
    let pipe = Pipe()
    p.standardOutput = pipe
    try! p.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    precondition(p.terminationStatus == 0, "gunzip failed for \(scenario)")
    let root = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    let fr = root["frames"] as! [Rec]
    traceCache[scenario] = fr
    return fr
}

func fl(_ a: Any?) -> Float { Float((a as! NSNumber).doubleValue) }
func fa(_ a: Any?) -> [Float] { (a as! [Any]).map(fl) }
func b(_ a: Any?) -> Bool { a as! Bool }
func v2(_ a: [Float]) -> SIMD2<Float> { SIMD2(a[0], a[1]) }
func v3(_ a: [Float]) -> SIMD3<Float> { SIMD3(a[0], a[1], a[2]) }
func v4(_ a: [Float]) -> SIMD4<Float> { SIMD4(a[0], a[1], a[2], a[3]) }

func faceFrame(_ r: Rec) -> FaceFrame {
    var pose = FacePose(raw: .zero)
    for (i, v) in fa(r["pose"]).enumerated() { pose.raw[i] = v }
    var brows = BrowPose.zero
    for (i, v) in zip(BrowLayout.usedIndices, fa(r["brows"])) { brows.raw[i] = v }
    let ps = (r["pupilShape"] as! [NSNumber]).map(\.uint8Value)
    var f = FaceFrame(pose: pose, brightness: fl(r["brightness"]), wantsHighFrameRate: b(r["wantsHighFrameRate"]),
                      isAsleep: b(r["isAsleep"]), color: v3(fa(r["color"])), closureScale: v2(fa(r["closureScale"])),
                      stageOffset: v2(fa(r["stageOffset"])), eyeStageOffset: v4(fa(r["eyeStageOffset"])),
                      pupilShape: SIMD2(ps[0], ps[1]), pupilMorph: v2(fa(r["pupilMorph"])),
                      pupilShapeScale: v4(fa(r["pupilShapeScale"])), brows: brows, browPresence: fl(r["browPresence"]),
                      browOffset: v4(fa(r["browOffset"])), backgroundColor: v3(fa(r["backgroundColor"])),
                      backgroundStrength: fl(r["backgroundStrength"]), backgroundPresence: fl(r["backgroundPresence"]),
                      backgroundBrightness: fl(r["backgroundBrightness"]))
    f.glowLevel = fl(r["glowLevel"]); f.glowHeight = fl(r["glowHeight"]); f.glowMotion = fl(r["glowMotion"])
    f.glowRipple = fl(r["glowRipple"]); f.glowColor = v3(fa(r["glowColor"])); f.glowColor2 = v3(fa(r["glowColor2"]))
    f.glowPhase = v4(fa(r["glowPhase"])); f.captionInset = fl(r["captionInset"])
    return f
}

/// The trace record's FaceFrame fields, numbers written back from the parsed Floats (%.9g round-trips Float32).
let frameKeys = ["pose", "brightness", "wantsHighFrameRate", "isAsleep", "color", "closureScale", "stageOffset",
                 "eyeStageOffset", "pupilShape", "pupilMorph", "pupilShapeScale", "brows", "browPresence", "browOffset",
                 "backgroundColor", "backgroundStrength", "backgroundPresence", "backgroundBrightness", "glowLevel",
                 "glowHeight", "glowMotion", "glowRipple", "glowColor", "glowColor2", "glowPhase", "captionInset"]
func g9(_ v: Float) -> String { String(format: "%.9g", Double(v)) }
func frameJSON(_ r: Rec) -> String {
    frameKeys.map { k -> String in
        let v = r[k]!
        let s: String
        if k == "pupilShape" { s = "[" + (v as! [NSNumber]).map { "\($0.intValue)" }.joined(separator: ",") + "]" }
        else if v is [Any] { s = "[" + fa(v).map(g9).joined(separator: ",") + "]" }
        else if let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { s = n.boolValue ? "true" : "false" }
        else { s = g9(fl(v)) }
        return "\"\(k)\":\(s)"
    }.joined(separator: ",")
}

// MARK: Picks (deterministic: first index wins ties)

func argBest(_ fr: [Rec], where ok: (Rec) -> Bool = { _ in true }, _ score: (Rec) -> Float) -> Int {
    var best = -1, bestS = -Float.infinity
    for (i, r) in fr.enumerated() where ok(r) { let s = score(r); if s > bestS { best = i; bestS = s } }
    precondition(best >= 0, "no frame matches")
    return best
}
@MainActor func firstRest(_ s: String) -> Int {
    frames(s).firstIndex { ($0["f"] as! Int) >= 30 && fa($0["closureScale"])[1] == 1 && ($0["oneShots"] as! [Any]).isEmpty }!
}
func stageMag(_ r: Rec) -> Float {
    let s = fa(r["stageOffset"]), e = fa(r["eyeStageOffset"])
    return max(simd_length(SIMD2(s[0] + e[0], s[1] + e[1])), simd_length(SIMD2(s[0] + e[2], s[1] + e[3])))
}

/// `override`: trace fields replaced before rendering (listed in `source.override`; the written frame has them).
struct Pick { let name, scenario: String; let index: Int; let styleName: String; let style: RenderStyle; let override: [String: Float] }
var browStyle = RenderStyle(); browStyle.browsEnabled = true
var picks: [Pick] = []
@MainActor func add(_ name: String, _ sc: String, _ i: Int, _ styleName: String = "default", _ style: RenderStyle = RenderStyle(),
                    override: [String: Float] = [:]) {
    picks.append(Pick(name: name, scenario: sc, index: i, styleName: styleName, style: style, override: override))
}

let rest = firstRest("idle-10min")
add("rest", "idle-10min", rest)
add("blink-mid", "idle-10min", argBest(frames("idle-10min")) { -abs(fa($0["closureScale"])[1] - 0.5) })
for (id, kind) in ["star", "heart", "note", "question", "exclaim"].enumerated() {
    let sc = "oneshot-\(kind)Eyes"
    add("shape-\(kind)", sc, argBest(frames(sc), where: { ($0["pupilShape"] as! [NSNumber])[0].intValue == id + 1 }) {
        fa($0["pupilMorph"])[0] })
}
add("brows-rest", "idle-10min", rest, "browsEnabled", browStyle)
add("brows-raised", "oneshot-bigSurprise", argBest(frames("oneshot-bigSurprise")) { fa($0["brows"])[1] }, "browsEnabled", browStyle)
let edge = ["oneshot-pretendExit", "oneshot-shyPeek", "oneshot-leapfrog", "oneshot-popUp"]
    .map { sc in (sc, argBest(frames(sc), stageMag)) }
    .max { stageMag(frames($0.0)[$0.1]) < stageMag(frames($1.0)[$1.1]) }!
add("edge-antic", edge.0, edge.1)
// No trace has backgroundStrength > 0 (the background mode defaults to black), so take the mood-sweep frame with the
// lightest mood colour and force the strength to 1.
func lightness(_ c: SIMD3<Float>) -> Float { cbrt(0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z) }  // ≈ Oklab L
let mood = argBest(frames("mood-sweep")) { lightness(v3(fa($0["backgroundColor"]))) }
let bgOn: [String: Float] = ["backgroundStrength": 1]
add("mood-bg", "mood-sweep", mood, override: bgOn)
add("glow", "glow-caption", argBest(frames("glow-caption")) { fl($0["glowLevel"]) })
add("caption", "glow-caption", argBest(frames("glow-caption")) { fl($0["captionInset"]) })
add("asleep", "life-sleep-wake", argBest(frames("life-sleep-wake"), where: { b($0["isAsleep"]) }) { -fl($0["brightness"]) })
add("sticker", "idle-10min", rest, "ivoryRim", .ivoryRim)
// Ink brows only on a light background. shortcut: lightness ≈ cbrt(luminance) of the mixed background, not the
// renderer's exact Oklab test; fine as a skip gate.
let m = frames("mood-sweep")[mood]
let bgL = lightness(v3(fa(m["backgroundColor"])) * fl(m["backgroundPresence"]) * fl(m["backgroundBrightness"]))
if bgL >= 0.33 { add("brows-ink", "mood-sweep", mood, "browsEnabled", browStyle, override: bgOn) }
else { print("skip brows-ink: background lightness ≈ \(bgL)") }
add("lids-angled", "oneshot-mockOffense", argBest(frames("oneshot-mockOffense")) { abs(fa($0["pose"])[19]) })

// MARK: Render

func writePNG(_ bgra: [UInt8], width: Int, height: Int, to url: URL) {
    var rgba = bgra
    for i in stride(from: 0, to: rgba.count, by: 4) { rgba.swapAt(i, i + 2) }
    let provider = CGDataProvider(data: Data(rgba) as CFData)!
    let img = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                      provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    precondition(CGImageDestinationFinalize(dest), "PNG write failed: \(url.path)")
}

guard let renderer = FaceRenderer() else { fatalError("no Metal device") }
try await renderer.waitUntilReady()
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

var entries: [String] = []
let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
for p in picks {
    var r = frames(p.scenario)[p.index]
    for (k, v) in p.override { r[k] = NSNumber(value: v) }
    let overrideJSON = p.override.isEmpty ? "" :
        ",\"override\":{" + p.override.sorted { $0.key < $1.key }.map { "\"\($0.key)\":\(g9($0.value))" }.joined(separator: ",") + "}"
    let frame = faceFrame(r)
    let styleJSON = String(decoding: try enc.encode(p.style), as: UTF8.self)
    for (suffix, w, h) in [("landscape", 1180, 820), ("portrait", 820, 1180)] {
        let name = "\(p.name)-\(suffix)"
        guard let px = renderer.renderPixels(frame: frame, style: p.style, width: w, height: h) else { fatalError("render failed: \(name)") }
        writePNG(px, width: w, height: h, to: outDir.appendingPathComponent("\(name).png"))
        // Same uniforms the renderer built (FaceRenderer.encodeFrame; `resolved(for:)` is internal, so inlined).
        let vp = Viewport.fitting(width: Float(w), height: Float(h), style: p.style, captionInset: frame.captionInset)
        var s = p.style
        s.crescentColor = p.style.resolvedCrescentColor(for: frame)
        s.color = p.style.resolvedEyeColor(for: frame)
        let u = EyeGeometry.uniforms(frame: frame, viewport: vp, style: s)
        let floats = withUnsafeBytes(of: u) { Array($0.bindMemory(to: Float.self)) }
        precondition(floats.count == uniformFloats)
        let f = r["f"] as! Int
        entries.append("""
        {"name":"\(name)","png":"\(name).png","width":\(w),"height":\(h),"time":0,\
        "source":{"scenario":"\(p.scenario)","f":\(f)\(overrideJSON)},"styleName":"\(p.styleName)","style":\(styleJSON),\
        "frame":{\(frameJSON(r))},"uniforms":[\(floats.map(g9).joined(separator: ","))]}
        """)
        print("\(name)\t\(p.scenario) f=\(f)\t\(p.styleName)")
    }
}
let json = "{\"version\":1,\"uniformFloats\":\(uniformFloats),\"entries\":[\n" + entries.joined(separator: ",\n") + "\n]}\n"
try json.write(to: outDir.appendingPathComponent("frames.json"), atomically: true, encoding: .utf8)
print("wrote \(entries.count) PNGs + frames.json to \(outDir.path)")
