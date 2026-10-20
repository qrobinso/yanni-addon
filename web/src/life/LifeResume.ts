// Port of FaceLife/LifeResume.swift (the controller's `resumeState()` / `restore(_:elapsed:)` call these).
import type { AgentState } from '../engine';
import type { LifeCycleController } from './LifeCycleController';
import type { LifePhase } from './LifeTypes';

/// The life cycle's part of the `ResumeSnapshot` (hardening design §6.2): enough to come back in the same phase after a
/// crash or relaunch, with the elapsed time counted toward the timers. Small and JSON-serialisable.
export interface LifeResumeState {
  phase: LifePhase;
  /// Warped seconds without activity while awake (toward drowsy).
  quietSeconds: number;
  /// Warped seconds in drowsy without activity (toward asleep).
  drowsySeconds: number;
  forceSleep: boolean;
  /// Seconds left on a timed force-sleep hold (null: held until force wake or a tap wake).
  forceSleepRemaining: number | null;
  nightAwake: boolean;
  /// Force wake suspended the current scheduled window.
  scheduleSuspended: boolean;
  isBedtime: boolean;
}

/// Swift's memberwise init with its defaults.
export function makeLifeResumeState(phase: LifePhase, o: Partial<Omit<LifeResumeState, 'phase'>> = {}): LifeResumeState {
  return {
    phase, quietSeconds: 0, drowsySeconds: 0, forceSleep: false, forceSleepRemaining: null, nightAwake: false,
    scheduleSuspended: false, isBedtime: false, ...o,
  };
}

/// What a relaunch needs to resume (written into the `ResumeSnapshot` every 60 s and on change).
export function resumeState(life: LifeCycleController): LifeResumeState {
  const now = life.clock.monotonic();
  return {
    phase: life.phase, quietSeconds: life.quiet, drowsySeconds: life.drowsyElapsed,
    forceSleep: life.isForceSleepActive,
    forceSleepRemaining: life.forceSleepUntil !== null ? Math.max(life.forceSleepUntil - now, 0) : null,
    nightAwake: life.isNightAwake, scheduleSuspended: life.scheduleSuspended, isBedtime: life.isBedtime,
  };
}

/// Restores a saved phase before the first frame (hardening design §6.2). Asleep (or half-awake) comes back asleep,
/// drowsy as drowsy, anything awake as idle: the state is set directly, so there is no wake, yawn or entry one-shot and
/// it is never counted as activity. `elapsed` (seconds since the snapshot) counts toward the timers, so asleep stays
/// asleep and a long drowsy may come back asleep. The schedule is re-evaluated for the current time first.
export function restore(life: LifeCycleController, r: LifeResumeState, elapsed: number): void {
  const e = Number.isFinite(elapsed) ? Math.max(elapsed, 0) : 0;
  const now = life.clock.monotonic();
  if (r.forceSleep) {
    const left = r.forceSleepRemaining;
    if (left !== null) {
      life.isForceSleepActive = left > e;
      life.forceSleepUntil = left > e ? now + (left - e) : null;
    } else {
      life.isForceSleepActive = true;
      life.forceSleepUntil = null;
    }
  }
  life.scheduleSuspended = r.scheduleSuspended;
  life.evaluateSchedule(true);
  life.isNightAwake = r.nightAwake && (life.isBedtime || life.isForceSleepActive);

  let target: AgentState;
  switch (r.phase) {
    case 'asleep': case 'halfAwake': target = 'asleep'; break;
    case 'drowsy': target = 'drowsy'; break;
    case 'awake': case 'waking': target = 'idle'; break;
  }
  const from = life.engine.state.agentState;
  if (target === 'drowsy' && r.drowsySeconds + e >= life.settings.minutesToAsleep * 60 && !life.isBedtime) target = 'asleep';
  life.applyTapPermission(target);
  life.engine.setAgentState(target);
  life.entered(target, from);
  const fin = (v: number): number => (Number.isFinite(v) ? Math.max(v, 0) : 0);
  if (target === 'idle') life.quiet = fin(r.quietSeconds) + e;
  else if (target === 'drowsy') life.drowsyElapsed = fin(r.drowsySeconds) + e;
  life.lastAgentState = target;
  life.emitIfChanged('restore');
  life.applyTapPermission(target);
}
