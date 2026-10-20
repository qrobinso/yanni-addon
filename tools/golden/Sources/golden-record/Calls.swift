import FaceEngine
import FaceLife
import FaceModel
import Foundation

/// One scripted input: applied before the tick of `frame`. `call` names the public Swift method; `args` its arguments
/// (encoding in fixtures/golden/FORMAT.md).
struct Input {
    var frame: Int
    var call: String
    var args: [J]

    var json: J { .obj([("frame", .i(frame)), ("call", .str(call)), ("args", .arr(args))]) }
}

// MARK: - Arg encoders (used by the scenario scripts)

enum Arg {
    static func kind(_ k: OneShotKind) -> J { .str(k.rawValue) }
    static func state(_ s: AgentState) -> J { .str(s.rawValue) }
    static func mood(_ p: Float, _ a: Float, _ d: Float) -> J {
        .obj([("pleasure", .f(p)), ("arousal", .f(a)), ("dominance", .f(d))])
    }
    static func person(_ id: Int, _ pos: SIMD2<Float>, distance: Float = 1.5, salience: Float = 0.5, facing: Float = 1,
                       lookingAtMe: Float = 0) -> J {
        .obj([("id", .i(id)), ("position", .v2(pos)), ("distance", .f(distance)), ("salience", .f(salience)),
              ("facing", .f(facing)), ("lookingAtMe", .f(lookingAtMe))])
    }
    static func optInt(_ v: Int?) -> J { v.map { .i($0) } ?? .null }
    static func geometry(_ g: EdgeGeometry) -> J {
        .obj([("visibleHalfExtent", .v2(g.visibleHalfExtent)),
              ("leftEyeCenter", .v2(g.leftEyeCenter)), ("rightEyeCenter", .v2(g.rightEyeCenter)),
              ("leftEyeHalfSize", .v2(g.leftEyeHalfSize)), ("rightEyeHalfSize", .v2(g.rightEyeHalfSize)),
              ("leftBrowCenter", .v2(g.leftBrowCenter)), ("leftBrowHalfSize", .v2(g.leftBrowHalfSize)),
              ("rightBrowCenter", .v2(g.rightBrowCenter)), ("rightBrowHalfSize", .v2(g.rightBrowHalfSize))])
    }
    static func command(_ c: String, _ fields: [(String, J)] = []) -> J { .obj([("case", .str(c))] + fields) }
}

// MARK: - Dispatch

private func kindArg(_ j: J) -> OneShotKind {
    guard let k = OneShotKind(rawValue: j.string) else { fatalError("unknown OneShotKind \(j.string)") }
    return k
}

private func optFloat(_ args: [J], _ i: Int) -> Float? { i < args.count && !args[i].isNull ? args[i].float : nil }

private func person(_ j: J) -> PersonTarget {
    PersonTarget(id: j["id"]!.int, position: j["position"]!.simd2, distance: j["distance"]!.float,
                 salience: j["salience"]!.float, facing: j["facing"]!.float, lookingAtMe: j["lookingAtMe"]!.float)
}

private func command(_ j: J) -> FaceCommand {
    switch j["case"]!.string {
    case "playOneShot": return .playOneShot(kindArg(j["kind"]!))
    case "glance": return .glance(at: j["at"]!.simd2, duration: j["duration"]!.float)
    case "stimulus": return .stimulus(at: j["at"]!.simd2, strength: j["strength"]!.float)
    case "restGaze": return .restGaze(at: j["at"]!.simd2)
    case "blink": return .blink
    case "tap": return .tap(at: j["at"]!.simd2)
    case "scratch": return .scratch(at: j["at"]!.simd2, intensity: j["intensity"]!.float)
    case "attend": return .attend(personID: j["personID"].flatMap { $0.isNull ? nil : $0.int })
    case let c: fatalError("unsupported FaceCommand case \(c)")
    }
}

private func geometry(_ j: J) -> EdgeGeometry {
    EdgeGeometry(visibleHalfExtent: j["visibleHalfExtent"]!.simd2,
                 leftEyeCenter: j["leftEyeCenter"]!.simd2, rightEyeCenter: j["rightEyeCenter"]!.simd2,
                 leftEyeHalfSize: j["leftEyeHalfSize"]!.simd2, rightEyeHalfSize: j["rightEyeHalfSize"]!.simd2,
                 leftBrowCenter: j["leftBrowCenter"]!.simd2, leftBrowHalfSize: j["leftBrowHalfSize"]!.simd2,
                 rightBrowCenter: j["rightBrowCenter"]!.simd2, rightBrowHalfSize: j["rightBrowHalfSize"]!.simd2)
}

/// Applies one input to the engine (or the life-cycle controller for `life.*` calls).
@MainActor func apply(_ input: Input, engine e: FaceEngine, life: LifeCycleController?) {
    let a = input.args
    switch input.call {
    case "setAgentState":
        guard let s = AgentState(rawValue: a[0].string) else { fatalError("unknown AgentState \(a[0].string)") }
        e.setAgentState(s)
    case "setMood":
        e.setMood(Mood(pleasure: a[0]["pleasure"]!.float, arousal: a[0]["arousal"]!.float,
                       dominance: a[0]["dominance"]!.float))
    case "setMoodOffset": e.setMoodOffset(a[0].simd3)
    case "setPeople":
        let primary: Int? = a[1].isNull ? nil : a[1].int
        let engaged: Int? = a[2].isNull ? nil : a[2].int
        e.setPeople(a[0].array.map(person), primary: primary, engaged: engaged)
    case "send": e.send(command(a[0]))
    case "setEdgeGeometry": e.setEdgeGeometry(a[0].isNull ? nil : geometry(a[0]))
    case "setBedtime": e.setBedtime(a[0].boolValue)
    case "setSpeechLevel": e.setSpeechLevel(a[0].float)
    case "setListeningGlow": e.setListeningGlow(a[0].float)
    case "setListeningVoice": e.setListeningVoice(a[0].float)
    case "setListeningLevel": e.setListeningLevel(a[0].float)
    case "setCaptionInset": e.setCaptionInset(a[0].float, reduceMotion: a.count > 1 ? a[1].boolValue : false)
    case "playPupilShape": e.playPupilShape(kindArg(a[0]), leadEye: optFloat(a, 1))
    case "cancelPupilShape": e.cancelPupilShape()
    case "playEdgeAntic": e.playEdgeAntic(kindArg(a[0]), side: optFloat(a, 1) ?? 0)
    case "cancelEdgeAntics": e.cancelEdgeAntics(includingSink: a.first?.boolValue ?? false)
    case "playIdleGame": e.playIdleGame(kindArg(a[0]), side: optFloat(a, 1) ?? 0)
    case "cancelIdleGames": e.cancelIdleGames()
    case "noteFriendlyTouch": e.noteFriendlyTouch(until: a[0].double)
    case "fadeInFromBlack": e.fadeInFromBlack()
    case "life.settings":
        guard let life else { fatalError("life.settings without a life-cycle controller") }
        var s = LifeSettings()
        guard case .obj(let kv) = a[0] else { fatalError("life.settings expects an object") }
        for (k, v) in kv {
            switch k {
            case "minutesToDrowsy": s.minutesToDrowsy = v.double
            case "minutesToAsleep": s.minutesToAsleep = v.double
            case "manualBedtime": s.manualBedtime = v.boolValue
            case "tapsToWake": s.tapsToWake = v.int
            case "wakeOnMotionAtBedtime": s.wakeOnMotionAtBedtime = v.boolValue
            case "bedtimeAwakeMinutes": s.bedtimeAwakeMinutes = v.double
            case "idleMoodDrift": s.idleMoodDrift = v.boolValue
            case "aloneTakeoverMinutes": s.aloneTakeoverMinutes = v.double
            default: fatalError("unsupported LifeSettings key \(k)")
            }
        }
        life.settings = s
    case "life.forceSleep": life!.forceSleep(for: a.first.flatMap { $0.isNull ? nil : $0.double })
    case "life.forceWake": life!.forceWake()
    case "life.noteActivity": life!.noteActivity()
    case let c: fatalError("unsupported call \(c)")
    }
}
