// Port of the test rig in Tests/FaceEngineTests/AgentStateTests.swift (shared by the AgentState / Mood / Expression /
// IdleBeats suites).
import { Director, FaceState, Phase, type AgentState, type FaceCommand, type Modifier, type OneShotKind } from '../../src/engine';
import { ExpressionLibrary } from '../../src/model';

/// Injects one-shot bookkeeping as the (stubbed) OneShotSampler would. Register before the modifier
/// under test so it runs after the director's per-frame reset.
export class ASTOneShotProbe implements Modifier {
  readonly name = 'ASTOneShotProbe';
  readonly phase = Phase.behaviour;
  isEnabled = true;
  completeNext: OneShotKind[] = [];
  active: OneShotKind[] | null = null;
  update(s: FaceState): void {
    s.completedOneShots.push(...this.completeNext);
    this.completeNext = [];
    if (this.active) s.activeOneShots = [...this.active];
  }
}

/// Records and consumes one-shot requests and commands. Register after the modifier under test.
export class ASTRecorder implements Modifier {
  readonly name = 'ASTRecorder';
  readonly phase = Phase.behaviour;
  isEnabled = true;
  requests: { time: number; kind: OneShotKind }[] = [];
  commands: { time: number; command: FaceCommand }[] = [];
  update(s: FaceState): void {
    for (const k of s.oneShotRequests) this.requests.push({ time: s.time, kind: k });
    s.oneShotRequests.length = 0;
    for (const c of s.commands) this.commands.push({ time: s.time, command: c });
  }
}

/// Minimal engine loop over a Director, mirroring `FaceEngine.tick`.
export class ASTRig {
  director: Director;
  state: FaceState;

  constructor(modifiers: Modifier[], seed: number | bigint = 1) {
    this.director = new Director(modifiers);
    this.state = new FaceState(ExpressionLibrary.bundled(), seed);
  }

  setAgentState(a: AgentState): void {
    if (a === this.state.agentState) return;
    this.state.previousAgentState = this.state.agentState;
    this.state.agentState = a;
    this.state.agentStateEnteredAt = this.state.time;
    this.state.agentStateChanged = true;
  }

  // f32: Swift's dt is a Float and the Double clock accumulates it.
  tick(dt = 1 / 60): void {
    const d = Math.fround(dt);
    this.state.dt = d;
    this.state.time += d;
    this.state.frame += 1;
    this.director.run(this.state);
    this.state.agentStateChanged = false;
    this.state.commands.length = 0;
  }

  run(seconds: number, dt = 1 / 60, each: (r: ASTRig) => void = () => {}): void {
    const n = Math.round(seconds / Math.fround(dt));
    for (let i = 0; i < n; i++) { this.tick(dt); each(this); }
  }
}
