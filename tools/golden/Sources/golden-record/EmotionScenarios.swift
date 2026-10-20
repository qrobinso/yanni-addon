import FaceEmotion
import FaceEngine
import FaceModel
import Foundation

// Emotion-layer golden scenarios (WP11), written to fixtures/golden/emotion/<name>.json.gz so the engine scenario test
// never picks them up. An `EmotionLayer` drives a `FaceEngine` that is never ticked (the layer only reads the state
// facade calls set, so the trace doesn't depend on which modifiers are ported). The header and frame fields are below
// (`emotionFields`, `recordEmotion`); web/test/emotion/golden.test.ts replays them.
//
// Frame loop for frame f (0-based), host(f) = 1000 + (f+1)·dt: (1) apply every input of frame f in file order (the
// previous host time is "now" for them); (2) layer.afterFrame(host(f)); (3) the simulator, if running, ticks at
// host(f); (4) record. Before frame 0 the layer is built and called once at host 1000. A gate the layer hands back sets
// the agent state like the conversation controller (notForMe → .notForMe, didNotUnderstand → .confused).

private let emotionDt = 1.0 / 60.0
private func efr(_ sec: Double) -> Int { Int((sec * 60).rounded()) }
private func ein(_ sec: Double, _ call: String, _ args: [J] = []) -> Input { Input(frame: efr(sec), call: call, args: args) }

private func pad(_ p: Float, _ a: Float, _ d: Float) -> J { .arr([.f(p), .f(a), .f(d)]) }
private func impulse(_ sec: Double, _ kind: String, _ p: J, _ s: Float, _ src: String, _ label: String = "") -> Input {
    ein(sec, "impulse", [.str(kind), p, .f(s), .str(src), .str(label)])
}

/// Answers as a sorted-key JSON object.
private func ans(_ a: [String: [String: Float]]) -> J {
    .obj(a.keys.sorted().map { k in (k, .obj(a[k]!.keys.sorted().map { ($0, .f(a[k]![$0]!)) })) })
}

/// A wire decision message (the layer decodes it with `receive(data:)`).
private func wire(_ fields: [(String, J)]) -> J {
    var s = ""; J.obj([("yanni", .i(1))] + fields).write(to: &s); return .str(s)
}
private func decisionWire(version: Int = 1, pass: String, turn: String, index: Int? = nil,
                          _ a: [String: [String: Float]]) -> J {
    var f: [(String, J)] = [("type", .str("decision")), ("version", .i(version)), ("pass", .str(pass)), ("turnId", .str(turn))]
    if let index { f.append(("sentenceIndex", .i(index))) }
    f.append(("answers", ans(a)))
    return wire(f)
}
private func msg(_ sec: Double, _ m: J) -> Input { ein(sec, "message", [m]) }
private func A(_ sec: Double, _ turn: String, _ a: [String: [String: Float]], version: Int = 1) -> Input {
    msg(sec, decisionWire(version: version, pass: "utterance", turn: turn, a))
}
private func B(_ sec: Double, _ turn: String, _ i: Int, _ a: [String: [String: Float]], version: Int = 1) -> Input {
    msg(sec, decisionWire(version: version, pass: "sentence", turn: turn, index: i, a))
}
private func feel(_ f: [String: Float], _ intensity: Float, intent: String? = nil, reaction: (String, Float)? = nil,
                  passB: Bool = false) -> [String: [String: Float]] {
    ConversationSimulator.answers(feel: f, intensity: intensity, intent: intent, reaction: reaction,
                                  addressed: passB ? nil : 0.95, understood: passB ? nil : 0.95)
}

private func emotion(_ name: String, seconds: Double, _ inputs: [Input]) -> Scenario {
    Scenario(name: "emotion/\(name)", dt: emotionDt, modifiers: "emotion", frames: efr(seconds), inputs: inputs,
             custom: recordEmotion)
}

@MainActor func emotionScenarios() -> [Scenario] {
    var list: [Scenario] = []

    // Raw impulses, merging, nudges, personality and baseline changes, the life cycle's offset, bedtime gating.
    var many: [Input] = []
    for _ in 0..<12 { many.append(impulse(3, "absolute", pad(0.8, 0.9, 0.4), 1, "debug")) }
    list.append(emotion("impulses", seconds: 16, [
        impulse(0.5, "absolute", pad(0.8, 0.4, 0.3), 0.8, "debug", "test"),
        impulse(1.5, "relative", pad(-0.15, 0.1, 0), 1, "touch", "hey"),
        impulse(2, "absolute", pad(-0.6, -0.4, -0.4), 0.6, "perception", "frown"),
    ] + many + [
        ein(5, "nudge", [.str("sadness"), .f(1), .str("left")]),
        ein(5.5, "nudge", [.str("Zorp"), .f(0.5), .null]),
        ein(6, "personality", [.str("bubbly")]),
        ein(7.5, "moodOffset", [pad(0.1, -0.2, 0.05)]),
        impulse(8, "absolute", pad(0.3, 0.4, -0.1), 0.7, "debug", "curious"),
        ein(9.5, "baselineOverride", [pad(-0.1, 0.3, 0.2)]),
        ein(10.5, "bedtime", [.bool(true)]),
        impulse(10.6, "absolute", pad(0.7, 0.7, 0.3), 0.6, "perception", "wave"),
        ein(10.7, "nudge", [.str("Happiness"), .f(0.5), .null]),
        ein(11.5, "bedtime", [.bool(false)]),
        ein(11.5, "baselineOverride", [.null]),
        ein(11.5, "moodOffset", [pad(0, 0, 0)]),
        impulse(12, "absolute", pad(0.8, 0.9, 0.4), 1, "debug"),
        impulse(12.4, "absolute", pad(-0.6, -0.4, -0.4), 1, "debug"),
    ]))

    // Agent-state rules (cooldowns, mood-only), reports on turn edges, conditions, presence, sleepy decay.
    list.append(emotion("states", seconds: 24, [
        ein(0.2, "state", [.str("listening")]),
        ein(0.6, "state", [.str("thinking")]),
        ein(1.0, "state", [.str("engaged")]),
        ein(1.6, "state", [.str("idle")]),
        ein(2.0, "state", [.str("engaged")]),
        ein(2.5, "state", [.str("interrupted")]),
        ein(3.5, "state", [.str("confused")]),
        ein(4.5, "state", [.str("sheepish")]),
        ein(5.5, "state", [.str("notForMe")]),
        ein(6.5, "state", [.str("hasMessage")]),
        ein(7.5, "state", [.str("speaking")]),
        ein(8.0, "state", [.str("followUp")]),
        ein(8.5, "condition", [.str("voiceServicesUnreachable"), .bool(true)]),
        msg(9.0, wire([("type", .str("decisionModelUnavailable"))])),
        msg(9.1, wire([("type", .str("decisionModelUnavailable"))])),
        ein(11, "condition", [.str("voiceServicesUnreachable"), .bool(false)]),
        ein(12, "environment", [.f(0.2), .bool(false)]),
        ein(12.5, "advance", [.d(125)]),
        ein(13, "environment", [.f(0.7), .bool(true)]),
        ein(14, "environment", [.f(0.7), .null]),
        ein(14, "people", [.bool(true)]),
        ein(15, "people", [.bool(false)]),
        ein(16, "setSlowMood", [pad(0.2, 0.3, -0.2)]),
        ein(16.5, "state", [.str("drowsy")]),
        impulse(17, "absolute", pad(0.7, 0.7, 0.3), 0.6, "perception", "wave"),
        ein(20, "state", [.str("idle")]),
        ein(20.5, "connect"),
    ]))

    // The wire format: Pass A beats and cues, Pass B on audio start, late / cancelled / gated / stale, versions,
    // malformed, sad news, stances, sentence tags, Pass B brow plans and a considered reaction.
    let delightAns: [String: [String: Float]] = [
        "react": ["delight": 0.7, "playful": 0.2, "ignore": 0.1], "intensity": ["4": 0.8, "5": 0.2],
        "brow": ["raise": 0.6, "none": 0.4], "gaze": ["lookAt": 0.5, "none": 0.3, "lookAway": 0.2],
        "pupil": ["stars": 0.55, "hearts": 0.25, "none": 0.2], "move": ["bounce": 0.6, "perk": 0.3, "none": 0.1]]
    var stanceYes = feel(["Happiness": 0.7], 4.5, reaction: ("delight", 0.9), passB: true)
    stanceYes["stance"] = ["yes": 0.9, "none": 0.1]
    var stanceNo = feel(["Happiness": 0.7], 4.5, passB: true)
    stanceNo["stance"] = ["strongNo": 0.9, "none": 0.1]
    var claimed = feel(["Happiness": 0.9], 4.5, passB: true)
    claimed["stance"] = ["strongYes": 0.9, "none": 0.1]
    list.append(emotion("decisions", seconds: 30, [
        ein(0.1, "state", [.str("thinking")]),
        A(0.3, "t1", feel(["Happiness": 0.7], 4.5, intent: "joke")),
        A(1.5, "t1", feel(["Happiness": 0.75], 4.5, intent: "compliment", reaction: ("affection", 0.9))),
        B(2.0, "t1", 0, feel(["Surprise": 0.8], 4.5, passB: true)),
        ein(2.0, "state", [.str("speaking")]),
        ein(2.5, "audioStart", [.str("t1"), .i(0), .d(0.3)]),
        B(3.5, "t1", 0, feel(["Happiness": 0.6], 4, passB: true)),
        ein(4, "state", [.str("followUp")]),
        ein(4.5, "state", [.str("thinking")]),
        A(4.6, "t2", feel(["Sadness": 0.7], 4, intent: "badNews", reaction: ("delight", 0.9))),
        B(5.0, "t2", 1, feel(["Excitement": 0.8], 4.5, passB: true)),
        ein(5.2, "cancel", [.str("t2")]),
        ein(5.3, "audioStart", [.str("t2"), .i(1), .d(0)]),
        msg(5.5, wire([("type", .str("notForMe")), ("turnId", .str("t2"))])),
        msg(6, wire([("type", .str("notForMe")), ("turnId", .str("t3"))])),
        msg(6.5, decisionWire(version: 99, pass: "utterance", turn: "t3", ["feel": ["Happiness": 0.9]])),
        msg(6.6, wire([("type", .str("decision")), ("version", .i(1)), ("pass", .str("sentence")), ("turnId", .str("x"))])),
        msg(6.7, .str("[1,2]")),
        msg(6.8, wire([("type", .str("reply-end")), ("turnId", .str("t3"))])),
        ein(7.0, "state", [.str("speaking")]),
        B(7.2, "t4", 0, stanceYes, version: 2),
        B(7.2, "t4", 1, stanceNo, version: 2),
        ein(7.4, "audioStart", [.str("t4"), .i(0), .d(0.3)]),
        ein(7.4, "audioStart", [.str("t4"), .i(1), .d(1.8)]),
        A(7.6, "t4", feel(["Happiness": 0.7], 4.5, intent: "joke")),
        ein(10, "stanceNeedsClaim", [.bool(true)]),
        ein(10, "sentenceTag", [decisionWire(version: 2, pass: "sentence", turn: "t5", index: 1, claimed)]),
        ein(10, "sentenceTag", [decisionWire(version: 2, pass: "sentence", turn: "t5", index: 2,
                                             ["stance": ["no": 1]])]),
        ein(10, "sentenceTag", [decisionWire(version: 2, pass: "sentence", turn: "t9", index: 0,
                                             feel(["Sadness": 0.9], 4, passB: true))]),
        B(10.1, "t5", 0, stanceYes, version: 2),
        B(10.1, "t5", 1, claimed, version: 2),
        ein(10.2, "audioStart", [.str("t5"), .i(0), .d(0.2)]),
        ein(10.2, "audioStart", [.str("t5"), .i(1), .d(1.2)]),
        B(12, "t5", 2, ["brow": ["sceptical": 0.7, "none": 0.3], "gaze": ["lookAway": 0.6, "none": 0.4],
                        "feel": ["Skepticism": 0.8, "Neutral": 0.2], "intensity": ["3": 1]], version: 3),
        ein(12.1, "audioStart", [.str("t5"), .i(2), .d(0.1)]),
        ein(13, "state", [.str("noticing")]),
        ein(13.2, "playExpressive", [ans(delightAns), .str("gesture:wave")]),
        ein(14.5, "playExpressive", [ans(delightAns), .str("gesture:wave")]),
        ein(15.5, "playExpressive", [ans(["react": ["ignore": 1]]), .str("arrival")]),
        ein(16, "state", [.str("speaking")]),
        B(16, "t6", 3, feel(["Happiness": 0.7], 4, passB: true)),
        ein(17, "state", [.str("idle")]),
        A(20, "t7", feel(["Confusion": 0.8], 4.6, intent: "question")),
        A(21, "t8", feel(["Annoyance": 0.7], 4.5, intent: "teasing")),
        A(23, "t9", feel(["Amazement": 0.8], 5)),
    ]))

    // Every simulator script through the real layer.
    for s in ConversationSimulator.Scenario.allCases {
        list.append(emotion("sim-\(s.rawValue)", seconds: 16, [ein(0.5, "simulate", [.str(s.rawValue)])]))
    }

    // The preview's time controls: mood warp, slow motion, freeze, reset, manual reports, the 60 s heartbeat.
    list.append(emotion("mood-warp", seconds: 70, [
        ein(0.5, "setSlowMood", [pad(0.4, 0.3, -0.2)]),
        ein(0.5, "moodTimeWarp", [.f(60)]),
        impulse(5, "absolute", pad(0.8, 0.4, 0.3), 1, "debug"),
        ein(20, "moodTimeWarp", [.f(1)]),
        impulse(21, "absolute", pad(-0.6, -0.4, -0.4), 1, "debug"),
        ein(21.5, "timeScale", [.f(0.3)]),
        ein(25, "timeScale", [.f(3)]),
        impulse(26, "absolute", pad(0.8, 0.9, 0.4), 1, "debug"),
        ein(28, "timeScale", [.f(1)]),
        ein(29, "frozen", [.bool(true)]),
        impulse(29.5, "absolute", pad(0.3, 0.4, -0.1), 1, "debug"),
        ein(31, "frozen", [.bool(false)]),
        ein(33, "sendMoodReportNow"),
        ein(34, "setSlowMood", [pad(-0.3, 0.2, 0.3)]),
        ein(34, "moodTimeWarp", [.f(120)]),
        ein(40, "resetToBaseline"),
        ein(40, "moodTimeWarp", [.f(1)]),
        ein(41, "personality", [.str("shy")]),
        impulse(42, "absolute", pad(0.7, 0.7, 0.3), 1, "debug"),
    ]))
    return list
}

// MARK: - Recorder

let emotionFields = ["f", "layerTime", "felt", "mood", "emotion", "rest", "baseline", "engineMood", "mix", "mixIntensity",
                     "weight", "label", "classLabel", "runnerUp", "share", "moodLabel", "somber", "conditions",
                     "agentState", "events", "reports", "gates", "commands", "tags"]

private func n7(_ v: Float) -> J { var s = ""; num7(v, to: &s); return .num(s) }
private func v3(_ v: SIMD3<Float>) -> J { .arr([n7(v.x), n7(v.y), n7(v.z)]) }
private func opt(_ s: String?) -> J { s.map { .str($0) } ?? .null }
private func padValue(_ v: MoodReport.PADValue) -> J { .arr([n7(v.p), n7(v.a), n7(v.d)]) }

private func answers(_ j: J) -> [String: [String: Float]] {
    guard case .obj(let kv) = j else { fatalError("answers: expected an object") }
    var out: [String: [String: Float]] = [:]
    for (k, v) in kv {
        guard case .obj(let d) = v else { fatalError("answers.\(k): expected an object") }
        var m: [String: Float] = [:]
        for (n, p) in d { m[n] = p.float }
        out[k] = m
    }
    return out
}

private func describe(_ c: FaceCommand) -> J {
    switch c {
    case .playOneShot(let k): .arr([.str("playOneShot"), .str(k.rawValue)])
    case .playOneShotAt(let k, let h): .arr([.str("playOneShotAt"), .str(k.rawValue), .d(h)])
    case .reactionCue(let q):
        .arr([.str("reactionCue"), .str(q.kind.rawValue), n7(q.confidence), .str(q.source.rawValue),
              .bool(q.directedAtYanni), n7(q.valence), q.hostTime.map { .d($0) } ?? .null, .str(q.key), .i(Int(q.id))])
    case .glance(let at, let d): .arr([.str("glance"), n7(at.x), n7(at.y), n7(d)])
    case .play(let r): .arr([.str("play"), .str(r.kind.rawValue), r.intensity.map { n7($0) } ?? .null])
    default: .arr([.str("other")])
    }
}

@MainActor func recordEmotion(_ sc: Scenario) -> Recording {
    let engine = FaceEngine(seed: sc.seed, modifiers: [])
    let layer = EmotionLayer(engine: engine, wallClock: { Date(timeIntervalSince1970: 1_000_000) })
    var events: [J] = [], reports: [J] = [], gates: [J] = [], tags: [J] = []
    layer.onEvent = { e in events.append(.arr([.str(e.kind.rawValue), .str(e.text)])) }
    layer.onMoodReport = { r in
        reports.append(.obj([("trigger", .str(r.trigger.rawValue)), ("felt", padValue(r.felt)), ("mood", padValue(r.mood)),
                             ("label", .str(r.label)), ("moodLabel", .str(r.moodLabel)), ("boredom", n7(r.boredom)),
                             ("conditions", .arr(r.conditions.map { .str($0) }))]))
    }
    layer.onGate = { g in
        switch g {
        case .notForMe(let t): gates.append(.arr([.str("notForMe"), .str(t)])); engine.setAgentState(.notForMe)
        case .didNotUnderstand(let t): gates.append(.arr([.str("didNotUnderstand"), .str(t)])); engine.setAgentState(.confused)
        }
    }
    let sim = ConversationSimulator(layer: layer)
    var host = 1000.0
    layer.afterFrame(hostTime: host)
    var seenCommands = engine.state.commands.count

    func apply(_ i: Input) {
        let a = i.args
        switch i.call {
        case "state": engine.setAgentState(AgentState(rawValue: a[0].string)!)
        case "impulse":
            let p = a[1].simd3
            let target: EmotionImpulse.Target = a[0].string == "absolute" ? .absolute(p) : .relative(p)
            layer.apply(.impulse(EmotionImpulse(target, strength: a[2].float, source: ImpulseSource(rawValue: a[3].string)!,
                                                label: a[4].string)))
        case "nudge":
            layer.apply(.nudge(EmotionNudge(feeling: a[0].string, strength: a[1].float,
                                            look: a[2].isNull ? nil : NudgeLook(rawValue: a[2].string)!)))
        case "condition": layer.setCondition(EmotionCondition(rawValue: a[0].string)!, active: a[1].boolValue)
        case "message": layer.receive(data: Data(a[0].string.utf8))
        case "audioStart": layer.sentenceAudioStarted(turnId: a[0].string, index: a[1].int, hostTime: host + a[2].double)
        case "cancel": layer.cancelTurn(a[0].string)
        case "connect": layer.sessionConnected()
        case "sendMoodReportNow": layer.sendMoodReportNow()
        case "resetToBaseline": layer.resetToBaseline()
        case "environment":
            let b = a[0].float, p: Bool? = a[1].isNull ? nil : a[1].boolValue
            layer.environment = { EmotionEnvironment(boredom: b, isPresent: p) }
        case "people":
            if a[0].boolValue { engine.setPeople([PersonTarget(id: 1, position: .zero)], primary: 1, engaged: 1) }
            else { engine.setPeople([], primary: nil, engaged: nil) }
        case "bedtime": engine.setBedtime(a[0].boolValue)
        case "moodOffset": engine.setMoodOffset(a[0].simd3)
        case "personality": layer.personality = PersonalityPreset(rawValue: a[0].string)!
        case "baselineOverride": layer.baselineOverride = a[0].isNull ? nil : a[0].simd3
        case "moodTimeWarp": layer.moodTimeWarp = a[0].float
        case "timeScale": layer.timeScale = a[0].float
        case "frozen": layer.isFrozen = a[0].boolValue
        case "setSlowMood": layer.setSlowMood(a[0].simd3)
        case "advance": layer.advance(by: a[0].double)
        case "stanceNeedsClaim": layer.stanceNeedsClaim = a[0].boolValue
        case "playExpressive": _ = layer.playExpressive(answers: answers(a[0]), trigger: a[1].string)
        case "sentenceTag":
            guard case .message(.decision(let d)) = DecisionMessage.decode(Data(a[0].string.utf8)) else {
                fatalError("sentenceTag: not a decision")
            }
            let t = layer.sentenceTag(for: d)
            tags.append(.arr([t.pad.map { v3($0) } ?? .null, n7(t.strength), opt(t.answer?.rawValue)]))
        case "simulate": sim.start(ConversationSimulator.Scenario(rawValue: a[0].string)!, hostTime: host)
        default: fatalError("unknown emotion call \(i.call)")
        }
    }

    var out = String()
    let header: [(String, J)] = [
        ("scenario", .str(sc.name)), ("dt", .d(sc.dt)), ("hostTime", .str("1000+(f+1)*dt")),
        ("inputs", .arr(sc.inputs.map(\.json))), ("fields", .arr(emotionFields.map { .str($0) })),
    ]
    out += "{"
    for (k, v) in header { writeString(k, to: &out); out += ":"; v.write(to: &out); out += ",\n" }
    out += "\"frames\":[\n"
    var byFrame: [Int: [Input]] = [:]
    for i in sc.inputs { byFrame[i.frame, default: []].append(i) }
    for f in 0..<sc.frames {
        for i in byFrame[f] ?? [] { apply(i) }
        host = 1000 + Double(f + 1) * sc.dt
        layer.afterFrame(hostTime: host)
        sim.tick(hostTime: host)

        let st = engine.state
        let dyn = layer.dynamics
        let snap = layer.snapshot
        let cls = layer.classifierState
        let cmds = st.commands
        let mix: J = st.emotionMix.map { m in .arr(m.entries.map { .arr([.str($0.name), n7($0.weight)]) }) } ?? .null
        let frame = J.obj([
            ("f", .i(f)), ("layerTime", .d(layer.layerTime)), ("felt", v3(dyn.felt)), ("mood", v3(dyn.mood)),
            ("emotion", v3(dyn.emotion)), ("rest", v3(dyn.rest)), ("baseline", v3(dyn.baseline)),
            ("engineMood", .arr([n7(st.baseMood.pleasure), n7(st.baseMood.arousal), n7(st.baseMood.dominance)])),
            ("mix", mix), ("mixIntensity", st.emotionMix.map { n7($0.intensity) } ?? .null), ("weight", n7(st.emotionWeight)),
            ("label", .str(layer.label)), ("classLabel", opt(cls.labelName)), ("runnerUp", opt(cls.runnerUpName)),
            ("share", n7(cls.runnerUpShare)), ("moodLabel", .str(snap.moodLabel)), ("somber", .bool(snap.somber)),
            ("conditions", .arr(snap.conditions.map { .str($0.rawValue) })), ("agentState", .str(st.agentState.rawValue)),
            ("events", .arr(events)), ("reports", .arr(reports)), ("gates", .arr(gates)),
            ("commands", .arr(cmds[seenCommands...].map(describe))), ("tags", .arr(tags)),
        ])
        seenCommands = cmds.count
        events.removeAll(); reports.removeAll(); gates.removeAll(); tags.removeAll()
        if f > 0 { out += ",\n" }
        frame.write(to: &out)
    }
    out += "\n]}\n"
    return Recording(text: out, seen: [], frameCount: sc.frames)
}
