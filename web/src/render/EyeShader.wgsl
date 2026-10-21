// Port of FaceRendering/EyeShader.swift (the Metal source string), line for line. The maths mirrors `EyeSDF`.
//
// One full-screen triangle. Per pixel and per eye: a cheap circular cull, then eye-local transform, per-quadrant
// elliptical rounded box warped into an egg, two lid regions and the visible-sclera SDF. Inside it: a rim band, an ink
// band, the flat sclera fill, and the pupil (or a transformation glyph) with its ink edge, crescent and notch. Each eye
// returns (colour, coverage) and is composited OVER the background. Lit in linear light, encoded to sRGB here and
// dithered by ±0.5 code value into a non-sRGB 8-bit target.
//
// Anti-aliasing width is analytic (unitsPerPixel), as in Metal: no derivatives, so it stays valid inside the
// per-eye cull branch (WGSL forbids fwidth in non-uniform control flow anyway).
//
// Metal → WGSL notes: `thread float&` out-parameters become ptr<function, f32>; `constant EyeU&` become by-value
// struct parameters; the `int i = 0, j = 7; …; j = i, i++` loops are unrolled into an explicit j; `powr` → `pow`.

struct EyeU {
  placement: vec4f,   // centre px xy, cos, sin
  box: vec4f,         // hx, hy, erosion, cull radius px
  radiiTop: vec4f,    // UL rx ry, UR rx ry
  radiiBottom: vec4f, // LL rx ry, LR rx ry
  upperLid: vec4f,    // pivot y, cos, sin, L
  upperBend: vec4f,   // a, b, psi right, psi left
  upperClip: vec4f,   // chord segments in the box: +start, +end, -start, -end
  lowerLid: vec4f,
  lowerBend: vec4f,
  lowerClip: vec4f,
  pupil: vec4f,       // centre xy, radii xy
  accent: vec4f,      // egg taper, pupil ink width, closure y scale, pupil visibility
  outline: vec4f,     // ink width, upper junction k, lower junction k, rim width
  lidBlend: vec4f,    // upper / lower straight-lid weight w, upper / lower mix toward the straight lid (w^3)
  shape: vec4f,       // pupil shape id, morph, scale x, scale y
}

struct BrowU {
  placement: vec4f,   // centre px xy, cull radius px, visible
  bands: vec4f,       // rim width, ink width, fill ink amount (0 ivory ... 1 ink)
  points: array<vec4f, 13>, // spine inner -> outer: xy around the centre (canvas units), radius
}

struct FrameU {
  viewport: vec4f,    // W, H, ppu, units per px
  background: vec4f,  // linear rgb (final), vignette strength
  shading: vec4f,     // sclera gradient, lid shadow, lid shadow width, dither amplitude
  misc: vec4f,        // shape mood accent on, notch on, iris tint, crescent strength
  sclera: vec4f,      // linear rgb
  ink: vec4f,
  rim: vec4f,
  pupilLab: vec4f,    // Oklab, brightness multiplier
  irisLab: vec4f,
  notch: vec4f,
  crescent: vec4f,
  notchLine1: vec4f,  // pupil-normalised: n.xy, c (inside where dot(n, q) - c < 0), retraction (c += morph * w)
  notchLine2: vec4f,
  crescentDisc: vec4f, // pupil-normalised cut-out disc: centre xy, radius
  vignette: vec4f,    // ramp inner r, outer r
  glow: vec4f,        // listening glow: opacity (0 = off), crest height px, motion, voice ripple
  glowPhase: vec4f,   // band drift, wave 1, wave 2, wave 3 (radians)
  glowColorA: vec4f,  // linear rgb
  glowColorB: vec4f,
  left: EyeU,
  right: EyeU,
  browLeft: BrowU,
  browRight: BrowU,
}

@group(0) @binding(0) var<uniform> f: FrameU;

struct VOut { @builtin(position) position: vec4f }

@vertex
fn faceVertex(@builtin(vertex_index) vid: u32) -> VOut {
  // Full-screen triangle.
  let uv = vec2f(f32((vid << 1u) & 2u), f32(vid & 2u));
  var o: VOut;
  o.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn sdEllipse(q: vec2f, r: vec2f) -> f32 {
  let k0 = length(q / r);
  let k1 = length(q / (r * r));
  let rLocal = k0 / max(k1, 1e-9);
  let rMin = min(r.x, r.y);
  let radius = select(rLocal, rMin + (rLocal - rMin) * k0, k0 < 1.0);
  return (k0 - 1.0) * radius;
}

fn ellD2(q: vec2f, r: vec2f, t: f32) -> f32 {
  let dx = r.x * cos(t) - q.x;
  let dy = r.y * sin(t) - q.y;
  return dx * dx + dy * dy;
}

// Exact signed distance to an ellipse for q >= 0 (corner quadrant); also the closest point's parameter.
fn sdEllipseExact(q: vec2f, r: vec2f, tOut: ptr<function, f32>) -> f32 {
  let hp = 1.57079632679;
  var t = atan2(q.y * r.x, q.x * r.y);
  var best = ellD2(q, r, t);
  let tx = acos(min(q.x / r.x, 1.0));
  let dx = ellD2(q, r, tx);
  if (dx < best) { best = dx; t = tx; }
  let ty = asin(min(q.y / r.y, 1.0));
  let dy = ellD2(q, r, ty);
  if (dy < best) { best = dy; t = ty; }
  let k = r.y * r.y - r.x * r.x;
  var bestT = t;
  for (var i = 0; i < 4; i++) {
    let c = cos(t);
    let s = sin(t);
    let g = k * s * c + q.x * r.x * s - q.y * r.y * c;
    let h = k * (c * c - s * s) + q.x * r.x * c + q.y * r.y * s;
    let dt = select(select(-0.3, 0.3, g > 0.0), g / h, h > 1e-6);
    t = clamp(t - dt, 0.0, hp);
    let d2 = ellD2(q, r, t);
    if (d2 < best) { best = d2; bestT = t; }
  }
  *tOut = bestT;
  let d = sqrt(best);
  let n = q / r;
  return select(d, -d, dot(n, n) < 1.0);
}

fn quadrantRadii(p: vec2f, top: vec4f, bottom: vec4f) -> vec2f {
  if (p.y < 0.0) { return select(top.zw, top.xy, p.x < 0.0); }
  return select(bottom.zw, bottom.xy, p.x < 0.0);
}

fn boxPoint(p: vec2f, b: vec2f, top: vec4f, bottom: vec4f) -> vec2f {
  let r = quadrantRadii(p, top, bottom);
  let c = b - r;
  let cc = clamp(p, -c, c);
  let n = (p - cc) / r;
  let len = length(n);
  return select(p, cc + r * (n / len), len > 1e-6);
}

fn sdShape(p: vec2f, b: vec2f, top: vec4f, bottom: vec4f) -> f32 {
  let r = quadrantRadii(p, top, bottom);
  let a = abs(p);
  let c = b - r;
  var t: f32;
  if (a.x > c.x && a.y > c.y) { return sdEllipseExact(a - c, r, &t); }
  let w = a - b;
  return max(w.x, w.y);
}

// sdShape with its unit gradient (outward normal of the closest boundary point). See EyeSDF.shapeNormal.
fn sdShapeNormal(p: vec2f, b: vec2f, top: vec4f, bottom: vec4f, n: ptr<function, vec2f>) -> f32 {
  let r = quadrantRadii(p, top, bottom);
  let sg = vec2f(select(1.0, -1.0, p.x < 0.0), select(1.0, -1.0, p.y < 0.0));
  let a = abs(p);
  let c = b - r;
  if (a.x > c.x && a.y > c.y) {
    var t: f32;
    let d = sdEllipseExact(a - c, r, &t);
    let g = vec2f(cos(t) / r.x, sin(t) / r.y);
    *n = g / max(length(g), 1e-9) * sg;
    return d;
  }
  let w = a - b;
  *n = select(vec2f(0.0, sg.y), vec2f(sg.x, 0.0), w.x > w.y);
  return max(w.x, w.y);
}

// Egg warp x scale and its y derivative. See EyeSDF.eggScale.
fn eggScale(y: f32, hy: f32, taper: f32, dir: f32) -> vec2f {
  let u = y / max(hy, 1e-6);
  if (abs(u) >= 1.0) { return vec2f(1.0 + 0.5 * taper * dir * select(1.0, -1.0, u < 0.0), 0.0); }
  return vec2f(1.0 + 0.5 * taper * dir * u, 0.5 * taper * dir / max(hy, 1e-6));
}

// The sclera shape warped into an egg, first-order Euclidean. See EyeSDF.egg.
fn sdEgg(p: vec2f, b: vec2f, top: vec4f, bottom: vec4f, taper: f32, dir: f32) -> f32 {
  if (taper <= 0.0) { return sdShape(p, b, top, bottom); }
  let sc = eggScale(p.y, b.y, taper, dir);
  var n = vec2f(0.0);
  let d = sdShapeNormal(vec2f(p.x / sc.x, p.y), b, top, bottom, &n);
  let g = vec2f(n.x / sc.x, n.y - n.x * p.x * sc.y / (sc.x * sc.x));
  return d / max(length(g), 0.25);
}

fn eggBoxPoint(p: vec2f, b: vec2f, top: vec4f, bottom: vec4f, taper: f32) -> vec2f {
  if (taper <= 0.0) { return boxPoint(p, b, top, bottom); }
  let q = boxPoint(vec2f(p.x / eggScale(p.y, b.y, taper, 1.0).x, p.y), b, top, bottom);
  return vec2f(q.x * eggScale(q.y, b.y, taper, 1.0).x, q.y);
}

fn arcDist2(p: vec2f, a: f32, b: f32, t: f32) -> f32 {
  let q = vec2f(a * cos(t), b * sin(t)) - p;
  return dot(q, q);
}

fn arcDistance(p: vec2f, ab: vec2f, psi: vec2f) -> f32 {
  let a = ab.x;
  let b = ab.y;
  var t = psi.x;
  var best = arcDist2(p, a, b, t);
  for (var i = 1; i <= 5; i++) {
    let ti = psi.x + (psi.y - psi.x) * f32(i) * 0.2;
    let di = arcDist2(p, a, b, ti);
    if (di < best) { best = di; t = ti; }
  }
  let tx = clamp(acos(clamp(p.x / a, -1.0, 1.0)), psi.x, psi.y);
  let dx = arcDist2(p, a, b, tx);
  if (dx < best) { best = dx; t = tx; }
  let k = b * b - a * a;
  let halfStep = (psi.y - psi.x) * 0.1;
  for (var i = 0; i < 3; i++) {
    let c = cos(t);
    let s = sin(t);
    let g = k * s * c + p.x * a * s - p.y * b * c;
    let h = k * (c * c - s * s) + p.x * a * c + p.y * b * s;
    let dt = select(select(-halfStep, halfStep, g > 0.0), g / h, h > 1e-6);
    t = clamp(t - dt, psi.x, psi.y);
    best = min(best, arcDist2(p, a, b, t));
  }
  return sqrt(best);
}

fn sdLid(p: vec2f, lid: vec4f, bend: vec4f, clip: vec4f) -> f32 {
  let q = vec2f(p.x, p.y - lid.x);
  let c = lid.y;
  let s = lid.z;
  let r = vec2f(q.x * c - q.y * s, q.x * s + q.y * c);
  let y = r.y - lid.w;
  if (bend.y <= 1e-3) { return y; }
  let ab = bend.xy;
  let e = sdEllipse(vec2f(r.x, y), ab);
  if (y >= 0.0 && e >= 0.0) { return min(y, e); }
  let pl = vec2f(r.x, y);
  var depth = arcDistance(pl, ab, bend.zw);
  if (clip.y > clip.x) {
    let dx = pl.x - clamp(pl.x, clip.x, clip.y);
    depth = min(depth, sqrt(dx * dx + y * y));
  }
  if (clip.w > clip.z) {
    let dx = pl.x - clamp(pl.x, -clip.w, -clip.z);
    depth = min(depth, sqrt(dx * dx + y * y));
  }
  return -depth;
}

// Offset-shape lid (negative inside the lid), in the lid frame. See EyeSDF.shapeLid.
fn sdShapeLid(p: vec2f, lid: vec4f, b: vec2f, r: vec4f, taper: f32, dir: f32) -> f32 {
  let q0 = vec2f(p.x, p.y - lid.x);
  let c = lid.y;
  let s = lid.z;
  let rr = vec2f(q0.x * c - q0.y * s, q0.x * s + q0.y * c);
  let q = vec2f(rr.x, rr.y - lid.w - b.y);
  var d: f32;
  if (q.y < 0.0) { d = sdEgg(q, b, r, r, taper, dir); } else { d = abs(q.x) - b.x - q.y; }
  return -d;
}

// Lid field: straight lid, or the offset-shape lid mixed toward it; also returns the straight lid's field.
// See EyeSDF.lidField.
fn lidField(p: vec2f, e: EyeU, upper: bool, straight: ptr<function, f32>) -> f32 {
  let w = select(e.lidBlend.y, e.lidBlend.x, upper);
  let l = select(e.lowerLid, e.upperLid, upper);
  if (upper) { *straight = sdLid(p, e.upperLid, e.upperBend, e.upperClip); }
  else { *straight = sdLid(p, e.lowerLid, e.lowerBend, e.lowerClip); }
  if (w >= 1.0) { return *straight; }
  let rb = e.radiiBottom;
  let r0 = select(vec4f(rb.z, rb.w, rb.x, rb.y), e.radiiTop, upper);
  let r = max(r0 * (1.0 - w), vec4f(1e-3));
  let sh = sdShapeLid(p, l, e.box.xy, r, e.accent.x, select(-1.0, 1.0, upper));
  let t = select(e.lidBlend.w, e.lidBlend.z, upper);
  return select(sh, sh + (*straight - sh) * t, t > 0.0);
}

fn smaxPoly(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}

// MARK: Pupil transformation glyphs (glyph frame: isotropic, y down, the pupil ellipse is (1, 1.24)). See PupilGlyph.

const kStarCore = array<vec2f, 8>(
  vec2f(0.82, 0.0), vec2f(0.2546, 0.2546), vec2f(0.0, 1.02), vec2f(-0.2546, 0.2546),
  vec2f(-0.82, 0.0), vec2f(-0.2546, -0.2546), vec2f(0.0, -1.02), vec2f(0.2546, -0.2546));
const kHeartCore = array<vec2f, 5>(
  vec2f(0.0, 0.96), vec2f(0.7105, -0.1559), vec2f(0.39, -0.36), vec2f(-0.39, -0.36), vec2f(-0.7105, -0.1559));

fn sdStar(p: vec2f) -> f32 {
  var pts = kStarCore;
  var d = dot(p - pts[0], p - pts[0]);
  var sg = 1.0;
  var j = 7;
  for (var i = 0; i < 8; i++) {
    let e = pts[j] - pts[i];
    let w = p - pts[i];
    let b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
    d = min(d, dot(b, b));
    let c1 = p.y >= pts[i].y;
    let c2 = p.y < pts[j].y;
    let c3 = e.x * w.y > e.y * w.x;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) { sg = -sg; }
    j = i;
  }
  return sg * sqrt(d) - 0.12;
}

fn sdHeart(p: vec2f) -> f32 {
  var pts = kHeartCore;
  let lobe = length(vec2f(abs(p.x), p.y) - vec2f(0.39, -0.36)) - 0.48;
  var d = dot(p - pts[0], p - pts[0]);
  var sg = 1.0;
  var j = 4;
  for (var i = 0; i < 5; i++) {
    let e = pts[j] - pts[i];
    let w = p - pts[i];
    let b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
    d = min(d, dot(b, b));
    let c1 = p.y >= pts[i].y;
    let c2 = p.y < pts[j].y;
    let c3 = e.x * w.y > e.y * w.x;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) { sg = -sg; }
    j = i;
  }
  return min(lobe, sg * sqrt(d) - 0.1);
}

fn udSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}

fn udArc(p: vec2f, c: vec2f, r: f32, a0: f32, a1: f32) -> f32 {
  let v = p - c;
  let mid = 0.5 * (a0 + a1);
  let half_ = 0.5 * (a1 - a0);
  let cm = cos(mid);
  let sm = sin(mid);
  let w = vec2f(v.x * cm + v.y * sm, -v.x * sm + v.y * cm);
  if (abs(atan2(w.y, w.x)) <= half_) { return abs(length(v) - r); }
  let e0 = c + r * vec2f(cos(a0), sin(a0));
  let e1 = c + r * vec2f(cos(a1), sin(a1));
  return min(length(p - e0), length(p - e1));
}

fn sdUnevenCapsule(p: vec2f, r1: f32, r2: f32, h: f32) -> f32 {
  let b = (r1 - r2) / h;
  let a = sqrt(1.0 - b * b);
  let k = -b * p.x + a * p.y;
  if (k < 0.0) { return length(p) - r1; }
  if (k > a * h) { return length(p - vec2f(0.0, h)) - r2; }
  return a * p.x + b * p.y - r1;
}

fn sdNote(p: vec2f) -> f32 {
  let v = p - vec2f(-0.28, 0.66);
  let ax = vec2f(0.92718, -0.37461);
  let pe = vec2f(-ax.y, ax.x);
  let head = sdEllipse(vec2f(dot(v, ax), dot(v, pe)), vec2f(0.40, 0.31));
  let stem = udSegment(p, vec2f(0.07, -0.9), vec2f(0.07, 0.6)) - 0.155;
  let flag = udArc(p, vec2f(-0.12, -0.2), 0.7446, -1.3124926, -0.0872665) - 0.155;
  return min(head, min(stem, flag));
}

fn sdQuestion(p: vec2f) -> f32 {
  let a0 = 2.8797933;
  let a1 = 7.3303829;
  let c = vec2f(0.0, -0.42);
  let hook = udArc(p, c, 0.44, a0, a1) - 0.17;
  let end = c + 0.44 * vec2f(cos(a1), sin(a1));
  let stem = udSegment(p, end, vec2f(0.0, 0.2)) - 0.17;
  let dot_ = length(p - vec2f(0.0, 0.88)) - 0.30;
  return min(min(hook, stem), dot_);
}

fn sdExclaim(p: vec2f) -> f32 {
  let bar = sdUnevenCapsule(vec2f(abs(p.x), p.y + 0.78), 0.27, 0.16, 1.0);
  let dot_ = length(p - vec2f(0.0, 0.86)) - 0.30;
  return min(bar, dot_);
}

fn glyphSDF(id: i32, p: vec2f) -> f32 {
  switch (id) {
    case 1: { return sdStar(p); }
    case 2: { return sdHeart(p); }
    case 3: { return sdNote(p); }
    case 4: { return sdQuestion(p); }
    case 5: { return sdExclaim(p); }
    default: { return sdEllipse(p, vec2f(1.0, 1.24)); }
  }
}

// The pupil's field: the scaled default ellipse, the glyph (isotropic frame, unit from the pre-closure pupil), or
// their morph. See EyeSDF.PupilField.
struct PupilF { d: f32, dIn: f32, prs: vec2f, rIn: vec2f, k: vec2f, kmin: f32, glyph: bool }

fn pupilField(e: EyeU, q: vec2f) -> PupilF {
  var o: PupilF;
  let pr = e.pupil.zw;
  let ss = e.shape.zw;
  let morph = e.shape.y;
  let sid = i32(e.shape.x + 0.5);
  let plain = morph <= 0.0 && ss.x >= 1.0 && ss.y >= 1.0;
  o.prs = select(max(pr * ss, vec2f(1e-3)), pr, plain);
  o.rIn = max(o.prs - vec2f(e.accent.y), vec2f(1e-3));
  o.glyph = sid > 0 && morph > 0.0;
  let cy = max(e.accent.z, 1e-3);
  let u = min(pr.x, pr.y / cy / 1.24);
  o.k = max(vec2f(u * ss.x, u * cy * ss.y), vec2f(1e-4));
  o.kmin = min(o.k.x, o.k.y);
  let dE = sdEllipse(q, o.prs);
  let dEIn = sdEllipse(q, o.rIn);
  o.d = dE;
  o.dIn = dEIn;
  if (o.glyph) {
    let g = glyphSDF(sid, q / o.k) * o.kmin;
    if (sid <= 2) {
      o.d = dE + (g - dE) * morph;
      o.dIn = dEIn + (g + e.accent.y - dEIn) * morph;
    } else {
      o.d = g;
      o.dIn = g + e.accent.y;
    }
  }
  return o;
}

// The (morphed) ink-inset field at another offset (the mood accent's shifted copy). See PupilField.fieldIn.
fn pupilInnerAt(e: EyeU, pf: PupilF, q: vec2f) -> f32 {
  let dE = sdEllipse(q, pf.rIn);
  if (!pf.glyph) { return dE; }
  let sid = i32(e.shape.x + 0.5);
  let g = glyphSDF(sid, q / pf.k) * pf.kmin + e.accent.y;
  return select(g, dE + (g - dE) * e.shape.y, sid <= 2);
}

fn oklabToLinear(lab: vec3f) -> vec3f {
  let l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  let m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  let s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
               -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
               -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

// One eye: (linear colour, coverage).
fn eyeSample(e: EyeU, px: vec2f) -> vec4f {
  let delta = px - e.placement.xy;
  if (dot(delta, delta) > e.box.w * e.box.w) { return vec4f(0.0); }
  let c = e.placement.z;
  let s = e.placement.w;
  let p = vec2f(delta.x * c - delta.y * s, delta.x * s + delta.y * c) * f.viewport.w;

  let dShape = sdEgg(p, e.box.xy, e.radiiTop, e.radiiBottom, e.accent.x, 1.0);
  // dVis below is never under dShape (max and smaxPoly ≥ max), so these pixels have zero coverage: skip the lids.
  if (0.5 - dShape * f.viewport.z <= 0.0) { return vec4f(0.0); }
  // Lids at the nearest box point: their distances are only meaningful inside the box.
  var bp = p;
  if (dShape > 0.0) { bp = eggBoxPoint(p, e.box.xy, e.radiiTop, e.radiiBottom, e.accent.x); }
  var sU = 0.0;
  var sL = 0.0;
  let oU = -(lidField(bp, e, true, &sU) + e.box.z);
  let oL = -(lidField(bp, e, false, &sL) + e.box.z);
  // Lid/edge junctions rounded by a per-lid smooth max (0 = sharp; see EyeSDF.visibleDistance).
  let dU = select(max(dShape, oU), smaxPoly(dShape, oU, e.outline.y), e.outline.y > 1e-3);
  let dL = select(max(dShape, oL), smaxPoly(dShape, oL, e.outline.z), e.outline.z > 1e-3);
  let dVis = max(dU, dL);
  let ppu = f.viewport.z;
  let cov = saturate(0.5 - dVis * ppu);
  if (cov <= 0.0) { return vec4f(0.0); }
  let rimW = e.outline.w;
  let band = e.outline.w + e.outline.x;
  let inInk = saturate(0.5 - (dVis + rimW) * ppu);
  let inner = saturate(0.5 - (dVis + band) * ppu);

  // Sclera fill: flat by default; optional gradient and shadow under the straight upper lid line.
  let t = saturate(0.5 + p.y / (2.0 * e.box.y));
  let shadow = f.shading.y * (1.0 - smoothstep(0.0, f.shading.z, (sU + e.box.z) - band));
  let sclera = f.sclera.rgb * ((1.0 - f.shading.x * t) * (1.0 - shadow));
  var col = mix(f.rim.rgb, f.ink.rgb, inInk);
  col = mix(col, sclera, inner);

  // Pupil (or its transformation glyph), clipped by the ink and the lids, faded by visibility; ink edge, crescent,
  // mood accent and notch inside it. The notch and crescent retract geometrically with the morph.
  let q = p - e.pupil.xy;
  let pr = e.pupil.zw;
  // Visibility erodes the pupil (flat colours, no translucent grey) until it is gone.
  let erode = (1.0 - e.accent.w) * (max(pr.x, pr.y) + 1.0);
  let pf = pupilField(e, q);
  let pm = saturate(0.5 - (pf.d + erode) * ppu) * inner;
  if (pm > 0.0) {
    let morph = e.shape.y;
    let rho = length(q / pf.prs);
    let ring = smoothstep(0.45, 0.8, rho) * (1.0 - smoothstep(0.9, 1.0, rho)) * (1.0 - morph);
    let lab = mix(f.pupilLab.xyz, f.irisLab.xyz, f.misc.z * ring);
    var pc = max(oklabToLinear(lab), vec3f(0.0)) * f.pupilLab.w;
    let rIn = pf.rIn;
    let dIn = pf.dIn;
    pc = mix(f.ink.rgb, pc, saturate(0.5 - dIn * ppu));
    if (f.misc.w > 0.0) {
      let dc = f.crescentDisc.xy;
      let cl = length(dc);
      let dirC = select(vec2f(0.0), -dc / cl, cl > 1e-5);
      let w = cl - (f.crescentDisc.z - 1.0);
      let dc2 = dc + dirC * ((w + 0.03) * morph);
      let dD = sdEllipse(q - dc2 * rIn, rIn * f.crescentDisc.z);
      let cm = saturate(0.5 - max(dIn, -dD) * ppu) * f.misc.w;
      pc = mix(pc, f.crescent.rgb, cm);
      let sid = i32(e.shape.x + 0.5);
      if (pf.glyph && sid <= 2 && f.misc.x > 0.5) {
        let off = dirC * (0.6 * pf.kmin * morph);
        let dO = pupilInnerAt(e, pf, q + off) - 0.37 * pf.kmin * morph;
        let am = saturate(0.5 - max(dIn, -dO) * ppu) * f.misc.w;
        pc = mix(pc, f.crescent.rgb, am);
      }
    }
    if (f.misc.y > 0.5) {
      let qi = q / rIn;
      let n1 = f.notchLine1.xy;
      let n2 = f.notchLine2.xy;
      let c1 = f.notchLine1.z + morph * f.notchLine1.w;
      let c2 = f.notchLine2.z + morph * f.notchLine2.w;
      let d1 = (dot(n1, qi) - c1) / max(length(n1 / rIn), 1e-6);
      let d2 = (dot(n2, qi) - c2) / max(length(n2 / rIn), 1e-6);
      let nm = saturate(0.5 - max(dIn, max(d1, d2)) * ppu);
      pc = mix(pc, f.notch.rgb, nm);
    }
    col = mix(col, pc, pm);
  }
  return vec4f(col, cov);
}

// Uneven capsule a (ra) -> b (rb), any orientation; t = projection parameter for the local radius.
// See EyeSDF.taperedSegment.
fn sdTaperedSegment(p: vec2f, a: vec2f, b: vec2f, ra: f32, rb: f32, tOut: ptr<function, f32>) -> f32 {
  let ba = b - a;
  let l2 = dot(ba, ba);
  let pa = p - a;
  *tOut = select(0.0, saturate(dot(pa, ba) / l2), l2 > 1e-12);
  let l = sqrt(l2);
  if (l < 1e-5) { return length(pa) - max(ra, rb); }
  let dir = ba / l;
  let q = vec2f(abs(pa.x * -dir.y + pa.y * dir.x), dot(pa, dir));
  let k0 = (ra - rb) / l;
  if (abs(k0) >= 1.0) { return min(length(pa) - ra, length(p - b) - rb); }
  let k1 = sqrt(1.0 - k0 * k0);
  let k = dot(q, vec2f(-k0, k1));
  if (k < 0.0) { return length(q) - ra; }
  if (k > k1 * l) { return length(q - vec2f(0.0, l)) - rb; }
  return dot(q, vec2f(k1, k0)) - ra;
}

// One brow: (linear colour, coverage). A chain of tapered capsules; rim -> ink -> fill with the eyes' band rule on
// the local stroke width. See EyeSDF.browSample.
fn browSample(b: BrowU, px: vec2f) -> vec4f {
  if (b.placement.w < 0.5) { return vec4f(0.0); }
  let delta = px - b.placement.xy;
  if (dot(delta, delta) > b.placement.z * b.placement.z) { return vec4f(0.0); }
  let p = delta * f.viewport.w;
  var best = 1e30;
  var rLoc = 0.0;
  for (var i = 0; i < 12; i++) {
    let a = b.points[i];
    let c = b.points[i + 1];
    var t: f32;
    let d = sdTaperedSegment(p, a.xy, c.xy, a.z, c.z, &t);
    if (d < best) { best = d; rLoc = a.z + (c.z - a.z) * t; }
  }
  let ppu = f.viewport.z;
  let cov = saturate(0.5 - best * ppu);
  if (cov <= 0.0) { return vec4f(0.0); }
  let ap = max(2.0 * rLoc, 0.0);
  let rimE = min(b.bands.x, 0.25 * ap);
  let inkE = min(b.bands.y, max(0.5 * ap - rimE, 0.0));
  let inInk = saturate(0.5 - (best + rimE) * ppu);
  let inner = saturate(0.5 - (best + rimE + inkE) * ppu);
  let fill = mix(f.sclera.rgb, f.ink.rgb, saturate(b.bands.z));
  var col = mix(f.rim.rgb, f.ink.rgb, inInk);
  col = mix(col, fill, inner);
  return vec4f(col, cov);
}

fn srgbEncode(c: f32) -> f32 {
  // pow(0, x) is undefined in WGSL; the branch keeps c > 0.0031308 there (Metal's powr has the same domain).
  return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, 12.92 * c, c <= 0.0031308);
}

// The listening glow over the background at this pixel (call only when f.glow.x > 0). See EyeSDF.glow.
fn listeningGlow(px: vec2f, lin: vec3f) -> vec3f {
  let v = f.viewport.y - px.y;
  let h = f.glow.y;
  if (v >= 2.4 * h) { return lin; }
  let tau = 6.2831853;
  let u = px.x / f.viewport.x;
  let ph = f.glowPhase;
  let m = f.glow.z;
  let rp = f.glow.w;
  var wave = 1.0;
  var lobe = 1.0;
  var warp = 0.0;
  if (m > 0.0) {
    let s1 = sin(tau * 1.3 * u + ph.y);
    let s2 = sin(tau * 2.1 * u + ph.z);
    let s3 = sin(tau * 3.4 * u + ph.w);
    // The voice raises the crests and runs a finer ripple along them (integer phase multiples: no wrap jump).
    wave += m * (1.0 + 0.4 * rp) * (0.18 * s1 + 0.12 * s2 + 0.07 * s3);
    wave += rp * (0.045 * sin(tau * 5.0 * u - 3.0 * ph.w) + 0.03 * sin(tau * 7.0 * u + 2.0 * ph.z));
    lobe += m * 0.22 * (0.6 * s2 + 0.4 * s1);
    warp = 0.8 * s2;
  }
  let hh = max(h * wave, 1.0);
  let t = v / hh;
  if (t >= 1.7) { return lin; }
  let tc = t * 3.3333333;
  let body = min(exp(-1.9 * t * t) + 0.3 * exp(-2.6 * tc * tc), 1.0) * (1.0 - smoothstep(1.1, 1.7, t)) * lobe;
  let band = 0.5 + 0.5 * sin(tau * 0.9 * u + ph.x + warp);
  let gc = mix(f.glowColorA.rgb, f.glowColorB.rgb, band);
  return mix(lin, gc, saturate(f.glow.x * body));
}

@fragment
fn faceFragment(vin: VOut) -> @location(0) vec4f {
  let px = vin.position.xy;

  let half_ = f.viewport.xy * 0.5;
  let dc = px - half_;
  let r = sqrt(dot(dc, dc) / dot(half_, half_));
  // The background (theme or mood colour; presence, brightness and caps already applied) with its vignette.
  var lin = f.background.rgb * (1.0 - f.background.w * smoothstep(f.vignette.x, f.vignette.y, r));
  // The listening glow rising from the bottom edge, under the eyes; skipped entirely while off.
  if (f.glow.x > 0.0) { lin = listeningGlow(px, lin); }

  // Each eye composited OVER the background (the eyes never overlap).
  let L = eyeSample(f.left, px);
  lin = mix(lin, L.rgb, L.a);
  let R = eyeSample(f.right, px);
  lin = mix(lin, R.rgb, R.a);
  // The brows over both eyes (they never overlap an eye: the geometry keeps a gap).
  let BL = browSample(f.browLeft, px);
  lin = mix(lin, BL.rgb, BL.a);
  let BR = browSample(f.browRight, px);
  lin = mix(lin, BR.rgb, BR.a);

  // Interleaved gradient noise: cheap, blue-ish, static (no shimmer). ±0.5 code value.
  let n = fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715)))) - 0.5;
  var enc = vec3f(srgbEncode(lin.r), srgbEncode(lin.g), srgbEncode(lin.b));
  enc = saturate(enc + n * f.shading.w);
  return vec4f(enc, 1.0);
}
