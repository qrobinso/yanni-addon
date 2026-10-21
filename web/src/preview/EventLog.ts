// The app's event log (Swift DevStatusModel's `events`): the last 200 events, newest first, for the Status page, the
// HUD and diagnostics. `ctx.logEvent` writes here; nothing reads it per frame. Never message text, transcripts,
// caption words or tokens: callers log what happened, not what was said.

export interface LoggedEvent {
  readonly id: number;
  /** Wall clock, epoch milliseconds. */
  readonly at: number;
  readonly category: string;
  readonly text: string;
}

/** What the Status page reads: newest first, with a version that moves on every change. */
export interface EventSource {
  events(): LoggedEvent[];
  readonly version: number | string;
  clear(): void;
}

const CANONICAL: Record<string, string> = {
  face: 'Face', life: 'Life', voice: 'Voice', touch: 'Touch', people: 'People', emotion: 'Emotion', home: 'HA', ha: 'HA',
  scene: 'Scene', talk: 'Talk',
};
/** The Status chip a category belongs to ("home" → "HA", "voice" → "Voice"); unknown ones are kept. */
export const canonicalCategory = (c: string): string => CANONICAL[c.toLowerCase()] ?? c;

export class EventLog implements EventSource {
  static readonly capacity = 200;
  /** The Status page's filter chips (Swift `StatusSubsystem`); other categories show too and get a chip once seen. */
  static readonly categories: readonly string[] = ['Face', 'Life', 'Voice', 'Touch', 'People', 'Emotion', 'HA', 'Scene', 'Talk'];

  private readonly ring: (LoggedEvent | undefined)[] = new Array<LoggedEvent | undefined>(EventLog.capacity);
  private head = 0;
  private count = 0;
  private nextID = 0;
  /** Bumped on every change: pollers redraw only when it moved. */
  version = 0;
  /** Every event as it is logged (the kiosk's persistent log). */
  onEvent: ((e: LoggedEvent) => void) | null = null;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  log(category: string, text: string): void {
    const e: LoggedEvent = { id: ++this.nextID, at: this.clock(), category: canonicalCategory(category), text };
    this.ring[this.head] = e;
    this.head = (this.head + 1) % EventLog.capacity;
    this.count = Math.min(this.count + 1, EventLog.capacity);
    this.version += 1;
    this.onEvent?.(e);
  }

  get size(): number { return this.count; }

  /** Newest first. */
  events(): LoggedEvent[] {
    const out: LoggedEvent[] = [];
    for (let i = 1; i <= this.count; i++) out.push(this.ring[(this.head - i + EventLog.capacity) % EventLog.capacity]!);
    return out;
  }

  get last(): LoggedEvent | null {
    return this.count === 0 ? null : this.ring[(this.head - 1 + EventLog.capacity) % EventLog.capacity]!;
  }

  /** The AppContext `events` shape: oldest first. */
  get contextEvents(): { at: number; category: string; message: string }[] {
    return this.events().reverse().map((e) => ({ at: e.at, category: e.category, message: e.text }));
  }

  clear(): void {
    this.ring.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.version += 1;
  }
}

/** The Status page's view of the log: a category filter and a pause that freezes what is shown. */
export class EventLogView {
  /** Hidden categories (everything else shows, including categories nobody listed). */
  readonly hidden = new Set<string>();
  private frozen: LoggedEvent[] | null = null;

  constructor(readonly log: EventSource) {}

  get paused(): boolean { return this.frozen !== null; }
  togglePause(): void { this.frozen = this.frozen ? null : this.log.events(); }
  toggle(category: string): void { if (!this.hidden.delete(category)) this.hidden.add(category); }
  isShown(category: string): boolean { return !this.hidden.has(category); }

  clear(): void {
    this.log.clear();
    if (this.frozen) this.frozen = [];
  }

  /** Chips: the standard categories, then any other seen, in order of first appearance. */
  categories(): string[] {
    const out = [...EventLog.categories];
    for (const e of this.log.events().reverse()) if (!out.includes(e.category)) out.push(e.category);
    return out;
  }

  visible(): LoggedEvent[] { return (this.frozen ?? this.log.events()).filter((e) => !this.hidden.has(e.category)); }
}

/** The app's `ctx.events` (newest last, at most 200) as a source. Clear hides what is there now. */
export function contextEventSource(ctx: { readonly events: readonly { at: number; category: string; message: string }[] }): EventSource {
  let cutoff = -Infinity;
  return {
    get version() { const e = ctx.events; return `${e.length}:${e[e.length - 1]?.at ?? 0}:${cutoff}`; },
    events() {
      const out: LoggedEvent[] = [];
      const e = ctx.events;
      for (let i = e.length - 1; i >= 0; i--) {
        const x = e[i]!;
        if (x.at <= cutoff) break;
        out.push({ id: i, at: x.at, category: canonicalCategory(x.category), text: x.message });
      }
      return out;
    },
    clear() { cutoff = ctx.events[ctx.events.length - 1]?.at ?? cutoff; },
  };
}

/** The app's one log: `ctx.logEvent` writes here (main.ts), the Status page, the HUD and diagnostics read it. */
export const appEventLog = new EventLog();
