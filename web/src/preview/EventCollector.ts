// The event log's own sources (Swift FrameEventRecorder + DevStatusModel.collectEvents): an allocation-free after-frame
// hook records agent-state changes, one-shot starts and chirps as raw numbers in a fixed ring; a 1 Hz timer formats
// them into the log together with the cheap diffs (pupil arbiter decisions, sulking, people coming and going, voice
// output and config changes). Life-cycle phase changes, emotion events and perception events arrive by callback
// (chained, never replacing an existing one). The log keeps filling while the Status page is closed.
import type { AppContext } from '../app/AppContext';
import { AgentState } from '../engine/AgentState';
import { OneShotKind } from '../engine/Commands';
import { PerceptionEvent } from '../perception/PerceptionTypes';
import { allVoiceReactions } from '../voice/model/VoiceModel';

const CAP = 256;
const AGENT = 0, ONESHOT = 1, CHIRP = 2;

export class EventCollector {
  private readonly kind = new Uint8Array(CAP);
  private readonly value = new Int16Array(CAP);
  private head = 0;
  private tail = 0;
  private lastState: AgentState;
  private lastScheduled: unknown = null;
  private lastPupilSerial: number;
  private lastSulking = false;
  private lastPeople = new Set<number>();
  private lastPrimary: number | null = null;
  private lastEngaged: number | null = null;
  private lastOutputRunning: boolean | null = null;
  private lastVoiceConfig = '';
  private lastHa: boolean | null = null;

  constructor(readonly ctx: AppContext, readonly log: { log(category: string, text: string): void }) {
    this.lastState = ctx.engine.state.agentState;
    this.lastPupilSerial = ctx.engine.pupilReactionEvents.serial;
    this.lastScheduled = ctx.voice?.lastScheduled ?? null;
  }

  private push(k: number, v: number): void {
    const next = (this.head + 1) % CAP;
    if (next === this.tail) return; // full until the next drain: drop, never allocate
    this.kind[this.head] = k;
    this.value[this.head] = v;
    this.head = next;
  }

  /** After every engine frame: comparisons and typed-array writes only. */
  afterFrame(): void {
    const s = this.ctx.engine.state;
    if (s.agentState !== this.lastState) {
      this.lastState = s.agentState;
      this.push(AGENT, AgentState.allCases.indexOf(s.agentState));
    }
    for (let i = 0; i < s.startedOneShots.length; i++) this.push(ONESHOT, OneShotKind.ordinal(s.startedOneShots[i]!.kind));
    const sch = this.ctx.voice?.lastScheduled ?? null;
    if (sch !== this.lastScheduled) {
      this.lastScheduled = sch;
      if (sch) this.push(CHIRP, allVoiceReactions.indexOf(sch.phrase.reaction));
    }
  }

  /** Formats what the frame hook queued, then the cheap diffs (1 Hz, off the frame path). */
  drain(): void {
    while (this.tail !== this.head) {
      const k = this.kind[this.tail]!, v = this.value[this.tail]!;
      this.tail = (this.tail + 1) % CAP;
      if (k === AGENT) this.log.log('Face', `state → ${AgentState.allCases[v] ?? '?'}`);
      else if (k === ONESHOT) this.log.log('Face', `one-shot ${OneShotKind.allCases[v] ?? '?'}`);
      else this.log.log('Voice', `chirp ${allVoiceReactions[v] ?? '?'}`);
    }
    const e = this.ctx.engine;
    const pe = e.pupilReactionEvents;
    if (pe.serial !== this.lastPupilSerial) {
      for (const ev of pe.events) if (ev.serial > this.lastPupilSerial) this.log.log('Face', `pupils: ${ev.text}`);
      this.lastPupilSerial = pe.serial;
    }
    const tr = e.director.modifier('TouchReactions') as unknown as { isSulking: boolean } | undefined;
    if (tr && tr.isSulking !== this.lastSulking) {
      this.lastSulking = tr.isSulking;
      this.log.log('Touch', tr.isSulking ? 'sulking started' : 'sulking ended');
    }
    this.diffPeople();
    this.diffVoice();
    const c = this.ctx.client;
    if (c && c.haConnected !== this.lastHa) {
      if (this.lastHa !== null) this.log.log('HA', `Home Assistant ${c.haConnected ? 'connected' : 'disconnected'}`);
      this.lastHa = c.haConnected;
    }
  }

  private diffPeople(): void {
    const s = this.ctx.engine.state;
    // Real perception logs its own entered / left events (with exit edges and reactions).
    if (!this.ctx.perception) {
      const now = new Set(s.people.map((p) => p.id));
      for (const p of s.people) {
        if (!this.lastPeople.has(p.id)) {
          this.log.log('People', `person ${p.id} entered at (${p.position.x.toFixed(2)}, ${p.position.y.toFixed(2)}), ${p.distance.toFixed(1)} m`);
        }
      }
      for (const id of this.lastPeople) if (!now.has(id)) this.log.log('People', `person ${id} left`);
      this.lastPeople = now;
    }
    if (s.primaryPersonID !== this.lastPrimary) {
      this.log.log('People', `primary: ${this.lastPrimary ?? 'none'} → ${s.primaryPersonID ?? 'none'}`);
      this.lastPrimary = s.primaryPersonID;
    }
    if (s.engagedPersonID !== this.lastEngaged) {
      this.log.log('People', `engaged: ${this.lastEngaged ?? 'none'} → ${s.engagedPersonID ?? 'none'}`);
      this.lastEngaged = s.engagedPersonID;
    }
  }

  private diffVoice(): void {
    const v = this.ctx.voice;
    if (!v) return;
    const running = v.output?.isRunning ?? false;
    if (running !== this.lastOutputRunning) {
      if (this.lastOutputRunning !== null || !running) this.log.log('Voice', running ? 'audio output started' : 'audio output stopped');
      this.lastOutputRunning = running;
    }
    const s = v.settings;
    const cfg = `${s.muted ? 'muted' : 'unmuted'}, quiet ${s.quietMode ? 'on' : 'off'}, auto-vocalize ${s.autoVocalize ? 'on' : 'off'}, `
      + `bedtime sounds ${s.bedtimeSounds}, volume ${s.volume.toFixed(2)}, bedtime ${v.isBedtime ? 'on' : 'off'}`;
    if (cfg !== this.lastVoiceConfig) {
      if (this.lastVoiceConfig !== '') this.log.log('Voice', `config: ${cfg}`);
      this.lastVoiceConfig = cfg;
    }
  }
}

/** Starts the collector: the after-frame hook, the 1 Hz drain and the chained callbacks, all writing through
 *  `ctx.logEvent` (or `log`). Call once at boot. Returns a stop that ends the drain and the subscriptions (the frame hook
 *  stays: FrameClock has no removal, and it goes inert). */
export function startEventCollector(ctx: AppContext, log: { log(category: string, text: string): void } = { log: (c, t) => ctx.logEvent(c, t) }): () => void {
  const c = new EventCollector(ctx, log);
  let live = true;
  ctx.clock.addAfterFrame(() => { if (live) c.afterFrame(); });
  const timer = setInterval(() => c.drain(), 1000);
  const life = ctx.life, prevPhase = life.onPhaseChange;
  life.onPhaseChange = (ch) => {
    prevPhase?.(ch);
    log.log('Life', `${ch.from} → ${ch.to} (${ch.reason}) · ${ch.agentState}`);
  };
  const layer = ctx.emotion, prevEmotion = layer?.onEvent ?? null;
  if (layer) layer.onEvent = (e) => { prevEmotion?.(e); log.log('Emotion', e.text); };
  const unsub = ctx.perception?.onEvent((e, note) => log.log('People', PerceptionEvent.text(e) + (note ? ` → ${note}` : ''))) ?? null;
  return () => {
    live = false;
    clearInterval(timer);
    unsub?.();
  };
}
