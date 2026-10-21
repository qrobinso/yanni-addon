// Port of ConversationTestSupport/FakeSpeechToText.swift. A recogniser behind the seam, driven by the test: its health,
// whether `start` fails, the transcript `finish` returns (or an error). Records every session's samples.
import type { AgentClock } from '../../../src/conversation/agent/AgentTunables';
import type { SpeechToText, SpeechToTextHealth, TranscriptionSession } from '../../../src/conversation/agent/Ports';

export class FakeSTTFailure extends Error { override name = 'Failure'; }

export class FakeSpeechToText implements SpeechToText {
  health: SpeechToTextHealth = { kind: 'up', engine: 'fake-stt' };
  transcript = "what's the weather like today?";
  failStart = false;
  failFinish = false;
  partials: string[] = [];
  sessions: FakeTranscriptionSession[] = [];

  configure(c: { health?: SpeechToTextHealth; transcript?: string; failStart?: boolean; failFinish?: boolean; partials?: string[] }): void {
    if (c.health) this.health = c.health;
    if (c.transcript !== undefined) this.transcript = c.transcript;
    if (c.failStart !== undefined) this.failStart = c.failStart;
    if (c.failFinish !== undefined) this.failFinish = c.failFinish;
    if (c.partials) this.partials = c.partials;
  }

  async describe(_timeout: number): Promise<SpeechToTextHealth> { return this.health; }

  async start(_language: string | null): Promise<TranscriptionSession> {
    if (this.failStart) throw new FakeSTTFailure();
    const s = new FakeTranscriptionSession(this.transcript, this.failFinish, [...this.partials]);
    this.sessions.push(s);
    return s;
  }
}

export class FakeTranscriptionSession implements TranscriptionSession {
  samples: number[] = [];
  finished = false;
  closed = false;
  private handler: ((text: string) => void) | null = null;
  /** `partials` are reported one per `send` (like volatile results while the person speaks). */
  constructor(private readonly transcript: string, private readonly fail: boolean, private readonly partials: string[] = []) {}

  onPartial(handler: (text: string) => void): void { this.handler = handler; }

  async send(samples: Int16Array): Promise<void> {
    if (this.closed) throw new FakeSTTFailure();
    for (const s of samples) this.samples.push(s);
    if (this.handler && this.partials.length > 0) this.handler(this.partials.shift()!);
  }

  async finish(_timeout: number, _clock: AgentClock): Promise<string> {
    this.finished = true;
    if (this.fail) throw new FakeSTTFailure();
    return this.transcript;
  }

  close(): void { this.closed = true; }
}
