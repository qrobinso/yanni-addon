// Port of FacePerception/FeatureRecordingStore.swift.
//
// port-note: the Swift store uses FileManager under Application Support. Here every file operation goes through an
// injected `RecordingFileSystem` (paths are "/"-joined strings); `MemoryFileSystem` is the in-memory one.
import { FeatureRecordingHeader } from './FeatureRecordFormat';
import { RecordingPolicy } from './RecordingConsent';

/// The file operations the recorder needs.
export interface RecordingFileSystem {
  read(path: string): Uint8Array | null;
  /// Creates or replaces a file.
  write(path: string, data: Uint8Array): void;
  /// Appends (creating the file if needed).
  append(path: string, data: Uint8Array): void;
  /// Names of the immediate children of a directory ([] when none).
  list(dir: string): string[];
  isDirectory(path: string): boolean;
  /// Removes a file or a directory tree.
  remove(path: string): void;
  /// Bytes in a file (0 when missing).
  size(path: string): number;
}

/// Resolves "." and ".." (Swift `standardizedFileURL`).
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return (path.startsWith('/') ? '/' : '') + out.join('/');
}
export const joinPath = (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/');
const parentPath = (p: string): string => { const n = normalizePath(p); const i = n.lastIndexOf('/'); return i <= 0 ? (i === 0 ? '/' : '') : n.slice(0, i); };

/// Files in memory (tests, the browser until a persistent backend is wired).
export class MemoryFileSystem implements RecordingFileSystem {
  readonly files = new Map<string, Uint8Array>();
  read(path: string): Uint8Array | null { return this.files.get(normalizePath(path)) ?? null; }
  write(path: string, data: Uint8Array): void { this.files.set(normalizePath(path), data.slice()); }
  append(path: string, data: Uint8Array): void {
    const p = normalizePath(path);
    const old = this.files.get(p) ?? new Uint8Array(0);
    const n = new Uint8Array(old.length + data.length);
    n.set(old); n.set(data, old.length);
    this.files.set(p, n);
  }
  list(dir: string): string[] {
    const d = normalizePath(dir) + '/';
    const names = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(d)) names.add(k.slice(d.length).split('/')[0]);
    return [...names];
  }
  isDirectory(path: string): boolean {
    const d = normalizePath(path) + '/';
    for (const k of this.files.keys()) if (k.startsWith(d)) return true;
    return false;
  }
  remove(path: string): void {
    const p = normalizePath(path);
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + '/')) this.files.delete(k);
  }
  size(path: string): number { return this.files.get(normalizePath(path))?.length ?? 0; }
}

const enc = new TextEncoder(), dec = new TextDecoder();
export const textBytes = (s: string): Uint8Array => enc.encode(s);
export const bytesText = (b: Uint8Array): string => dec.decode(b);

let labelSerial = 0;

/// One labelled window of a session (`labels.json`), in host-clock seconds like the frames.
export interface SessionLabel {
  // port-note: Swift uses a UUID; here a process-unique string.
  id: string;
  start: number;
  end: number;
  /// A gesture name ("wave", "thumbsDown", …), "looking", "notLooking", "crossing", "none", …
  label: string;
  /// Participant pseudonym.
  person: string | null;
  /// The floor mark the prompt asked for (metres): distance ground truth.
  distance: number | null;
  /// People the script puts in view (tracking sessions: ground truth for ID switches).
  people: number | null;
}
export const makeSessionLabel = (start: number, end: number, label: string,
  o: Partial<Pick<SessionLabel, 'person' | 'distance' | 'people'>> = {}): SessionLabel =>
  ({ id: `label-${++labelSerial}`, start, end, label, person: null, distance: null, people: null, ...o });

/// A point mark: the owner's "Wrong reaction" button (the surrounding 5 s are a false positive).
export interface SessionMark { t: number; kind: string; note: string | null }
export const SessionMark = { wrongReaction: 'wrongReaction' } as const;

export interface SessionLabels { labels: SessionLabel[]; marks: SessionMark[] }
export const makeSessionLabels = (labels: SessionLabel[] = [], marks: SessionMark[] = []): SessionLabels => ({ labels, marks });

/// A stored session as the Status card and the viewer list it.
export interface RecordingSessionSummary { id: string; url: string; header: FeatureRecordingHeader | null; bytes: number; startDate: Date }

const tryParse = <T>(f: () => T): T | null => { try { return f(); } catch { return null; } };

/// The recorder's folder: `policy.json` and `recordings/<session>/`.
export class FeatureRecordingStore {
  constructor(readonly fs: RecordingFileSystem, readonly root: string) {}

  static readonly defaultRoot = 'Perception';

  get recordings(): string { return joinPath(this.root, 'recordings'); }

  directory(id: string): string { return joinPath(this.recordings, id); }

  /// A new session id: the start time plus a short random suffix (never a name).
  static newSessionID(date: Date = new Date()): string {
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    // port-note: Swift formats in the device's time zone; here local time too.
    const s = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
    return `${s}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
  }

  // MARK: Policy

  loadPolicy(): RecordingPolicy {
    const d = this.fs.read(joinPath(this.root, 'policy.json'));
    return d === null ? new RecordingPolicy() : RecordingPolicy.decode(bytesText(d)).validated();
  }

  savePolicy(p: RecordingPolicy): void {
    this.fs.write(joinPath(this.root, 'policy.json'), textBytes(JSON.stringify(p.validated(), null, 2)));
  }

  // MARK: Sessions

  sessions(): RecordingSessionSummary[] {
    const out: RecordingSessionSummary[] = [];
    for (const id of this.fs.list(this.recordings)) {
      if (id.startsWith('.')) continue;
      const dir = this.directory(id);
      if (!this.fs.isDirectory(dir)) continue;
      const raw = this.fs.read(joinPath(dir, 'header.json'));
      const header = raw !== null ? tryParse(() => FeatureRecordingHeader.decode(bytesText(raw))) : null;
      // port-note: no folder creation date in the injected file system: sessions without a header sort last.
      out.push({ id, url: dir, header, bytes: FeatureRecordingStore.size(this.fs, dir), startDate: header?.startDate ?? new Date(-8.64e15) });
    }
    return out.sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
  }

  totalBytes(): number { return this.sessions().reduce((s, x) => s + x.bytes, 0); }

  delete(id: string): void {
    const dir = this.directory(id);
    if (parentPath(dir) !== normalizePath(this.recordings)) return;
    this.fs.remove(dir);
  }

  deleteAll(): void { this.fs.remove(this.recordings); }

  /// Retention: deletes sessions that started more than `retentionDays` ago. Returns the deleted ids.
  purge(retentionDays: number, now: Date = new Date()): string[] {
    const cutoff = now.getTime() - retentionDays * 86_400_000;
    const gone: string[] = [];
    for (const s of this.sessions()) {
      if (!(s.startDate.getTime() < cutoff)) continue;
      this.delete(s.id);
      gone.push(s.id);
    }
    return gone;
  }

  // MARK: Labels

  loadLabels(id: string): SessionLabels { return FeatureRecordingStore.loadLabels(this.fs, this.directory(id)); }
  saveLabels(l: SessionLabels, id: string): void { FeatureRecordingStore.saveLabels(this.fs, l, this.directory(id)); }

  static loadLabels(fs: RecordingFileSystem, dir: string): SessionLabels {
    const d = fs.read(joinPath(dir, 'labels.json'));
    const l = d !== null ? tryParse(() => JSON.parse(bytesText(d)) as Partial<SessionLabels>) : null;
    return makeSessionLabels(l?.labels ?? [], l?.marks ?? []);
  }

  static saveLabels(fs: RecordingFileSystem, l: SessionLabels, dir: string): void {
    fs.write(joinPath(dir, 'labels.json'), textBytes(JSON.stringify(l, null, 2)));
  }

  static size(fs: RecordingFileSystem, dir: string): number {
    return fs.list(dir).reduce((s, f) => s + fs.size(joinPath(dir, f)), 0);
  }
}
