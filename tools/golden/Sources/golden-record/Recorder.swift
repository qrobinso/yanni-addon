import FaceEngine
import FaceLife
import FaceModel
import Foundation

struct Scenario {
    var name: String
    var dt: Double = 1.0 / 60.0
    var seed: UInt64 = 0x59414E4E49
    /// "default" (FaceEngine.makeDefaultModifiers()), "core" (OneShotSampler + OneShotApply only) or
    /// "subset:A,B,…" (those of makeDefaultModifiers, in its order).
    var modifiers: String = "default"
    /// Drive a LifeCycleController (FaceLife) after every tick, on a simulated clock.
    var life: Bool = false
    /// Frame count (the upper bound when `until` is set).
    var frames: Int
    var inputs: [Input] = []
    /// Stop `tail` frames after this kind, once seen active, is no longer active.
    var until: OneShotKind?
    var tail: Int = 60
}

/// Simulated clock for the life-cycle controller: seconds of engine time.
@MainActor final class SimClock { var t: Double = 0 }

/// Fixed wall-clock epoch for life scenarios: 2027-01-15 08:00:00 UTC, calendar Gregorian/GMT (daytime; no schedule).
let lifeEpoch: Double = 1_800_000_000

let frameFields = ["f", "pose", "brightness", "wantsHighFrameRate", "isAsleep", "color", "closureScale", "stageOffset",
                   "eyeStageOffset", "pupilShape", "pupilMorph", "pupilShapeScale", "brows", "browPresence",
                   "browOffset", "backgroundColor", "backgroundStrength", "backgroundPresence",
                   "backgroundBrightness", "glowLevel", "glowHeight", "glowMotion", "glowRipple", "glowColor",
                   "glowColor2", "glowPhase", "captionInset", "oneShots", "agentState", "mood"]
let lifeFields = ["moodOffset", "lifePhase", "lifeIsBedtime", "lifeIsPresent", "lifeBoredom", "lifeIsSinkingToSleep",
                  "lifeIsForceSleepActive", "lifeIsNightAwake"]

struct Recording {
    var text: String
    /// Every one-shot kind seen active at least once.
    var seen: Set<OneShotKind>
    var frameCount: Int
}

@MainActor func record(_ sc: Scenario) -> Recording {
    let engine = FaceEngine(seed: sc.seed, modifiers: modifierStack(sc.modifiers))
    let clock = SimClock()
    var life: LifeCycleController?
    if sc.life {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "GMT")!
        life = LifeCycleController(engine: engine, clock: LifeClock(monotonic: { clock.t },
                                                                    now: { Date(timeIntervalSince1970: lifeEpoch + clock.t) }),
                                   calendar: cal)
    }

    var out = String()
    out.reserveCapacity(sc.frames * 1400)
    let fields = frameFields + (sc.life ? lifeFields : [])
    let header: [(String, J)] = [
        ("scenario", .str(sc.name)),
        ("seed", .str("0x" + String(sc.seed, radix: 16, uppercase: true))),
        ("dt", .d(sc.dt)),
        ("modifiers", .str(sc.modifiers)),
        ("life", .bool(sc.life)),
        ("hostTime", .str("(f+1)*dt")),
        ("inputs", .arr(sc.inputs.map(\.json))),
        ("fields", .arr(fields.map { .str($0) })),
    ]
    out += "{"
    for (k, v) in header { writeString(k, to: &out); out += ":"; v.write(to: &out); out += ",\n" }
    out += "\"frames\":[\n"

    var byFrame: [Int: [Input]] = [:]
    for i in sc.inputs { byFrame[i.frame, default: []].append(i) }
    var seen = Set<OneShotKind>()
    var stopAt: Int?
    var f = 0
    while f < sc.frames, stopAt.map({ f < $0 }) ?? true {
        for i in byFrame[f] ?? [] { apply(i, engine: engine, life: life) }
        let host = Double(f + 1) * sc.dt
        let fr = engine.tick(dt: sc.dt, hostTime: host)
        clock.t = host
        life?.afterFrame(hostTime: host)
        let st = engine.state
        seen.formUnion(st.activeOneShots)
        if let k = sc.until, stopAt == nil, seen.contains(k), !st.activeOneShots.contains(k) { stopAt = f + 1 + sc.tail }

        if f > 0 { out += ",\n" }
        out += "{\"f\":"; out += String(f)
        out += ",\"pose\":"; arr((0..<ParamLayout.count).map { fr.pose[$0] }, &out)
        out += ",\"brightness\":"; num7(fr.brightness, to: &out)
        out += ",\"wantsHighFrameRate\":"; out += fr.wantsHighFrameRate ? "true" : "false"
        out += ",\"isAsleep\":"; out += fr.isAsleep ? "true" : "false"
        out += ",\"color\":"; arr([fr.color.x, fr.color.y, fr.color.z], &out)
        out += ",\"closureScale\":"; arr([fr.closureScale.x, fr.closureScale.y], &out)
        out += ",\"stageOffset\":"; arr([fr.stageOffset.x, fr.stageOffset.y], &out)
        out += ",\"eyeStageOffset\":"; arr(v4(fr.eyeStageOffset), &out)
        out += ",\"pupilShape\":[\(fr.pupilShape.x),\(fr.pupilShape.y)]"
        out += ",\"pupilMorph\":"; arr([fr.pupilMorph.x, fr.pupilMorph.y], &out)
        out += ",\"pupilShapeScale\":"; arr(v4(fr.pupilShapeScale), &out)
        out += ",\"brows\":"; arr(BrowLayout.usedIndices.map { fr.brows[$0] }, &out)
        out += ",\"browPresence\":"; num7(fr.browPresence, to: &out)
        out += ",\"browOffset\":"; arr(v4(fr.browOffset), &out)
        out += ",\"backgroundColor\":"; arr([fr.backgroundColor.x, fr.backgroundColor.y, fr.backgroundColor.z], &out)
        out += ",\"backgroundStrength\":"; num7(fr.backgroundStrength, to: &out)
        out += ",\"backgroundPresence\":"; num7(fr.backgroundPresence, to: &out)
        out += ",\"backgroundBrightness\":"; num7(fr.backgroundBrightness, to: &out)
        out += ",\"glowLevel\":"; num7(fr.glowLevel, to: &out)
        out += ",\"glowHeight\":"; num7(fr.glowHeight, to: &out)
        out += ",\"glowMotion\":"; num7(fr.glowMotion, to: &out)
        out += ",\"glowRipple\":"; num7(fr.glowRipple, to: &out)
        out += ",\"glowColor\":"; arr([fr.glowColor.x, fr.glowColor.y, fr.glowColor.z], &out)
        out += ",\"glowColor2\":"; arr([fr.glowColor2.x, fr.glowColor2.y, fr.glowColor2.z], &out)
        out += ",\"glowPhase\":"; arr(v4(fr.glowPhase), &out)
        out += ",\"captionInset\":"; num7(fr.captionInset, to: &out)
        out += ",\"oneShots\":"; J.arr(st.activeOneShots.map { .str($0.rawValue) }).write(to: &out)
        out += ",\"agentState\":"; writeString(st.agentState.rawValue, to: &out)
        out += ",\"mood\":"; arr([st.mood.pleasure, st.mood.arousal, st.mood.dominance], &out)
        if let life {
            out += ",\"moodOffset\":"; arr([st.moodOffset.x, st.moodOffset.y, st.moodOffset.z], &out)
            out += ",\"lifePhase\":"; writeString(life.phase.rawValue, to: &out)
            out += ",\"lifeIsBedtime\":\(life.isBedtime)"
            out += ",\"lifeIsPresent\":\(life.isPresent)"
            out += ",\"lifeBoredom\":"; num7(life.boredom, to: &out)
            out += ",\"lifeIsSinkingToSleep\":\(life.isSinkingToSleep)"
            out += ",\"lifeIsForceSleepActive\":\(life.isForceSleepActive)"
            out += ",\"lifeIsNightAwake\":\(life.isNightAwake)"
        }
        out += "}"
        f += 1
    }
    out += "\n]}\n"
    return Recording(text: out, seen: seen, frameCount: f)
}

@inline(__always) private func v4(_ v: SIMD4<Float>) -> [Float] { [v.x, v.y, v.z, v.w] }

@inline(__always) private func arr(_ a: [Float], _ out: inout String) {
    out += "["
    for (i, v) in a.enumerated() { if i > 0 { out += "," }; num7(v, to: &out) }
    out += "]"
}

/// The modifier stack a scenario's `modifiers` names (nil: the engine's default stack).
@MainActor func modifierStack(_ spec: String) -> [any Modifier]? {
    if spec == "core" { return [OneShotSampler(), OneShotApply()] }
    guard spec.hasPrefix("subset:") else { return nil }
    let names = Set(spec.dropFirst("subset:".count).split(separator: ",").map(String.init))
    let stack = FaceEngine.makeDefaultModifiers().filter { names.contains($0.name) }
    precondition(stack.count == names.count, "unknown modifier in \(spec)")
    return stack
}
