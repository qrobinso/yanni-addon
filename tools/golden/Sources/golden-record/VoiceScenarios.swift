import FaceModel
import FaceVoice
import Foundation

// Voice scenarios (WP12): the procedural voice through its public API, written to fixtures/golden/voice/*.json.gz.
// - plan level (reactions, babble, laughfit, params): every note's fields, compared exactly for discrete fields and
//   within a float tolerance otherwise (Swift plans in Float32, the port in float64);
// - pcm: VoiceRenderer output as little-endian Int16 (base64) plus peak and RMS, compared with a tolerance.
// Registered in Scenarios.swift (`list += voiceScenarios()`); each records itself through `Scenario.custom`.

private let voicePrefix = "voice/"
private let voiceNames = ["reactions", "babble", "laughfit", "params", "pcm"]

@MainActor func voiceScenarios() -> [Scenario] {
    voiceNames.map { Scenario(name: voicePrefix + $0, modifiers: "voice", frames: 0, custom: voiceRecord) }
}

@MainActor private func voiceRecord(_ sc: Scenario) -> Recording {
    let name = String(sc.name.dropFirst(voicePrefix.count))
    let body: [(String, J)]
    switch name {
    case "reactions": body = voiceReactions()
    case "babble": body = voiceBabble()
    case "laughfit": body = voiceLaughFit()
    case "params": body = voiceParams()
    case "pcm": body = voicePCM()
    default: fatalError("unknown voice scenario \(name)")
    }
    var s = ""
    J.obj([("scenario", .str(sc.name)), ("kind", .str("voice")), ("noteFields", .arr(noteFields.map { .str($0) }))] + body)
        .write(to: &s)
    s += "\n"
    return Recording(text: s, seen: [], frameCount: 0)
}

// MARK: - Encoding

private let noteFields = [
    "start", "duration",
    "contour.start", "contour.end", "contour.glideOnset", "contour.glideEase", "contour.scoop", "contour.scoopTau",
    "contour.wobbleDepth", "contour.wobbleRate", "contour.trillDepth", "contour.trillRate", "contour.droop",
    "contour.droopFraction",
    "timbre.sine", "timbre.square", "timbre.fm", "timbre.fmRatio", "timbre.fmIndexPeak", "timbre.fmIndexSustain",
    "timbre.fmIndexTau", "timbre.cutoff", "timbre.filterEnvOctaves", "timbre.filterEnvTau", "timbre.resonance",
    "timbre.noiseDB", "timbre.noiseBurst", "timbre.noiseFreq", "timbre.noiseBandPass", "timbre.vowelStart",
    "timbre.vowelEnd", "timbre.formantAmount",
    "envelope.attackTau", "envelope.sustain", "envelope.decayFraction", "envelope.release",
    "modulation.vibratoDepth", "modulation.vibratoRate", "modulation.vibratoDelay", "modulation.vibratoFadeIn",
    "modulation.tremoloDepth", "modulation.tremoloRate",
    "gain", "slur", "accent",
]

private func b(_ v: Bool) -> J { .i(v ? 1 : 0) }

private func note(_ n: Note) -> J {
    let c = n.contour, t = n.timbre, e = n.envelope, m = n.modulation
    return .arr([
        .f(n.start), .f(n.duration),
        .f(c.start), .f(c.end), .f(c.glideOnset), .f(c.glideEase), .f(c.scoop), .f(c.scoopTau),
        .f(c.wobbleDepth), .f(c.wobbleRate), .f(c.trillDepth), .f(c.trillRate), .f(c.droop), .f(c.droopFraction),
        .f(t.sine), .f(t.square), .f(t.fm), .f(t.fmRatio), .f(t.fmIndexPeak), .f(t.fmIndexSustain), .f(t.fmIndexTau),
        .f(t.cutoff), .f(t.filterEnvOctaves), .f(t.filterEnvTau), .f(t.resonance), .f(t.noiseDB), .f(t.noiseBurst),
        .f(t.noiseFreq), b(t.noiseBandPass), .f(t.vowelStart), .f(t.vowelEnd), .f(t.formantAmount),
        .f(e.attackTau), .f(e.sustain), .f(e.decayFraction), .f(e.release),
        .f(m.vibratoDepth), .f(m.vibratoRate), .f(m.vibratoDelay), .f(m.vibratoFadeIn), .f(m.tremoloDepth),
        .f(m.tremoloRate),
        .f(n.gain), b(n.slur), b(n.accent),
    ])
}

private func phrase(_ p: Phrase) -> J {
    var notes: [J] = []
    for i in 0..<p.notes.count { notes.append(note(p.notes[i])) }
    return .obj([("reaction", .str(String(describing: p.reaction))), ("duration", .f(p.duration)), ("notes", .arr(notes))])
}

private func affectJ(_ a: VoiceAffect) -> J { .arr([.f(a.pleasure), .f(a.arousal), .f(a.dominance)]) }
private func seedJ(_ s: UInt64) -> J { .str(String(format: "0x%llX", s)) }

private let affects: [(String, VoiceAffect)] = [
    ("neutral", .neutral),
    ("happy", VoiceAffect(pleasure: 0.8, arousal: 0.6, dominance: 0.4)),
    ("sad", VoiceAffect(pleasure: -0.7, arousal: -0.5, dominance: -0.3)),
    ("scared", VoiceAffect(pleasure: -0.4, arousal: 0.8, dominance: -0.7)),
    ("sleepy", VoiceAffect(pleasure: 0.1, arousal: -0.8, dominance: -0.2)),
]
private let defaultSeed: UInt64 = 0x564F494345

// MARK: - Plan scenarios

/// Per seed and mood, one generator makes every reaction twice in a row (the second exercises the novelty re-rolls).
private func voiceReactions() -> [(String, J)] {
    var runs: [J] = []
    for seed in [defaultSeed, 1, 0xDEADBEEF] {
        for (name, a) in affects {
            var g = PhraseGenerator(fingerprint: .bundled(), seed: seed)
            var phrases: [J] = []
            for r in VoiceReaction.allCases {
                for _ in 0..<2 { phrases.append(phrase(g.make(r, affect: a))) }
            }
            runs.append(.obj([("seed", seedJ(seed)), ("affect", .str(name)), ("pad", affectJ(a)), ("phrases", .arr(phrases))]))
        }
    }
    return [("reactions", .arr(VoiceReaction.allCases.map { .str(String(describing: $0)) })), ("runs", .arr(runs))]
}

private struct BabbleCase { var text: String; var answer: VoiceReaction?; var isLast = false; var seed: UInt64
    var sentenceCap: Float = 1.5; var budget: Float = 6 }

private let babbleCases: [BabbleCase] = [
    BabbleCase(text: "Hello there, how are you today? Great!", answer: .mmHm, seed: 7),
    BabbleCase(text: "No. I don't think so.", answer: .nuhUh, seed: 8),
    BabbleCase(text: "Sure!", answer: nil, seed: 9),
    BabbleCase(text: "The weather today is mostly sunny with a few clouds in the afternoon and a light breeze from the west, so it is a good day for a walk.", answer: nil, seed: 10),
    BabbleCase(text: "Dr. Smith said it's 42 degrees — wow; really?", answer: .uhUh, isLast: true, seed: 11),
    BabbleCase(text: "Yes, absolutely! The lights are on in the kitchen, the hallway and the living room.", answer: .mmHmBig, seed: 12, sentenceCap: 1.2, budget: 2.5),
    BabbleCase(text: "Okay.", answer: nil, seed: 13, budget: 0.2),
    BabbleCase(text: "Café naïve 東京 tables makes boxes turned wanted free.", answer: nil, isLast: true, seed: 14),
]

private func babbleTextJ(_ t: BabbleText) -> J {
    .arr(t.sentences.map { s in
        .obj([("ending", .str(String(describing: s.ending))),
              ("clauses", .arr(s.clauses.map { c in .obj([("words", .arr(c.words.map { .i($0) })), ("comma", .bool(c.endsWithComma))]) }))])
    })
}

private func voiceBabble() -> [(String, J)] {
    var runs: [J] = []
    for (name, a) in [affects[0], affects[1], affects[2]] {
        var g = PhraseGenerator(fingerprint: .bundled(), seed: defaultSeed)
        var plans: [J] = []
        for c in babbleCases {
            let req = BabbleRequest(text: c.text, affect: a, isLast: c.isLast, answer: c.answer, seed: c.seed,
                                    sentenceCap: c.sentenceCap, budget: c.budget)
            let p = g.makeBabble(req)
            plans.append(.obj([
                ("text", .str(c.text)), ("answer", c.answer.map { .str(String(describing: $0)) } ?? .null),
                ("isLast", .bool(c.isLast)), ("seed", seedJ(c.seed)), ("sentenceCap", .f(c.sentenceCap)), ("budget", .f(c.budget)),
                ("items", .arr(p.items.map { .obj([("offset", .f($0.offset)), ("sentence", .i($0.sentence)), ("phrase", phrase($0.phrase))]) })),
                ("planAnswer", p.answer.map { .str(String(describing: $0)) } ?? .null),
                ("syllables", .i(p.syllables)), ("textSyllables", .i(p.textSyllables)), ("sentences", .i(p.sentences)),
                ("droppedSentences", .i(p.droppedSentences)), ("compressed", .bool(p.compressed)),
                ("sentenceDurations", .arr(p.sentenceDurations.map { .f($0) })), ("nextGap", .f(p.nextGap)),
                ("duration", .f(p.duration)), ("lastNoteEnd", .f(p.lastNoteEnd)),
            ]))
        }
        runs.append(.obj([("affect", .str(name)), ("pad", affectJ(a)), ("plans", .arr(plans))]))
    }
    let words = ["make", "time", "table", "free", "turned", "wanted", "makes", "boxes", "Café", "東京", "42", "don't",
                 "rhythm", "a", "queue", "beautiful", "—", "x1"]
    let texts = babbleCases.map(\.text) + ["Mr. Brown is here. Is he? Yes… e.g. this", "  \n ", "One, two; three: four – five"]
    return [
        ("runs", .arr(runs)),
        ("syllables", .arr(words.map { w in .obj([("word", .str(w)), ("count", .i(SyllableCounter.count(word: Substring(w))))]) })),
        ("texts", .arr(texts.map { t in
            .obj([("text", .str(t)), ("count", .i(SyllableCounter.count(t))), ("sentences", babbleTextJ(BabbleText(t))),
                  ("sentenceStrings", .arr(BabbleText.sentenceStrings(t).map { .str($0) }))])
        })),
    ]
}

private func voiceLaughFit() -> [(String, J)] {
    let steps: [(LaughFitPart, Float)] = [(.laugh, 0.3), (.laugh, 0.6), (.laugh, 0.9), (.laugh, 1), (.laugh, 0.8),
                                          (.laugh, 0.5), (.laugh, 0.2), (.hehe, 0.4), (.hehe, 0.3), (.sigh, 0.3)]
    var runs: [J] = []
    for (name, a) in [affects[0], affects[1]] {
        var g = PhraseGenerator(fingerprint: .bundled(), seed: defaultSeed)
        var phrases: [J] = []
        for (part, e) in steps {
            phrases.append(.obj([("part", .str(String(describing: part))), ("energy", .f(e)),
                                 ("phrase", phrase(g.makeLaughFit(part, energy: e, affect: a)))]))
        }
        runs.append(.obj([("affect", .str(name)), ("pad", affectJ(a)), ("phrases", .arr(phrases))]))
    }
    return [("runs", .arr(runs))]
}

@MainActor private let paramFields: [(String, (PhraseParams) -> Float)] = [
    ("pleasure", \.pleasure), ("arousal", \.arousal), ("dominance", \.dominance), ("p01", \.p01), ("a01", \.a01),
    ("d01", \.d01), ("speed01", \.speed01), ("noteCount", \.noteCount), ("noteDuration", \.noteDuration), ("gap", \.gap),
    ("swing", \.swing), ("register", \.register), ("intervalWidth", \.intervalWidth), ("glideBias", \.glideBias),
    ("phraseTrend", \.phraseTrend), ("cutoff", \.cutoff), ("vowel", \.vowel), ("articulation", \.articulation),
    ("fmIndexPeak", \.fmIndexPeak), ("fmIndexSustain", \.fmIndexSustain), ("attackTau", \.attackTau),
    ("sustain", \.sustain), ("release", \.release), ("gainDB", \.gainDB), ("wobbleDepth", \.wobbleDepth),
    ("wobbleRate", \.wobbleRate), ("vibratoDepth", \.vibratoDepth), ("vibratoRate", \.vibratoRate),
    ("nervous", { $0.nervous ? 1 : 0 }), ("scoop", \.scoop), ("questionChance", \.questionChance),
]

@MainActor private func voiceParams() -> [(String, J)] {
    let g = PhraseGenerator(fingerprint: .bundled(), seed: defaultSeed)
    let grid: [Float] = [-1.2, -1, -0.5, -0.15, 0, 0.1, 0.5, 1]
    var rows: [J] = []
    for p in grid { for a in grid { for d in grid {
        let m = g.parameters(for: VoiceAffect(pleasure: p, arousal: a, dominance: d))
        rows.append(.arr([.f(p), .f(a), .f(d)] + paramFields.map { .f($0.1(m)) }))
    } } }
    return [("fields", .arr(paramFields.map { .str($0.0) })), ("rows", .arr(rows))]
}

// MARK: - PCM

private func pcmJ(_ x: [Float]) -> [(String, J)] {
    var peak: Float = 0, sum: Double = 0
    var data = Data(capacity: x.count * 2)
    for v in x {
        peak = max(peak, abs(v)); sum += Double(v) * Double(v)
        let q = Int16(max(-32767, min(32767, (v * 32767).rounded())))
        withUnsafeBytes(of: q.littleEndian) { data.append(contentsOf: $0) }
    }
    let rms = x.isEmpty ? 0 : Float((sum / Double(x.count)).squareRoot())
    return [("frames", .i(x.count)), ("peak", .f(peak)), ("rms", .f(rms)), ("int16", .str(data.base64EncodedString()))]
}

private let pcmHost: Double = 1.0

/// One phrase alone, rendered in a single buffer that starts at its start host time.
private func renderAlone(_ p: Phrase, rate: Double, stretch: Float = 1) -> [Float] {
    let r = VoiceRenderer(sampleRate: rate)
    r.setFingerprint(.bundled())
    _ = r.enqueue(p, startHostTime: HostClock.ticks(pcmHost), timeStretch: stretch)
    let n = Int((Double(p.duration * stretch) + 0.05) * rate)
    var out = [Float](repeating: 0, count: n)
    out.withUnsafeMutableBufferPointer { r.render(frameCount: n, hostTime: HostClock.ticks(pcmHost), into: $0.baseAddress!) }
    return out
}

/// Scripted mix: overlapping phrases, a cancel, a re-enqueue, volume and mute ramps, in 512-frame buffers at 48 kHz.
/// Events happen before the render of buffer `k`.
private func renderMix(_ g: inout PhraseGenerator) -> ([Float], [J]) {
    let rate = 48000.0, frames = 512
    let r = VoiceRenderer(sampleRate: rate)
    r.setFingerprint(.bundled())
    let a = g.make(.engaged, affect: .neutral), b = g.make(.delighted, affect: .neutral)
    let c = g.make(.curious, affect: .neutral), d = g.make(.sleepy, affect: .neutral)
    var events: [J] = []
    var out: [Float] = []
    var buf = [Float](repeating: 0, count: frames)
    for k in 0..<120 {
        func ev(_ what: String, _ args: [J] = []) { events.append(.obj([("buffer", .i(k)), ("call", .str(what)), ("args", .arr(args))])) }
        switch k {
        case 0:
            _ = r.enqueue(a, startHostTime: HostClock.ticks(pcmHost), timeStretch: 1); ev("enqueue", [.i(0), .d(pcmHost), .f(1)])
            _ = r.enqueue(b, startHostTime: HostClock.ticks(pcmHost + 0.15), timeStretch: 1); ev("enqueue", [.i(1), .d(pcmHost + 0.15), .f(1)])
        case 30: r.cancelAll(); ev("cancelAll")
        case 31:
            _ = r.enqueue(c, startHostTime: HostClock.ticks(pcmHost + 0.4), timeStretch: 1.5); ev("enqueue", [.i(2), .d(pcmHost + 0.4), .f(1.5)])
            _ = r.enqueue(d, startHostTime: HostClock.ticks(pcmHost + 0.5), timeStretch: 1); ev("enqueue", [.i(3), .d(pcmHost + 0.5), .f(1)])
        case 50: r.setVolume(0.5); ev("setVolume", [.f(0.5)])
        case 70: r.setMuted(true); ev("setMuted", [.bool(true)])
        case 80: r.setMuted(false); ev("setMuted", [.bool(false)])
        case 90: r.setGain(0.5); ev("setGain", [.f(0.5)])
        default: break
        }
        let host = pcmHost + Double(k * frames) / rate
        buf.withUnsafeMutableBufferPointer { r.render(frameCount: frames, hostTime: HostClock.ticks(host), into: $0.baseAddress!) }
        out += buf
    }
    return (out, [("phrases", .arr([phrase(a), phrase(b), phrase(c), phrase(d)])), ("events", .arr(events))].map { J.obj([$0]) })
}

private func voicePCM() -> [(String, J)] {
    var g = PhraseGenerator(fingerprint: .bundled(), seed: defaultSeed)
    var renders: [J] = []
    func add(_ label: String, _ p: Phrase, rate: Double, stretch: Float = 1) {
        renders.append(.obj([("label", .str(label)), ("rate", .d(rate)), ("stretch", .f(stretch)), ("phrase", phrase(p))]
                            + pcmJ(renderAlone(p, rate: rate, stretch: stretch))))
    }
    for r in VoiceReaction.allCases { add(String(describing: r), g.make(r, affect: .neutral), rate: 48000) }
    add("sleepy-24k", g.make(.sleepy, affect: affects[4].1), rate: 24000)
    add("delighted-16k", g.make(.delighted, affect: affects[1].1), rate: 16000)
    add("giggle-stretch2", g.make(.giggle, affect: affects[1].1), rate: 48000, stretch: 2)
    add("startled-scared", g.make(.startled, affect: affects[3].1), rate: 44100)
    let (mix, meta) = renderMix(&g)
    var mixObj: [(String, J)] = [("label", .str("mix")), ("rate", .d(48000)), ("buffer", .i(512))]
    for m in meta { if case .obj(let kv) = m { mixObj += kv } }
    renders.append(.obj(mixObj + pcmJ(mix)))
    return [("renders", .arr(renders))]
}
