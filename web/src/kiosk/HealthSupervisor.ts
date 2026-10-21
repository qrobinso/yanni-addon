// Port of YanniKiosk/HealthSupervisor.swift. Watchdogs for the subsystems (hardening design §6.1): probe each at a
// 1 s tick, restart with jittered exponential backoff, open a circuit after `trip` failures within the window.
// Never on the frame path.

export type SubsystemName = 'render' | 'audio' | 'perception' | 'conversation' | 'mqtt' | 'snapshots' | 'settings';

export type SubsystemHealth =
  | { kind: 'ok' }
  | { kind: 'starting' }
  /// Restart number `attempt` is due at `nextAt` (supervisor time).
  | { kind: 'restarting'; attempt: number; nextAt: number }
  /// The circuit opened: no restarts until the cooldown ends, then one probe start.
  | { kind: 'degraded'; reason: string }
  /// Not running on purpose (disabled, not configured, held back by the launch guard, hidden).
  | { kind: 'off'; reason: string };

export const SubsystemHealth = {
  ok: { kind: 'ok' } as SubsystemHealth,
  starting: { kind: 'starting' } as SubsystemHealth,
  restarting: (attempt: number, nextAt: number): SubsystemHealth => ({ kind: 'restarting', attempt, nextAt }),
  degraded: (reason: string): SubsystemHealth => ({ kind: 'degraded', reason }),
  off: (reason: string): SubsystemHealth => ({ kind: 'off', reason }),
  isProblem: (h: SubsystemHealth): boolean => h.kind === 'restarting' || h.kind === 'degraded',
  label(h: SubsystemHealth): string {
    switch (h.kind) {
      case 'ok': return 'ok';
      case 'starting': return 'starting';
      case 'restarting': return `restarting (${h.attempt})`;
      case 'degraded': return `degraded: ${h.reason}`;
      case 'off': return `off: ${h.reason}`;
    }
  },
  equals(a: SubsystemHealth, b: SubsystemHealth): boolean { return JSON.stringify(a) === JSON.stringify(b); },
};

export type ProbeResult = { kind: 'ok' } | { kind: 'off'; reason: string } | { kind: 'failed'; reason: string };
export const ProbeResult = {
  ok: { kind: 'ok' } as ProbeResult,
  off: (reason: string): ProbeResult => ({ kind: 'off', reason }),
  failed: (reason: string): ProbeResult => ({ kind: 'failed', reason }),
};

/// Restart policy: jittered exponential backoff (or an explicit schedule) and a circuit breaker (§6.1).
export class RestartPolicy {
  window = 600;
  /// ± fraction of jitter on every delay.
  jitter = 0.2;
  /// This long healthy resets the attempt count.
  stableReset = 60;

  constructor(
    /// Explicit first delays (seconds), used before the exponential takes over (render: 0, 1, 5).
    readonly schedule: number[],
    readonly base: number,
    readonly cap: number,
    /// Failures within `window` that open the circuit (Infinity: never).
    readonly trip: number,
    readonly cooldown: number,
    /// After a restart, how long before probing again.
    readonly settle = 2,
  ) {}

  static make(o: { schedule?: number[]; base: number; cap: number; trip: number; cooldown: number; settle?: number }): RestartPolicy {
    return new RestartPolicy(o.schedule ?? [], o.base, o.cap, o.trip, o.cooldown, o.settle ?? 2);
  }

  /// The delay before restart number `attempt` (0-based) with `u` ∈ 0…1 as the jitter draw.
  delay(attempt: number, u: number): number {
    let raw: number;
    if (attempt < this.schedule.length) raw = this.schedule[attempt];
    else raw = Math.min(this.base * Math.pow(2, Math.min(attempt - this.schedule.length, 30)), this.cap);
    const j = 1 + this.jitter * (2 * Math.min(Math.max(u, 0), 1) - 1);
    return Math.max(raw * j, 0);
  }

  /// Design §6.1 table.
  static readonly render = RestartPolicy.make({ schedule: [0, 1, 5], base: 600, cap: 600, trip: Infinity, cooldown: 0 });
  static readonly audio = RestartPolicy.make({ base: 0.5, cap: 30, trip: 5, cooldown: 600 });
  static readonly perception = RestartPolicy.make({ base: 1, cap: 60, trip: 6, cooldown: 600, settle: 5 });
  static readonly mqtt = RestartPolicy.make({ base: 30, cap: 300, trip: 6, cooldown: 1800, settle: 30 });
  static readonly snapshots = RestartPolicy.make({ base: 5, cap: 300, trip: 5, cooldown: 1800 });
}

/// One subsystem's watchdog: probes it at the supervisor's tick, restarts it with backoff, opens the circuit after
/// `trip` failures within the window.
export class Watchdog {
  health: SubsystemHealth = SubsystemHealth.starting;
  lastError: string | null = null;
  restarts = 0;
  attempt = 0;
  /// Fires on every health transition (log, ring log, HA).
  onTransition: ((name: SubsystemName, h: SubsystemHealth) => void) | null = null;

  private failures: number[] = [];
  private pendingRestartAt: number | null = null;
  private settleUntil: number | null = null;
  private cooldownUntil: number | null = null;
  private okSince: number | null = null;

  /// `restart` is called with the attempt number (0-based); the render watchdog escalates by it.
  constructor(readonly name: SubsystemName, readonly policy: RestartPolicy, private readonly probe: () => ProbeResult,
    private readonly restart: (attempt: number) => void, private readonly random: () => number = Math.random) {}

  /// One supervisor tick.
  tick(now: number): void {
    if (this.cooldownUntil !== null) {
      if (now < this.cooldownUntil) return;
      this.cooldownUntil = null;
      this.failures.length = 0;
      this.performRestart(now);   // one probe start after the cooldown
      return;
    }
    if (this.pendingRestartAt !== null) {
      if (now >= this.pendingRestartAt) {
        this.pendingRestartAt = null;
        this.performRestart(now);
      } else if (this.probe().kind === 'ok') {
        // Recovered on its own while waiting (a long backoff): no restart needed.
        this.pendingRestartAt = null;
        this.transition(SubsystemHealth.ok);
      }
      return;
    }
    if (this.settleUntil !== null) {
      if (now < this.settleUntil) return;
      this.settleUntil = null;
    }
    const p = this.probe();
    switch (p.kind) {
      case 'ok':
        if (this.health.kind !== 'ok') this.transition(SubsystemHealth.ok);
        if (this.attempt > 0) {
          const since = this.okSince ?? now;
          this.okSince = since;
          if (now - since >= this.policy.stableReset) { this.attempt = 0; this.okSince = null; }
        }
        break;
      case 'off': {
        this.okSince = null;
        this.attempt = 0;
        const h = SubsystemHealth.off(p.reason);
        if (!SubsystemHealth.equals(this.health, h)) this.transition(h);
        break;
      }
      case 'failed': {
        this.okSince = null;
        this.lastError = p.reason;
        this.failures.push(now);
        this.failures = this.failures.filter((t) => !(now - t > this.policy.window));
        if (this.failures.length >= this.policy.trip) {
          this.cooldownUntil = now + this.policy.cooldown;
          this.transition(SubsystemHealth.degraded(p.reason));
          return;
        }
        const d = this.policy.delay(this.attempt, this.random());
        this.transition(SubsystemHealth.restarting(this.attempt + 1, now + d));
        if (d <= 0) this.performRestart(now); else this.pendingRestartAt = now + d;
        break;
      }
    }
  }

  private performRestart(now: number): void {
    this.restart(this.attempt);
    this.attempt += 1;
    this.restarts += 1;
    this.settleUntil = now + this.policy.settle;
  }

  private transition(h: SubsystemHealth): void {
    this.health = h;
    this.onTransition?.(this.name, h);
  }
}

/// Runs the watchdogs on a 1 s timer (hardening design §6.1).
export class HealthSupervisor {
  static readonly interval = 1;
  readonly watchdogs: Watchdog[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly now: () => number = () => performance.now() / 1000) {}

  add(w: Watchdog): void { this.watchdogs.push(w); }
  watchdog(name: SubsystemName): Watchdog | undefined { return this.watchdogs.find((w) => w.name === name); }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), HealthSupervisor.interval * 1000);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    const t = this.now();
    for (const w of this.watchdogs) w.tick(t);
  }

  /// Subsystems with a problem (restarting or degraded), for the overall health.
  get problems(): SubsystemName[] { return this.watchdogs.filter((w) => SubsystemHealth.isProblem(w.health)).map((w) => w.name); }
}
