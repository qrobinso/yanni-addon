# MediaPipe → FrameDetections

The browser front end (`MediaPipeDetector.ts`, `MediaPipeMapping.ts`) produces the same `FrameDetections` the Swift app's
`VisionDetector` produces, so the ported tracker, eye contact, engagement and gestures run unchanged.

**Models** (`web/scripts/fetch-models.mjs`, SHA-256 pinned, served from `public/models/`): `face_landmarker.task`
(float16/1), `hand_landmarker.task` (float16/1), `pose_landmarker_lite.task` (float16/1). Runtime: `@mediapipe/tasks-vision`
1.1.1 (exact pin), its wasm copied to `public/mediapipe/`. All tasks use VIDEO mode and the GPU delegate, falling back to
the CPU when WebGL2 can't start.

**Coordinates.** MediaPipe landmarks are normalised to the camera's own (unmirrored) image, origin top-left, y down. The
viewer frame is that image mirrored for the front camera: `x' = 1 − x`, `y' = y`. Browsers deliver camera frames already
upright for the current orientation, so there is no rotation step (Vision needed the EXIF orientation).

## Fields

| FrameDetections field | MediaPipe source | Notes |
|---|---|---|
| `time` | `requestVideoFrameCallback` `captureTime` (else the callback time), `performance.now()` seconds | The coordinator's clock is the same timeline. |
| `intrinsics` | **none** | `CameraIntrinsics.fromFieldOfView(w, h, settings.horizontalFovDegrees)`. The browser can't read the lens: the perception setting `horizontalFovDegrees` (default **80°**; typical tablet front cameras run 75–85°, iPad ultra-wide front cameras ≈ 106° without Center Stage cropping) is **measured** by Tune → Perception → Camera offset & calibration → Camera field of view: standing alone at a taped mark, the pupil distance in pixels against the 63 mm adult mean gives the focal length (median over 3 s, yaw-corrected; ±15 % from the person's own IPD). Saved through the settings hub (`perception_tunables`); the worker reads it from the processor's settings, so it applies on the next frame. Distances and every angle scale with it. |
| `faces[].box` | extent of the 478 face landmarks, mirrored | Cheek to cheek (234↔454) by forehead to chin. Width matches `DistanceEstimator.faceWidthMetres` (0.145 m, cheek to cheek) well; the box is taller than Vision's near-square rectangle. |
| `faces[].confidence` | **none** (no per-face score) | 0.9 for every face past the landmarker's 0.5 detection threshold. |
| `faces[].headPose` | `facialTransformationMatrixes[i]` (4×4, column-major; checked: a clip rotated 15° clockwise reads roll −16°) | The rotation is in MediaPipe's OpenGL camera (x right on the unmirrored image, y up, z toward the viewer; the face looks along +z). Mapped with `R' = S·R·S`, `S = diag(mirrored ? −1 : 1, −1, −1)`, into the viewer-frame camera (x right, y down, z toward the room; the face looks along −z), then decomposed as `EyeContact.rotation` (`Ry(yaw)·Rx(pitch)·Rz(roll)`). That is the `cameraRelative` frame; for `composed` (the default, Vision's) the face-to-lens ray rotation is removed: `R = rayFrame(head)ᵀ·R_camera`, with `head` the ray through the box centre. `headYawSign` / `headPitchSign` and the on-device 3-position frame check still apply downstream. The matrix's translation (a virtual camera) is ignored. |
| `faces[].eyes.pupilOffset` | iris centres 468 / 473 inside the eye contours (16 points each) | Same formula as Vision: (pupil − contour box centre) / half size, both eyes averaged, x negated when mirrored. MediaPipe's iris model is a dedicated network, so the pupil is better than Vision's pupil points; the processor still labels the source `eyes (vision)` because it is the same geometric path. |
| `faces[].eyes.eyeWidthPx` | contour width in capture pixels | The readability ramp (`eyeWidthLoPx` 10 … `eyeWidthHiPx` 22) was set for Vision on 1920×1440 frames; this captures 1280×960 by default, so eyes count from a little closer. Re-derive on the tablet. |
| `faces[].eyes.openness` | contour height / width | Scale differs from Vision's contour (MediaPipe's lids sit on the lash line); only its change is used (the static-face check). |
| `faces[].eyes.confidence` | **none** (no per-point precision) | 0.8, Vision's own fallback when it has no precision estimate. |
| `faces[].interocularPx` | distance between 468 and 473 (pixels) | Pupil to pupil, as Vision's. |
| `faces[].gaze` | `faceBlendshapes` eyeLook{In,Out,Up,Down}{Left,Right} | **Off by default** (`gazeFromBlendshapes`; off, the blendshape model doesn't run at all). The Swift seam's recipe: yaw = 30° × mean(left in − left out, right out − right in), pitch = 20° × mean(down − up), confidence 1 − max blink, `source: 'mediaPipe'`. Why off: a `gaze` estimate bypasses the eye-width readability weight (it is trusted fully at any distance), and the blendshape gains are uncalibrated; the iris geometry feeds the tuned path (gain, bias, σ) unchanged. Turn it on to A/B it with the replay tools. |
| Eyes only for some faces | nearest `plan.landmarkFaces` faces (widest boxes) within `plan.landmarkMaxDistance` | Mirrors Vision's limited landmark pass; the other faces keep box and head pose. `numFaces` = `plan.maxPeople`. |
| `bodies[].box` | **no upper-body rectangle in MediaPipe**: pose landmarks 0–24 with visibility ≥ 0.5, extent grown 10 %, top raised 0.6 × nose-to-shoulder height (the top of the head) | One box per pose (`numPoses` = `plan.maxPeople`). The pose landmarker runs on every analysed frame as the people detector (Vision's rectangles ran every frame too), so it is the "rects" stage. Fewer than 3 visible landmarks → no body. |
| `bodies[].confidence` | mean visibility of the landmarks used | |
| `bodies[].joints` (11) | BlazePose 0 nose, 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips; neck = shoulder midpoint, root = hip midpoint (confidence = the lower of the two); visibility → confidence | BlazePose left/right are the person's own, like Vision's. Attached only on odd frames of a body-pose plan (`bodyPoseRan`), as Vision's body pose alternated with hands; each pose's joints belong to its own box (no box matching needed). |
| `bodies[].appearance` | torso histogram from a 160×120 RGBA copy of the frame | Port of `LumaReader.histogram`: 8×8 samples in the torso box, Cb/Cr computed from RGB (BT.601 full range, what the 420f planes hold), 6 hue sectors + dark + light. |
| `hands[].joints` (21) | hand landmarks 0–20 → `HandJointName.allCases` in order | MediaPipe's order is Vision's order; MediaPipe `thumb_mcp` is Vision's `thumbMP`, `pinky` is `little`. **No per-joint score**: 0.9 inside the image, 0.2 for extrapolated joints outside it. |
| `hands[].chirality` | `handedness[0].categoryName`, **swapped** | MediaPipe labels hands as if the image were a mirrored selfie; we feed the camera's own view, so "Left" is the person's right hand. Unit-tested on the mapping, confirm once on the tablet (raise the right hand). |
| `hands[].confidence` | handedness score | |
| `handsRan` / hand gating | hand landmarker on even frames, only while someone is in view (tracked, or a body or face this frame) | `numHands` = `plan.maxHands`. **No region of interest** in the hand landmarker: a primary-only plan keeps the hands whose wrist falls in the primary person's box grown 25 %. Zoomed wrist passes (`wristROIPasses`, off by default in the Swift too) are not implemented. |
| `motion` | `LumaReader.grid` port: 32×24 cells, 3×3 samples each, luma from RGB on the 160×120 copy | Every `plan.motionEvery`-th analysed frame. |
| `motion.exposureChanged` | **none** | Always false: the browser doesn't report auto-exposure or white-balance changes. A global brightness step can read as motion. |
| `rectanglesOnly` (low mode) | pose landmarker only | Bodies without joints; no faces, as Vision's human rectangles only. |

## Camera offset

The browser can't know where its camera is. The calibration flow's manual override is **measured** with a ruler as
mounted (lens to the middle between the drawn eyes) and stored, like the Swift app's, in the portrait frame as the
perception setting `cameraOffsetOverride` (`CameraOffsetTable.toPortrait`), rotated back with `screen.orientation`.
`startPerception({ cameraOffset })` still takes an explicit offset (current orientation, used as is). Without either the
default is
`CameraOffsetTable.unknownIPadOffset`'s rule for a **long-edge camera** (the camera centred on the top edge in
`landscape-primary`, like the M4 iPads): `−(short side / 2 + 0.01 m)`, with the short side from `screen` CSS pixels at
132 px per inch (an iPad's points; an 11-inch iPad gives −0.090 m, the table says −0.087), rotated with
`screen.orientation` (`landscape-primary` = UIKit `landscapeLeft`, camera on top). The drawn face is assumed centred on the
screen (the kiosk draws it full screen), so no face-centre correction.

## Weak spots against Apple Vision

- No upper-body rectangle and no face score: boxes and confidences are derived (above). The tracker's association costs were
  tuned on Vision's boxes.
- Field of view and camera position are measured by hand in the calibration flow (IPD at a taped mark; a ruler), not read
  from the device: calibrate per tablet (the bias and frame check absorb small errors).
- No per-landmark confidence for eyes or hands; no exposure-change flag; no thermal state of its own: the tier policy's
  pressure is the kiosk resource governor's cap (`setGovernorPressure`, from Compute Pressure / frame-time pressure),
  besides timings, late frames and the face's dropped frames.
- The pose landmarker logs "NORM_RECT without IMAGE_DIMENSIONS is only supported for the square ROI" on 4:3 input
  (MediaPipe's own warning); landmarks looked right on the test clip.
- MediaPipe runs on the GPU (WebGL2 in the worker) beside the face's WebGPU renderer; the iPad build kept perception off
  the GPU. Watch the face's frame delivery (`frameStats` feeds the tier policy).

## Measurement harness (Swift Perception/PerceptionHarness*, NewSessionSheet, MeasurementPanel, Skeleton*, HarnessOverlays)

| Swift | Web |
|---|---|
| `FeatureRecordingStore` on FileManager (Application Support) | the same store over `PersistentFileSystem` (`BrowserRecordingFileSystem.ts`): OPFS with `createWritable`, else IndexedDB (appended pieces + a size row per file), else memory. Listing, sizes and small files cached; `.yfr` chunks loaded only for a viewer / export (`preload`); appends coalesced, flushed every 0.5 s (a crash loses ≤ 0.5 s). `navigator.storage.persist()` asked. |
| `PerceptionHarnessTaps.offer` on the analysis task | `PerceptionHandle.onFrame` (camera frames: `FrameResult.detections`, stages, the snapshot) → timing monitor, writer, calibration |
| Export: a zip for the share sheet | a POSIX tar download (`tarDirectory`); the viewer opens a session `.tar` or a v1 `.json` (`untarInto`) |
| Replay source (`SyntheticScenes.simulatorDemo`) | `ReplaySource`, 15 Hz: the synthetic demo or any stored session (`asPerceptionRecording`), chosen in the Perception panel's People source |
| `governorPressure` | `setGovernorPressure`, pushed by the kiosk tick |
| HUD "isolated timing" (camera paused, the last frame re-run) | not ported: the worker closes each frame's bitmap and MediaPipe keeps no copy |
| Header `platform` "iPad" / "Mac preview", `deviceModel` hw.machine | "web", the user agent |
