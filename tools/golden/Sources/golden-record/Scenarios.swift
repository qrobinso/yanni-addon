import Foundation
import FaceEngine
import FaceModel
import FaceRendering

/// Frame index of a time in seconds at 60 Hz.
private func fr(_ sec: Double) -> Int { Int((sec * 60).rounded()) }
private func at(_ sec: Double, _ call: String, _ args: [J] = []) -> Input { Input(frame: fr(sec), call: call, args: args) }

/// The app's edge geometry for an iPad-like 1180 × 820 landscape canvas with the default render style.
@MainActor private let ipadGeometry = Arg.geometry(EdgeGeometry.fitting(width: 1180, height: 820, style: RenderStyle()))
@MainActor private var geo: Input { Input(frame: 0, call: "setEdgeGeometry", args: [ipadGeometry]) }

/// A passer-by: in view but turned away (facing below NoticingAttention's 0.5 snap-back threshold), not engaging.
private let person1 = Arg.person(1, SIMD2(0.3, 0.05), facing: 0.2)
/// The same person turned to the face and making eye contact.
private let facingPerson1 = Arg.person(1, SIMD2(0.3, 0.05), facing: 1, lookingAtMe: 1)

private func send(_ sec: Double, _ c: String, _ fields: [(String, J)] = []) -> Input {
    at(sec, "send", [Arg.command(c, fields)])
}

@MainActor func allScenarios() -> [Scenario] {
    var list: [Scenario] = []

    // Engine-core stress: overlapping one-shots, conflicts, evictions, retriggers at the cooldown, state releases.
    list.append(Scenario(name: "core-mix", modifiers: "core", frames: fr(12), inputs: [
        send(0.5, "playOneShot", [("kind", Arg.kind(.laugh))]),
        send(0.8, "playOneShot", [("kind", Arg.kind(.dance))]),
        send(1.0, "playOneShot", [("kind", Arg.kind(.sorryBlink))]),
        send(1.2, "playOneShot", [("kind", Arg.kind(.lookAway))]),
        send(1.25, "playOneShot", [("kind", Arg.kind(.crossEyed))]),
        send(2.0, "playOneShot", [("kind", Arg.kind(.dance))]),
        send(2.1, "playOneShot", [("kind", Arg.kind(.curiousTilt))]),
        at(2.5, "setAgentState", [Arg.state(.listening)]),
        send(3.0, "playOneShot", [("kind", Arg.kind(.perkUp))]),
        send(3.2, "playOneShot", [("kind", Arg.kind(.perkUp))]),
        send(3.6, "playOneShot", [("kind", Arg.kind(.perkUp))]),
        send(4.0, "playOneShot", [("kind", Arg.kind(.bigSurprise))]),
        send(4.0, "playOneShot", [("kind", Arg.kind(.sideEye))]),
        send(4.0, "playOneShot", [("kind", Arg.kind(.yawn))]),
        send(4.0, "playOneShot", [("kind", Arg.kind(.mockOffense))]),
        send(4.0, "playOneShot", [("kind", Arg.kind(.doubleTake))]),
        send(4.0, "playOneShot", [("kind", Arg.kind(.catchSelf))]),
        send(4.0, "playOneShot", [("kind", Arg.kind(.stretch))]),
        at(5.0, "setAgentState", [Arg.state(.idle)]),
        send(6, "playOneShot", [("kind", Arg.kind(.nodOff))]),
        at(6.5, "setAgentState", [Arg.state(.drowsy)]),
        send(7, "playOneShot", [("kind", Arg.kind(.wake))]),
        send(7.3, "playOneShot", [("kind", Arg.kind(.delightedSquint))]),
        at(8, "setMood", [Arg.mood(0.5, 0.5, 0.2)]),
        send(8.5, "playOneShot", [("kind", Arg.kind(.confusedShake))]),
        at(8.6, "noteFriendlyTouch", [.d(9.0)]),
        send(9, "playOneShot", [("kind", Arg.kind(.laugh))]),
    ]))
    // Engine-core parity gate: only the one-shot sampler and apply, nothing playing.
    list.append(Scenario(name: "rest-core", modifiers: "core", frames: fr(5)))
    list.append(Scenario(name: "rest-default", frames: fr(10)))
    list.append(Scenario(name: "idle-10min", frames: fr(600), inputs: [geo]))
    list.append(Scenario(name: "noticing-3min", frames: fr(180), inputs: [
        geo,
        at(0, "setPeople", [.arr([person1]), .i(1), .null]),
        at(0, "setAgentState", [Arg.state(.noticing)]),
    ]))

    // Every one-shot: 1 s settle, play, until it ends + 1 s (capped at 40 s).
    for k in OneShotKind.allCases {
        let play: Input
        if k.isScreenEdgeAntic {
            play = at(1, "playEdgeAntic", [Arg.kind(k), .f(1)])
        } else if k.isIdleGame {
            play = at(1, "playIdleGame", [Arg.kind(k), .f(1)])
        } else {
            play = send(1, "playOneShot", [("kind", Arg.kind(k))])
        }
        list.append(Scenario(name: "oneshot-\(k.rawValue)", frames: fr(40), inputs: [geo, play], until: k))
    }

    // Every agent state for 3 s, with one engaged person in view.
    var tour: [Input] = [geo, at(0, "setPeople", [.arr([facingPerson1]), .i(1), .i(1)])]
    for (i, s) in AgentState.allCases.enumerated() { tour.append(at(Double(i) * 3, "setAgentState", [Arg.state(s)])) }
    list.append(Scenario(name: "states-tour", frames: fr(Double(AgentState.allCases.count) * 3), inputs: tour))

    // PAD corners ±0.8, 4 s each, then back to the playful baseline.
    var sweep: [Input] = [geo]
    var t = 0.0
    for p: Float in [-0.8, 0.8] { for a: Float in [-0.8, 0.8] { for d: Float in [-0.8, 0.8] {
        sweep.append(at(t, "setMood", [Arg.mood(p, a, d)])); t += 4
    } } }
    sweep.append(at(t, "setMood", [Arg.mood(0.2, 0.15, 0.1)]))
    list.append(Scenario(name: "mood-sweep", frames: fr(t + 4), inputs: sweep))

    // Noticing a passer-by, an idle game starts, then the person engages mid-game.
    list.append(Scenario(name: "engage-interrupt", frames: fr(9), inputs: [
        geo,
        at(0, "setPeople", [.arr([person1]), .i(1), .null]),
        at(0, "setAgentState", [Arg.state(.noticing)]),
        at(2, "playIdleGame", [Arg.kind(.pingPong), .f(1)]),
        at(4, "setPeople", [.arr([facingPerson1]), .i(1), .i(1)]),
        at(4.3, "setAgentState", [Arg.state(.engaged)]),
    ]))

    // Each pupil transformation (5 s apart), then one cancelled early.
    var shapes: [Input] = [geo]
    let shapeKinds = OneShotKind.allCases.filter(\.isPupilShape)
    for (i, k) in shapeKinds.enumerated() {
        shapes.append(at(1 + Double(i) * 5, "playPupilShape", [Arg.kind(k), k == .questionEyes ? .f(1) : .null]))
    }
    let tc = 1 + Double(shapeKinds.count) * 5
    shapes.append(at(tc, "playPupilShape", [Arg.kind(.starEyes), .null]))
    shapes.append(at(tc + 1, "cancelPupilShape"))
    list.append(Scenario(name: "pupil-shapes", frames: fr(tc + 4), inputs: shapes))

    // Listening glow with a varying mic level, then the caption band up and down (springy, then Reduce Motion).
    var glow: [Input] = [
        geo,
        at(0, "setAgentState", [Arg.state(.listening)]),
        at(0.5, "setListeningGlow", [.f(1)]),
        at(1, "setListeningVoice", [.f(1)]),
    ]
    for f in fr(1)..<fr(5) {
        let s = Double(f) / 60
        glow.append(Input(frame: f, call: "setListeningLevel", args: [.f(Float(0.5 + 0.5 * sin(2 * .pi * 1.3 * s)))]))
    }
    glow += [
        at(5, "setListeningLevel", [.f(0)]),
        at(5, "setListeningVoice", [.f(0)]),
        at(5.5, "setCaptionInset", [.f(0.2), .bool(false)]),
        at(7.5, "setCaptionInset", [.f(0), .bool(false)]),
        at(8.5, "setCaptionInset", [.f(0.4), .bool(true)]),
        at(10, "setCaptionInset", [.f(0), .bool(true)]),
        at(10.5, "setListeningGlow", [.f(0)]),
    ]
    list.append(Scenario(name: "glow-caption", frames: fr(13), inputs: glow))

    // Taps (annoyance builds), a scratch, a high-five (friendly-touch window), a tap while asleep.
    var touch: [Input] = [geo]
    for (s, p) in [(1.0, SIMD2<Float>(0.2, -0.1)), (1.4, SIMD2(0.25, -0.05)), (1.8, SIMD2(-0.3, 0.1)),
                   (2.2, SIMD2(0, 0)), (4.0, SIMD2(0.5, 0.3))] {
        touch.append(send(s, "tap", [("at", .v2(p))]))
    }
    for i in 0..<15 {
        touch.append(send(6 + Double(i) * 0.1, "scratch", [("at", .v2(SIMD2(i % 2 == 0 ? 0.1 : -0.1, 0.2))),
                                                          ("intensity", .f(0.7))]))
    }
    touch += [
        at(10, "noteFriendlyTouch", [.d(12)]),
        send(10.3, "tap", [("at", .v2(SIMD2(0, -0.2)))]),
        at(13, "setAgentState", [Arg.state(.asleep)]),
        send(16, "tap", [("at", .v2(SIMD2(0, 0)))]),
    ]
    list.append(Scenario(name: "touch", frames: fr(20), inputs: touch))

    // FaceLife on a simulated clock (minute timers at their 0.25 min floor).
    let fast = J.obj([("minutesToDrowsy", .d(0.25)), ("minutesToAsleep", .d(0.25))])
    list.append(Scenario(name: "life-sleep-wake", life: true, frames: fr(60), inputs: [
        geo,
        at(0, "life.settings", [fast]),
        at(42, "setPeople", [.arr([person1]), .i(1), .null]),
        at(46, "setPeople", [.arr([facingPerson1]), .i(1), .i(1)]),
    ]))
    list.append(Scenario(name: "life-catch-self", life: true, frames: fr(26), inputs: [
        geo,
        at(0, "life.settings", [fast]),
        at(20, "setPeople", [.arr([person1]), .i(1), .null]),
    ]))
    list.append(Scenario(name: "life-bedtime", life: true, frames: fr(75), inputs: [
        geo,
        at(0, "life.settings", [.obj([("manualBedtime", .bool(true)), ("tapsToWake", .i(3)),
                                      ("bedtimeAwakeMinutes", .d(0.25))])]),
        send(40, "tap", [("at", .v2(SIMD2(0, 0)))]),
        send(40.5, "tap", [("at", .v2(SIMD2(0.1, 0)))]),
        send(41, "tap", [("at", .v2(SIMD2(-0.1, 0)))]),
    ]))
    list.append(Scenario(name: "life-force", life: true, frames: fr(20), inputs: [
        geo,
        at(1, "life.forceSleep", [.null]),
        at(12, "life.forceWake"),
    ]))
    // Per-package parity gates: the same scripts on modifier subsets, so each port package has scenarios that can
    // turn green before the whole default stack exists (`subset:` lists names; the stack keeps makeDefaultModifiers
    // order). core-oneshot-*: the one-shot curves alone.
    func variant(_ base: String, _ prefix: String, _ mods: String, seconds: Double? = nil) {
        guard var v = list.first(where: { $0.name == base }) else { fatalError("no scenario \(base)") }
        v.name = prefix + base
        v.modifiers = mods
        if let seconds { v.frames = fr(seconds) }
        list.append(v)
    }
    func subset(_ names: [String]) -> String { "subset:" + names.joined(separator: ",") }
    let wp5 = subset(["AgentStateBehavior", "OneShotSampler", "ExpressiveOverlay", "MoodModulation", "ExpressionTransition",
                      "Attention", "NoticingAttention", "ThinkingBeats", "GazeTracking", "Pupils", "MicroMotion",
                      "OneShotApply"])
    let wp6 = subset(["IdleBeats", "EdgeAntics", "IdleGames", "PupilReactions", "OneShotSampler", "OneShotApply"])
    let wp7 = subset(["TouchReactions", "OneShotSampler", "Breathing", "OneShotApply", "VocalSync", "SquashStretch",
                      "Blink", "LidHeaviness", "BurnInDrift", "Brows", "MoodColor", "Brightness", "CaptionInset"])
    for k in OneShotKind.allCases { variant("oneshot-\(k.rawValue)", "core-", "core") }
    variant("pupil-shapes", "core-", "core")
    for n in ["states-tour", "noticing-3min", "mood-sweep"] { variant(n, "wp5-", wp5) }
    variant("idle-10min", "wp5-", wp5, seconds: 120)
    variant("idle-10min", "wp6-", wp6, seconds: 300)
    for n in ["glow-caption", "mood-sweep", "touch", "states-tour"] { variant(n, "wp7-", wp7) }
    variant("idle-10min", "wp7-", wp7, seconds: 120)
    return list
}
