// Port of ConversationAgent/LocalAgentTransport.swift. The local `VoiceTransport` (direct Home Assistant design §3,
// §5): a thin facade over the `TurnOrchestrator`. Intents go to the orchestrator in order; its outputs come back in
// order and are handed to the controller as they are. Nothing is queued for a remote peer: the transport is local.
// port-note: the command pump and output reader become microtask hops, so the controller never re-enters itself
// from inside `send` and order is kept.
import type { AgentEvent } from '../events/AgentEvents';
import type { AgentIntent } from '../events/AgentIntents';
import type { TransportEvent, TransportStatus, VoiceTransport } from '../core/Ports';
import type { VoiceServicesEndpoint } from '../core/VoiceServicesEndpoint';
import { makeServicesHealth, type ServicesHealth } from './AgentTunables';
import { TurnOrchestrator, type OrchestratorDependencies, type OrchestratorOutput } from './TurnOrchestrator';

const statusEqual = (a: TransportStatus, b: TransportStatus): boolean =>
  a.kind === b.kind && (a.kind !== 'failed' || a.reason === (b as { reason: string }).reason);

export class LocalAgentTransport implements VoiceTransport {
  onEvent: ((e: TransportEvent) => void) | null = null;
  status: TransportStatus = { kind: 'disconnected' };

  /** What the last `connect` used. */
  services: VoiceServicesEndpoint | null = null;
  /** The voice services' health, for the Status card and the HA diagnostic sensor. */
  health: ServicesHealth = makeServicesHealth();
  onHealth: ((h: ServicesHealth) => void) | null = null;
  /** Every agent event as emitted (tests, the decision-replay panel). Never carries text. */
  onAgentEvent: ((e: AgentEvent) => void) | null = null;

  readonly orchestrator: TurnOrchestrator;
  private generation = 0;
  private micEnabled = false;

  constructor(dependencies: OrchestratorDependencies) {
    const o = new TurnOrchestrator(dependencies);
    this.orchestrator = o;
    o.onOutput = (gen, out) => queueMicrotask(() => this.deliver(gen, out));
  }

  /** Commands reach the orchestrator strictly in order, after the caller returns. */
  private command(f: () => void): void { queueMicrotask(f); }

  // MARK: VoiceTransport

  /** Checks the relay to Home Assistant, then the pipeline's speech-to-text and, in Spoken mode, its voice. */
  connect(services: VoiceServicesEndpoint): void {
    this.generation += 1;
    const g = this.generation;
    this.services = services;
    this.setStatus({ kind: 'connecting' });
    this.command(() => this.orchestrator.connect(services, g));
  }

  disconnect(): void {
    this.generation += 1;
    const g = this.generation;
    this.command(() => this.orchestrator.disconnect(g));
    if (this.status.kind !== 'disconnected') this.setStatus({ kind: 'disconnected' });
  }

  setMicEnabled(on: boolean): void {
    if (on === this.micEnabled) return;
    this.micEnabled = on;
    if (!on) this.command(() => this.orchestrator.micClosed());
  }

  send(intent: AgentIntent): void {
    if ((intent.kind === 'speechStart' || intent.kind === 'turnEnd') && this.status.kind !== 'ready') return; // a late turn signal is worse than none
    this.command(() => this.orchestrator.handle(intent));
  }

  /** An announcement is waiting (for the `conversation_context` sensor; never its text). */
  setAnnouncementPending(on: boolean): void {
    this.command(() => this.orchestrator.setAnnouncementPending(on));
  }

  // MARK: Outputs

  private deliver(gen: number, out: OrchestratorOutput): void {
    if (gen !== this.generation) return; // a dropped session's late output
    switch (out.kind) {
      case 'status': this.setStatus(out.status); return;
      case 'health': this.health = out.health; this.onHealth?.(out.health); return;
      case 'event': this.onAgentEvent?.(out.event); this.onEvent?.({ kind: 'agent', event: out.event }); return;
      case 'caption': this.onEvent?.({ kind: 'caption', caption: out.caption }); return; // the controller only, never `onAgentEvent`
    }
  }

  private setStatus(s: TransportStatus): void {
    if (statusEqual(s, this.status)) return;
    this.status = s;
    this.onEvent?.({ kind: 'status', status: s });
  }
}
