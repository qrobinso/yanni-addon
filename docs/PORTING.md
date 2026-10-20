# Porting rules (Swift → TypeScript)

Every agent porting code follows these rules. The goal is the same motion, frame for frame. Never re-design while porting: port what the Swift does, including its quirks, and write a `// port-note:` comment where a quirk looks wrong.

## Source of truth
- Swift sources: `../yanni/Packages/*/Sources/**`. **Read-only. Never edit anything under `../yanni`.**
- Behaviour spec: `../yanni/docs/spec.md`.
- File mapping is one to one: `Packages/YanniFace/Sources/FaceEngine/Modifiers/Blink.swift` → `web/src/engine/modifiers/Blink.ts`. Keep type, function and constant names (in camelCase) and keep the doc comments, shortened, so anyone can diff the two side by side.

## Types
| Swift | TypeScript |
|---|---|
| `Float`, `Double` | `number` |
| `SIMD2/3/4<Float>` | `V2`/`V3`/`V4` from `web/src/core/vec.ts`: plain mutable `{x,y}`, `{x,y,z}`, `{x,y,z,w}` objects with free functions (`add`, `mul`, `scale`…). Hot paths may mutate in place to avoid allocation per frame. |
| `struct` (value semantics) | `interface` + a `clone…()` helper, or a class with `copy()`. **Watch value semantics:** Swift copies on assignment and TS doesn't. Copy wherever the Swift relies on a copy. |
| `enum` without payload | `const` string union, e.g. `type AgentState = 'idle' \| 'noticing' \| …`. Raw-valued enums keep their raw values. |
| `enum` with payloads | a discriminated union `{ kind: 'glance', at: V2, duration: number }`. |
| `OptionSet` | a number bit mask with named `const`s. |
| `UInt64` | `bigint` only inside `SplitMix64`. Never elsewhere. |
| `@MainActor`, `Sendable`, `Synchronization` | dropped (single-threaded). |
| `os` logging and signposts | `web/src/core/log.ts` (`log.debug(category, …)`), a no-op by default. |

## Numerics
- `SplitMix64` (`web/src/core/random.ts`) reproduces the Swift sequence bit for bit, including `unit()`, `uniform`, `chance`, `gaussian`, `lognormal`, `inEllipse` and `weightedIndex`. Consume random numbers in **exactly** the same order as the Swift, because one extra call desynchronises every scenario after it.
- `sinf`/`cosf`/`expf`/`logf` become `Math.sin` and so on. Swift `Float` math rounds to float32 at every step and JS uses float64, so traces drift slightly. Golden comparisons use a tolerance (default 1e-3 absolute, 1e-4 relative). If a branch flips because a value sits right on a threshold, wrap that value in `Math.fround` and add a `// f32:` comment.
- `min`/`max`/clamps keep their argument order (NaN behaviour). `x.isFinite` → `Number.isFinite(x)`.
- `&+=` on counters → plain `+=` (they never overflow in practice), except inside the RNG.
- `truncatingRemainder(dividingBy:)` → `%` (same sign rule for positive divisors). `.rounded()` (schoolbook rounding) → `Math.sign(x) * Math.round(Math.abs(x))`, not `Math.round`.

## Tests
- Port each Swift test file to Vitest next to the code's mirror path: `Tests/FaceEngineTests/BlinkTests.swift` → `web/test/engine/Blink.test.ts`. Swift Testing's `@Test(arguments:)` becomes `test.each`.
- Golden parity tests live in `web/test/golden/` and load `fixtures/golden/*.json` through `web/test/golden/harness.ts`.
- `npm test` (from the repo root) must stay green. Don't skip a failing parity test: find the divergence (the harness reports the first diverging frame and field).

## Golden trace format
`fixtures/golden/<scenario>.json`:
```json
{ "scenario": "idle-10min", "seed": "0x59414E4E49", "dt": 0.016666666666666666,
  "inputs": [ { "frame": 0, "call": "setAgentState", "args": ["idle"] }, … ],
  "fields": ["pose", "brightness", …],
  "frames": [ { "f": 0, "pose": [51 floats], "brightness": 1, …, "oneShots": ["blink"] }, … ] }
```
Each frame is recorded after `tick(dt)`. Inputs are applied before the tick of their frame. Long scenarios record every frame but may be stored as `.json.gz`.

## Style
- ES modules, `strict`, no `any` without a comment, no classes where the Swift has a free function.
- No per-frame allocation in the engine and renderer hot paths, apart from the temporaries a JS engine optimises away. Reuse scratch objects as the Swift reuses arrays (`removeAll(keepingCapacity:)` → `arr.length = 0`).
- Comments: only the why, as in the Swift.
