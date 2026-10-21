// Port of FacePerception/SyntheticArms.swift.
import type { V3 } from '../core/vec';
import type { Chirality } from './PerceptionTypes';
import type { HandModelShape, SyntheticGesture } from './SyntheticScenes';

/// Swift `SyntheticArms.Hand`.
export interface SyntheticHand { side: Chirality; wrist: V3; shape: HandModelShape; rotation: number }

const P = Math.PI;
const restWrist: readonly V3[] = [{ x: -0.25, y: 0.8, z: 0 }, { x: 0.25, y: 0.8, z: 0 }];
const restElbow: readonly V3[] = [{ x: -0.25, y: 0.55, z: 0 }, { x: 0.25, y: 0.55, z: 0 }];
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const BOTH: readonly [number, Chirality][] = [[0, 'left'], [1, 'right']];

/// Where a synthetic person's wrists, elbows and hands are during a gesture (metres, relative to the head; the
/// person's left is the viewer frame's −x). Index 0 = left, 1 = right.
export class SyntheticArms {
  static readonly restWrist = restWrist;
  static readonly restElbow = restElbow;
  wrists: V3[] = restWrist.map((p) => ({ ...p }));
  elbows: V3[] = restElbow.map((p) => ({ ...p }));
  hands: SyntheticHand[] = [];

  static lerp(a: V3, b: V3, f: number): V3 {
    const t = Math.min(Math.max(f, 0), 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  }

  /// One hand raised to `wrist` (elbow below it), showing `shape`.
  one(side: Chirality, wrist: V3, shape: HandModelShape | null, rotation = 0, elbow: V3 | null = null): void {
    const i = side === 'left' ? 0 : 1;
    const s = side === 'right' ? 1 : -1;
    this.wrists[i] = wrist;
    this.elbows[i] = elbow ?? v(s * 0.25, 0.55, -0.05);
    if (shape !== null) this.hands.push({ side, wrist, shape, rotation });
  }

  pose(g: SyntheticGesture, side: Chirality, t: number): void {
    const s = side === 'right' ? 1 : -1;
    const i = side === 'left' ? 0 : 1;
    const rise = Math.min(t / 0.25, 1);
    const L = SyntheticArms.lerp;
    switch (g.kind) {
      case 'wave':
      case 'byeWave':
        this.one(side, v(s * 0.3 + 0.18 * Math.sin(t * 2 * P / 0.6), 0.02, -0.1), 'open', 0, v(s * 0.32, 0.3, -0.05));
        break;
      case 'thumbsUp': this.one(side, v(s * 0.15, 0.35, -0.2), 'thumbsUp'); break;
      case 'thumbsDown': this.one(side, v(s * 0.15, 0.25, -0.2), 'thumbsUp', P); break;
      case 'thumbSideways': this.one(side, v(s * 0.15, 0.35, -0.2), 'thumbSideways'); break;
      case 'openPalm': this.one(side, v(s * 0.2, 0.1, -0.25), 'open'); break;
      case 'peace': this.one(side, v(s * 0.15, 0.3, -0.2), 'peace'); break;
      case 'fist': this.one(side, v(s * 0.15, 0.35, -0.2), 'fist'); break;
      case 'point': {
        const dir = g.direction;
        const w = v(s * 0.3, 0.2, -0.25);
        this.one(side, w, 'point', Math.atan2(dir.x, -dir.y), v(w.x - dir.x * 0.25, w.y - dir.y * 0.25, w.z));
        break;
      }
      case 'farPoint': {
        // A straight arm out from the shoulder (no hand result needed far away).
        const sh = v(s * 0.2, 0.25, 0);
        const d = g.direction;
        this.one(side, v(sh.x + d.x * 0.6, sh.y + d.y * 0.6, 0), null, 0, v(sh.x + d.x * 0.3, sh.y + d.y * 0.3, 0));
        break;
      }
      case 'talkingHands':
        this.wrists[i] = v(s * 0.15 + 0.12 * Math.sin(t * 5.3) * Math.sin(t * 1.7), 0.5 + 0.05 * Math.sin(t * 3.1), -0.2);
        this.elbows[i] = v(s * 0.25, 0.55, -0.05);
        this.hands.push({ side, wrist: this.wrists[i], shape: Math.trunc(t * 3) % 2 === 0 ? 'open' : 'relaxed', rotation: 0 });
        break;
      case 'scratch': this.one(side, v(s * 0.08 + 0.02 * Math.sin(t * 2 * P / 0.25), -0.05, 0), 'relaxed'); break;
      case 'clap': {
        const sep = 0.03 + 0.12 * (0.5 + 0.5 * Math.cos(t * 2 * P / 0.5));
        this.one('left', v(-sep, 0.45, -0.2), 'open', 0, v(-0.22, 0.55, -0.1));
        this.one('right', v(sep, 0.45, -0.2), 'open', 0, v(0.22, 0.55, -0.1));
        break;
      }
      case 'armsUp':
        for (const [k, c] of BOTH) {
          const ss = k === 0 ? -1 : 1;
          this.one(c, L(restWrist[k], v(ss * 0.22, -0.35, 0), rise), 'open', 0, L(restElbow[k], v(ss * 0.22, -0.05, 0), rise));
        }
        break;
      case 'stretch': {
        const f = Math.min(t / 2, 1);
        for (const [k, c] of BOTH) {
          const ss = k === 0 ? -1 : 1;
          this.one(c, L(restWrist[k], v(ss * 0.06, -0.12, 0.05), f), null, 0, L(restElbow[k], v(ss * 0.35, -0.08, 0), f));
        }
        break;
      }
      case 'nod':
      case 'smallNods':
        break;
      case 'dance':
        for (const [k, c] of BOTH) {
          const ss = k === 0 ? -1 : 1;
          const ph = k === 0 ? P : 0;
          this.one(c, v(ss * 0.28 + 0.12 * Math.sin(t * 2 * P + ph), 0.42 + 0.08 * Math.sin(t * 4 * P), -0.1), 'relaxed', 0,
            v(ss * 0.3, 0.5, -0.05));
        }
        break;
      case 'walkingArms':
        for (const [k, c] of BOTH) {
          const ss = k === 0 ? -1 : 1;
          const ph = k === 0 ? P : 0;
          this.one(c, v(ss * 0.27, 0.78 + 0.03 * Math.sin(t * 2 * P + ph), 0.12 * Math.sin(t * 2 * P + ph)), null, 0,
            v(ss * 0.26, 0.53, 0.06 * Math.sin(t * 2 * P + ph)));
        }
        break;
      case 'peekaboo': {
        // Up to the face (0–0.25 s), hidden behind the hands (0.5–1.7 s), then down with open palms ("ta-da").
        const down = Math.min(Math.max((t - 1.7) / 0.3, 0), 1);
        for (const [k, c] of BOTH) {
          const ss = k === 0 ? -1 : 1;
          const atFace = L(restWrist[k], v(ss * 0.05, 0.03, -0.1), rise);
          this.one(c, L(atFace, v(ss * 0.3, 0.4, -0.15), down), 'open', 0, v(ss * 0.2, 0.3, -0.05));
        }
        break;
      }
      case 'yawnCover': this.one(side, L(restWrist[i], v(s * 0.03, 0.08, -0.08), rise), 'relaxed'); break;
      case 'heartHands':
        this.one('left', L(restWrist[0], v(-0.085, 0.45, -0.15), rise), 'heartHalf', 0, v(-0.22, 0.6, -0.05));
        this.one('right', L(restWrist[1], v(0.085, 0.45, -0.15), rise), 'heartHalf', 0, v(0.22, 0.6, -0.05));
        break;
      case 'highFive':
        this.one(side, v(s * 0.15, 0.15, -0.1 - 0.35 * Math.min(t / 0.3, 1)), 'open', 0, v(s * 0.22, 0.45, -0.05));
        break;
    }
  }
}
