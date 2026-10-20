# Golden trace format

Recorded by `tools/golden` (`golden-record`) from the real Swift `FaceEngine` (and `LifeCycleController` for `life-*`). Re-record:

```sh
cd tools/golden
swift run -c release golden-record                 # all scenarios into fixtures/golden
swift run -c release golden-record touch rest-core # just these
swift run -c release golden-record --check         # records twice, asserts byte-identical output, fails on stale fixtures
swift run -c release golden-record --list          # scenario names
```

Files over 5 MB are stored as `<name>.json.gz` (`gzip -n -9`, so the bytes stay the same between runs). `layout.json` lists the pose and brow names in index order, plus every `OneShotKind` and `AgentState`.

## File

```json
{ "scenario": "touch", "seed": "0x59414E4E49", "dt": 0.016666666666666666,
  "modifiers": "default", "life": false, "hostTime": "(f+1)*dt",
  "inputs": [ { "frame": 0, "call": "setEdgeGeometry", "args": [ { … } ] }, … ],
  "fields": [ "f", "pose", … ],
  "frames": [ { "f": 0, "pose": [ …51 ], … }, … ] }
```

- `seed`: the `FaceEngine(seed:)` value, hex.
- `modifiers`: `"default"` = `FaceEngine.makeDefaultModifiers()`, `"core"` = `[OneShotSampler(), OneShotApply()]` (the engine-core gate).
- `life`: true when a `LifeCycleController` runs after every tick (see Life below).
- Frame loop for frame `f` (0-based): (1) apply every input with `frame == f`, in file order; (2) `engine.tick(dt: dt, hostTime: (f+1)*dt)`; (3) life only: set the simulated clock to `(f+1)*dt`, call `life.afterFrame(hostTime: (f+1)*dt)`; (4) record. The frame fields come from the `FaceFrame` that tick returned. `oneShots`, `agentState` and `mood` come from `engine.state` after step 3.
- The frame count is `frames.length`. `oneshot-*` scenarios stop 60 frames after the kind stops being active, capped at 40 s.

## Numbers
Frame values are rounded to 7 significant digits (`%.7g`, integers written plain). Non-finite values are written as `null`, though none occur today. Args are written with 9 significant digits (`%.9g`, an exact Float32 round trip) and Double args with 17 (`%.17g`). The recorder parses args back from that same text, so the file holds exactly what was applied.

## Frame fields (in `fields` order)
| field | type | notes |
|---|---|---|
| `f` | int | frame index |
| `pose` | 51 floats | `FacePose.raw[0..<51]` in `ParamLayout` order (table below) |
| `brightness` | float | |
| `wantsHighFrameRate`, `isAsleep` | bool | |
| `color` | [r,g,b] | linear RGB |
| `closureScale` | [x,y] | |
| `stageOffset` | [x,y] | canvas units, +y down |
| `eyeStageOffset` | [lx,ly,rx,ry] | |
| `pupilShape` | [left,right] | `PupilShape` raw values (UInt8) |
| `pupilMorph` | [left,right] | |
| `pupilShapeScale` | [lx,ly,rx,ry] | |
| `brows` | 18 floats | `BrowLayout.usedIndices` order: `BrowPose.raw[0...8]` (left), then `raw[16...24]` (right) (table below) |
| `browPresence` | float | |
| `browOffset` | [lx,ly,rx,ry] | |
| `backgroundColor` | [r,g,b] | |
| `backgroundStrength`, `backgroundPresence`, `backgroundBrightness` | float | |
| `glowLevel`, `glowHeight`, `glowMotion`, `glowRipple` | float | |
| `glowColor`, `glowColor2` | [r,g,b] | |
| `glowPhase` | [drift,w1,w2,w3] | radians |
| `captionInset` | float | |
| `oneShots` | [string] | `engine.state.activeOneShots` rawValues, in the engine's order |
| `agentState` | string | `engine.state.agentState` rawValue |
| `mood` | [P,A,D] | `engine.state.mood` (effective: base + offset) |

Life scenarios add: `moodOffset` [x,y,z] (`state.moodOffset`), `lifePhase` (`LifePhase` rawValue), `lifeIsBedtime`, `lifeIsPresent`, `lifeBoredom` (float), `lifeIsSinkingToSleep`, `lifeIsForceSleepActive`, `lifeIsNightAwake`.

### Pose index → `ParamLayout.names`
| i | name | i | name | i | name |
|---|---|---|---|---|---|
| 0 | face.center_x | 17 | left.upper_outer_radius_y | 34 | right.upper_inner_radius_y |
| 1 | face.center_y | 18 | left.upper_lid.y | 35 | right.upper_outer_radius_x |
| 2 | face.scale_x | 19 | left.upper_lid.angle | 36 | right.upper_outer_radius_y |
| 3 | face.scale_y | 20 | left.upper_lid.bend | 37 | right.upper_lid.y |
| 4 | face.angle | 21 | left.lower_lid.y | 38 | right.upper_lid.angle |
| 5 | left.center_x | 22 | left.lower_lid.angle | 39 | right.upper_lid.bend |
| 6 | left.center_y | 23 | left.lower_lid.bend | 40 | right.lower_lid.y |
| 7 | left.scale_x | 24 | right.center_x | 41 | right.lower_lid.angle |
| 8 | left.scale_y | 25 | right.center_y | 42 | right.lower_lid.bend |
| 9 | left.angle | 26 | right.scale_x | 43 | left.pupil.x |
| 10 | left.lower_inner_radius_x | 27 | right.scale_y | 44 | left.pupil.y |
| 11 | left.lower_inner_radius_y | 28 | right.angle | 45 | left.pupil.size |
| 12 | left.lower_outer_radius_x | 29 | right.lower_inner_radius_x | 46 | left.pupil.squash |
| 13 | left.lower_outer_radius_y | 30 | right.lower_inner_radius_y | 47 | right.pupil.x |
| 14 | left.upper_inner_radius_x | 31 | right.lower_outer_radius_x | 48 | right.pupil.y |
| 15 | left.upper_inner_radius_y | 32 | right.lower_outer_radius_y | 49 | right.pupil.size |
| 16 | left.upper_outer_radius_x | 33 | right.upper_inner_radius_x | 50 | right.pupil.squash |

### Brows index → `BrowLayout.names`
| i | name | i | name |
|---|---|---|---|
| 0 | left.brow.x | 9 | right.brow.x |
| 1 | left.brow.y | 10 | right.brow.y |
| 2 | left.brow.rotation | 11 | right.brow.rotation |
| 3 | left.brow.width | 12 | right.brow.width |
| 4 | left.brow.thickness | 13 | right.brow.thickness |
| 5 | left.brow.curvature | 14 | right.brow.curvature |
| 6 | left.brow.inner | 15 | right.brow.inner |
| 7 | left.brow.outer | 16 | right.brow.outer |
| 8 | left.brow.peak | 17 | right.brow.peak |

## Input calls
Each `call` is the Swift method name and `args` its positional arguments. Enum cases are written by rawValue, SIMD values as arrays, structs as objects, and Swift `nil` as `null`.

| call | args | Swift |
|---|---|---|
| `setAgentState` | `[state]` | `setAgentState(AgentState(rawValue:))` |
| `setMood` | `[{pleasure, arousal, dominance}]` | `setMood(Mood(...))` |
| `setMoodOffset` | `[[x,y,z]]` | `setMoodOffset(SIMD3)` |
| `setPeople` | `[[person…], primary\|null, engaged\|null]` | `setPeople(_:primary:engaged:)` (always the 3-argument form) |
| `send` | `[command]` | `send(FaceCommand)`, see below |
| `setEdgeGeometry` | `[geometry\|null]` | `setEdgeGeometry(EdgeGeometry(...))` |
| `setBedtime` | `[bool]` | |
| `setSpeechLevel`, `setListeningGlow`, `setListeningVoice`, `setListeningLevel` | `[float]` | |
| `setCaptionInset` | `[fraction, reduceMotion]` | `setCaptionInset(_:reduceMotion:)` |
| `playPupilShape` | `[kind, leadEye\|null]` | `playPupilShape(_:leadEye:)` |
| `cancelPupilShape` | `[]` | |
| `playEdgeAntic` | `[kind, side]` | `playEdgeAntic(_:side:)` |
| `cancelEdgeAntics` | `[includingSink?]` | |
| `playIdleGame` | `[kind, side]` | `playIdleGame(_:side:)` |
| `cancelIdleGames` | `[]` | |
| `noteFriendlyTouch` | `[hostTime]` (Double) | `noteFriendlyTouch(until:)`. It reads the previous frame's host time, `f*dt`, because step 2 has not run yet |
| `fadeInFromBlack` | `[]` | |
| `life.settings` | `[{key: value…}]` | `life.settings = LifeSettings()` with these keys overridden: `minutesToDrowsy`, `minutesToAsleep`, `manualBedtime`, `tapsToWake`, `wakeOnMotionAtBedtime`, `bedtimeAwakeMinutes`, `idleMoodDrift`, `aloneTakeoverMinutes` |
| `life.forceSleep` | `[duration\|null]` | `life.forceSleep(for:)` |
| `life.forceWake`, `life.noteActivity` | `[]` | |

Objects:
- person: `{id, position:[x,y], distance, salience, facing, lookingAtMe}` maps to `PersonTarget(id:position:distance:salience:facing:lookingAtMe:)`.
- geometry: `{visibleHalfExtent, leftEyeCenter, rightEyeCenter, leftEyeHalfSize, rightEyeHalfSize, leftBrowCenter, leftBrowHalfSize, rightBrowCenter, rightBrowHalfSize}`, each `[x,y]`, maps to `EdgeGeometry.init`. The scenarios use `EdgeGeometry.fitting(width: 1180, height: 820, style: RenderStyle())` (FaceRendering), recorded as numbers so the harness needs no renderer.
- command, `{"case": …, …}`: `playOneShot {kind}`, `glance {at:[x,y], duration}`, `stimulus {at, strength}`, `restGaze {at}`, `blink {}`, `tap {at}`, `scratch {at, intensity}`, `attend {personID|null}`.

## Life
`LifeCycleController(engine:clock:calendar:)` runs with default `LifeSettings` (unless `life.settings` overrides them) and a simulated clock: `monotonic = (f+1)*dt` and `now = Date(timeIntervalSince1970: 1_800_000_000 + monotonic)`, which is 2027-01-15 08:00 UTC, with a Gregorian calendar in GMT. `timeWarp` stays at 1. There is no store.

## Scenarios
`rest-core`, `rest-default`, `idle-10min`, `noticing-3min`, `oneshot-<kind>` (every `OneShotKind`: settle until 1 s, then `send playOneShot`; screen-edge antics use `playEdgeAntic(side: 1)` and idle games `playIdleGame(side: 1)`), `states-tour`, `mood-sweep`, `engage-interrupt`, `pupil-shapes`, `glow-caption`, `touch`, `life-sleep-wake`, `life-catch-self`, `life-bedtime`, `life-force`. The `inputs` in each file are the full script. Every scenario except `rest-*` starts with `setEdgeGeometry` on frame 0.
