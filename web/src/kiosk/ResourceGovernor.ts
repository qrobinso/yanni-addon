// Port of YanniKiosk/ResourceGovernor.swift. The resource ladder (hardening design §6.4): one governor turns thermal
// state, power, memory warnings, camera pressure and the face's own frame delivery into a level 0–4. Each subsystem
// reads its slice of the `Budget`. It steps **up immediately** and **down one level after 5 min** at a better input.
//
// **Never the face.** At every level all face modifiers run and the eyes stay at the target frame rate (awake 60,
// asleep 30). Render scale 0.8 is the only render lever; the 120 Hz burst is the only frame rate ever given up.

export type Thermal = 0 | 1 | 2 | 3;
export const Thermal = {
  nominal: 0 as Thermal, fair: 1 as Thermal, serious: 2 as Thermal, critical: 3 as Thermal,
  label: (t: Thermal): 'nominal' | 'fair' | 'serious' | 'critical' => (['nominal', 'fair', 'serious', 'critical'] as const)[t],
};

/// The inputs, sampled by the kiosk's 1 s tick.
export interface GovernorInputs {
  thermal: Thermal;
  lowPowerMode: boolean;
  /// On battery (unplugged), debounced 2 min by SystemInputs.
  onBattery: boolean;
  /// Camera pressure 0 nominal … 3 critical.
  cameraPressure: number;
  /// The face missing frames: 1 − delivered/requested over the last window.
  frameDropRate: number;
}

export const makeGovernorInputs = (o: Partial<GovernorInputs> = {}): GovernorInputs =>
  ({ thermal: 0, lowPowerMode: false, onBattery: false, cameraPressure: 0, frameDropRate: 0, ...o });

export interface Budget {
  level: number;
  /// Perception's pressure cap: 0 nominal … 3 critical.
  perceptionPressure: number;
  /// Frame-rate ceiling (60 or 120): only the burst is ever capped.
  rateCeilingFPS: number;
  /// The renderer's drawable scale (1 or 0.8).
  renderScale: number;
  backgroundSuppressed: boolean;
  /// The listening glow's edge motion (1 full, 0.5 half, 0 static).
  glowMotion: number;
  /// OLED brightness ceiling (×; 1 = none).
  oledBrightnessScale: number;
  /// The empty-room dim starts this many times sooner.
  idleDimSooner: number;
  snapshotsAllowed: boolean;
  /// The targets (never lowered, at any level).
  readonly awakeTargetFPS: 60;
  readonly asleepTargetFPS: 30;
}

export class ResourceGovernor {
  static readonly stepDownAfter = 300;
  /// Serious this long → level 3.
  static readonly seriousEscalation = 600;
  /// Memory warnings within this window count as repeated (level 3).
  static readonly memoryWindow = 60;
  /// A memory warning holds level 2 at least this long.
  static readonly memoryHold = 300;
  /// The face dropping more than this fraction of frames raises level 1.
  static readonly frameDropLimit = 0.02;

  level = 0;
  reason = 'nominal';
  inputs: GovernorInputs = makeGovernorInputs();
  private betterSince: number | null = null;
  private seriousSince: number | null = null;
  private memoryWarnings: number[] = [];

  /// Restores a level (a relaunch within 10 min of a hot device keeps it, then steps down by the usual rule).
  static restored(restoredLevel: number, now: number): ResourceGovernor {
    const g = new ResourceGovernor();
    g.level = Math.min(Math.max(Math.trunc(restoredLevel) || 0, 0), 4);
    g.reason = 'restored';
    g.betterSince = now;
    return g;
  }

  noteMemoryWarning(now: number): void {
    this.memoryWarnings.push(now);
    this.memoryWarnings = this.memoryWarnings.filter((t) => !(now - t > ResourceGovernor.memoryHold));
  }

  /// The level the inputs call for right now (worst input wins), with its reason.
  demanded(i: GovernorInputs, now: number): { level: number; reason: string } {
    let l = 0, why = 'nominal';
    const raise = (n: number, r: string) => { if (n > l) { l = n; why = r; } };
    if (i.thermal === Thermal.fair) raise(1, 'thermal fair');
    if (i.lowPowerMode) raise(1, 'Low Power Mode');
    if (i.onBattery) raise(1, 'on battery');
    if (i.cameraPressure >= 1) raise(1, 'camera pressure');
    if (i.frameDropRate > ResourceGovernor.frameDropLimit) raise(1, 'face missing frames');
    if (i.thermal === Thermal.serious) raise(2, 'thermal serious');
    if (this.memoryWarnings.some((t) => now - t <= ResourceGovernor.memoryHold)) raise(2, 'memory warning');
    const s = this.seriousSince;
    if (s !== null && i.thermal >= Thermal.serious && now - s >= ResourceGovernor.seriousEscalation) raise(3, 'serious > 10 min');
    if (this.memoryWarnings.filter((t) => now - t <= ResourceGovernor.memoryWindow).length >= 2) raise(3, 'repeated memory warnings');
    if (i.thermal === Thermal.critical) raise(4, 'thermal critical');
    return { level: l, reason: why };
  }

  /// Feeds the inputs (≈ 1 Hz). Returns the new level when it changes, else null.
  update(i: GovernorInputs, now: number): number | null {
    this.inputs = { ...i };
    if (i.thermal >= Thermal.serious) this.seriousSince = this.seriousSince ?? now; else this.seriousSince = null;
    const { level: want, reason: why } = this.demanded(i, now);
    if (want > this.level) {
      this.level = want;
      this.reason = why;
      this.betterSince = null;
      return this.level;
    }
    if (want === this.level) {
      this.reason = why;
      this.betterSince = null;
      return null;
    }
    // Better: one level down after 5 min at the better input.
    const since = this.betterSince ?? now;
    this.betterSince = since;
    if (!(now - since >= ResourceGovernor.stepDownAfter)) return null;
    this.level -= 1;
    this.reason = this.level === want ? why : 'stepping down';
    this.betterSince = this.level > want ? now : null;
    return this.level;
  }

  get budget(): Budget { return ResourceGovernor.budget(this.level); }

  /// The cumulative effects of a level (design §6.4 table).
  static budget(level: number): Budget {
    const l = Math.min(Math.max(level, 0), 4);
    return {
      level: l,
      perceptionPressure: [0, 1, 2, 2, 3][l],
      rateCeilingFPS: l >= 1 ? 60 : 120,
      renderScale: l >= 3 ? 0.8 : 1,
      backgroundSuppressed: l >= 3,
      glowMotion: [1, 1, 0.5, 0, 0][l],
      oledBrightnessScale: l >= 3 ? 0.85 : 1,
      idleDimSooner: l >= 3 ? 2 : 1,
      snapshotsAllowed: l < 4,
      awakeTargetFPS: 60,
      asleepTargetFPS: 30,
    };
  }
}
