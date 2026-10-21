// Port of YanniKiosk/DiagnosticsLog.swift. The app's own persistent ring log (hardening design §9.4): evidence from
// before a crash has to be written by the app. JSON lines in localStorage "files" (`yanni.diag.log-0` newest …
// `log-(n-1)` oldest), `fileLimit` characters each; lines are batched in memory and written every `flushInterval`
// and on hide (low write volume).
//
// Contents: the event log stream, health and watchdog transitions, resource levels, launch records, vitals. **Never**
// camera frames, snapshots, transcripts, announcement text, names or credentials: callers pass only enums, counts and
// short technical text.
import type { KeyValue } from '../app/OwnerAccess';

export interface LogLine { t: string; c: string; m: string }

export class DiagnosticsLog {
  /// port-note: the Swift files are 2 MB × 5; localStorage holds ~5 MB per origin, shared with settings. Small files
  /// and a slow flush because every flush rewrites all of `log-0` synchronously (flash wear on a 24/7 kiosk).
  static readonly defaultFileLimit = 64 * 1024;
  static readonly defaultFileCount = 16;
  static readonly flushInterval = 30;
  /// Longest message kept (a log line is never a transcript).
  static readonly maxMessage = 300;
  static readonly prefix = 'yanni.diag.log-';

  readonly fileLimit: number;
  readonly fileCount: number;
  private pending: LogLine[] = [];
  /// `log-0` as last written (null until the first flush reads it): this page is its only writer.
  private head: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly store: KeyValue, fileLimit = DiagnosticsLog.defaultFileLimit,
    fileCount = DiagnosticsLog.defaultFileCount, private readonly now: () => Date = () => new Date()) {
    this.fileLimit = Math.max(fileLimit, 1024);
    this.fileCount = Math.max(fileCount, 2);
  }

  private file(i: number): string { return DiagnosticsLog.prefix + i; }

  /// Starts the periodic flush.
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.flush(), DiagnosticsLog.flushInterval * 1000);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /// Adds a line. Cheap: appends to the in-memory batch.
  add(category: string, message: string, at: Date = this.now()): void {
    const m = message.length > DiagnosticsLog.maxMessage ? message.slice(0, DiagnosticsLog.maxMessage) + '…' : message;
    this.pending.push({ t: at.toISOString(), c: category, m });
  }

  /// Writes the batch now (hide, before a reload, before an export). Synchronous.
  flush(): void {
    if (!this.pending.length) return;
    const data = this.pending.map((l) => JSON.stringify(l) + '\n').join('');
    this.pending.length = 0;
    let base = this.head ?? this.store.getItem(this.file(0)) ?? '';
    if (base.length > 0 && base.length + data.length > this.fileLimit) { this.rotate(); base = ''; }
    try {
      this.store.setItem(this.file(0), base + data);
      this.head = base + data;
    } catch {
      // Quota: drop the oldest file and retry once.
      this.rotate();
      try { this.store.setItem(this.file(0), data); this.head = data; } catch { this.head = ''; /* full: the batch is lost, never the page */ }
    }
  }

  /// Every line, oldest first (export, tests).
  readAll(): LogLine[] {
    const out: LogLine[] = [];
    for (let i = this.fileCount - 1; i >= 0; i--) {
      const raw = this.store.getItem(this.file(i));
      if (!raw) continue;
      for (const s of raw.split('\n')) {
        if (!s) continue;
        try { out.push(JSON.parse(s) as LogLine); } catch { /* a torn line */ }
      }
    }
    return out;
  }

  /// Total characters stored.
  totalBytes(): number {
    let n = 0;
    for (let i = 0; i < this.fileCount; i++) n += this.store.getItem(this.file(i))?.length ?? 0;
    return n;
  }

  private rotate(): void {
    this.store.removeItem(this.file(this.fileCount - 1));
    for (let i = this.fileCount - 2; i >= 0; i--) {
      const v = this.store.getItem(this.file(i));
      if (v === null) continue;
      this.store.setItem(this.file(i + 1), v);
      this.store.removeItem(this.file(i));
    }
  }
}
