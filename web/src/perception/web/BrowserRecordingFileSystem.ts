// The feature recorder's storage in the browser (Swift: FeatureRecordingStore on FileManager under Application
// Support). The recorder's `RecordingFileSystem` seam is synchronous; browser storage is not. So `PersistentFileSystem`
// keeps the directory listing, every file's size and the small files (header, labels, events, policy) in memory,
// serves reads from there, and writes through to an async backend in order: the origin private file system (OPFS)
// where `createWritable` exists, else IndexedDB. Chunk files (`.yfr`, the bulk) are never held in memory except while
// a viewer or an export has preloaded their session. Appends are coalesced and flushed every 0.5 s.
import { FeatureRecordingStore, joinPath, normalizePath, type RecordingFileSystem } from '../FeatureRecordingStore';

/** Async file operations ("/"-joined paths, no leading slash needed). */
export interface RecordingBackend {
  readonly kind: 'opfs' | 'indexedDB' | 'memory';
  /** Every file with its size. */
  list(): Promise<{ path: string; size: number }[]>;
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  append(path: string, data: Uint8Array): Promise<void>;
  /** A file or a directory tree. */
  remove(path: string): Promise<void>;
}

const lazy = (p: string): boolean => p.endsWith('.yfr');
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + '/');

type Op = { kind: 'write'; path: string; data: Uint8Array } | { kind: 'append'; path: string; parts: Uint8Array[] }
  | { kind: 'remove'; path: string };

export class PersistentFileSystem implements RecordingFileSystem {
  private readonly sizes = new Map<string, number>();
  private readonly cache = new Map<string, Uint8Array>();
  private ops: Op[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  /** The last backend failure (Status); writes after it are still attempted. */
  lastError: string | null = null;

  private constructor(readonly backend: RecordingBackend, readonly flushDelayMs: number) {}

  /** Lists the backend and loads its small files. */
  static async open(backend: RecordingBackend, flushDelayMs = 500): Promise<PersistentFileSystem> {
    const fs = new PersistentFileSystem(backend, flushDelayMs);
    for (const { path, size } of await backend.list()) {
      const p = normalizePath(path);
      fs.sizes.set(p, size);
      if (!lazy(p)) fs.cache.set(p, (await backend.read(p)) ?? new Uint8Array(0));
    }
    return fs;
  }

  read(path: string): Uint8Array | null { return this.cache.get(normalizePath(path)) ?? null; }

  write(path: string, data: Uint8Array): void {
    const p = normalizePath(path);
    this.sizes.set(p, data.length);
    if (!lazy(p) || this.cache.has(p)) this.cache.set(p, data.slice());
    this.enqueue({ kind: 'write', path: p, data: data.slice() });
  }

  append(path: string, data: Uint8Array): void {
    const p = normalizePath(path);
    this.sizes.set(p, (this.sizes.get(p) ?? 0) + data.length);
    const old = this.cache.get(p);
    if (old) this.cache.set(p, concat([old, data]));
    else if (!lazy(p)) this.cache.set(p, data.slice());
    const last = this.ops[this.ops.length - 1];
    if (last?.kind === 'append' && last.path === p) last.parts.push(data.slice());
    else this.enqueue({ kind: 'append', path: p, parts: [data.slice()] });
    this.schedule();
  }

  list(dir: string): string[] {
    const d = normalizePath(dir) + '/';
    const names = new Set<string>();
    for (const k of this.sizes.keys()) if (k.startsWith(d)) names.add(k.slice(d.length).split('/')[0]);
    return [...names];
  }

  isDirectory(path: string): boolean {
    const d = normalizePath(path) + '/';
    for (const k of this.sizes.keys()) if (k.startsWith(d)) return true;
    return false;
  }

  remove(path: string): void {
    const p = normalizePath(path);
    for (const k of [...this.sizes.keys()]) if (under(k, p)) { this.sizes.delete(k); this.cache.delete(k); }
    this.enqueue({ kind: 'remove', path: p });
  }

  size(path: string): number { return this.sizes.get(normalizePath(path)) ?? 0; }

  /** Loads a directory's chunk files so the synchronous reads (FeatureRecordingSession.load, export) see them. */
  async preload(dir: string): Promise<void> {
    await this.flushed();
    const d = normalizePath(dir);
    for (const k of this.sizes.keys()) {
      if (under(k, d) && !this.cache.has(k)) this.cache.set(k, (await this.backend.read(k)) ?? new Uint8Array(0));
    }
  }

  /** Drops a preloaded directory's chunk files from memory again. */
  evict(dir: string): void {
    const d = normalizePath(dir);
    for (const k of [...this.cache.keys()]) if (lazy(k) && under(k, d)) this.cache.delete(k);
  }

  /** Resolves once everything written so far is in the backend. */
  async flushed(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.ops.length > 0 || this.running) {
      if (this.running) await this.running; else await this.run();
    }
  }

  private enqueue(op: Op): void {
    this.ops.push(op);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined || this.running) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, this.flushDelayMs);
  }

  private run(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.ops.length > 0) {
        const op = this.ops.shift()!;
        try {
          if (op.kind === 'write') await this.backend.write(op.path, op.data);
          else if (op.kind === 'append') await this.backend.append(op.path, concat(op.parts));
          else await this.backend.remove(op.path);
        } catch (e) {
          this.lastError = `${op.kind} ${op.path}: ${e instanceof Error ? e.message : String(e)}`;
          console.warn(`perception recorder: ${this.lastError}`);
        }
      }
    })().finally(() => { this.running = null; if (this.ops.length > 0) this.schedule(); });
    return this.running;
  }
}

// MARK: OPFS

/** The subset of the File System Access types used (lib.dom's async iterators vary by TS version). */
interface DirHandle {
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, DirHandle | FileHandleLike]>;
}
interface FileHandleLike {
  readonly kind: 'file' | 'directory';
  getFile(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(o?: { keepExistingData?: boolean }): Promise<{ seek(n: number): Promise<void>; write(d: Uint8Array): Promise<void>; close(): Promise<void> }>;
}

const notFound = (e: unknown): boolean => e instanceof Error && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');

export function opfsBackend(root: DirHandle): RecordingBackend {
  const parts = (p: string) => normalizePath(p).split('/').filter(Boolean);
  const dirOf = async (segs: string[], create: boolean): Promise<DirHandle> => {
    let d = root;
    for (const s of segs) d = await d.getDirectoryHandle(s, { create });
    return d;
  };
  const file = async (p: string, create: boolean): Promise<FileHandleLike> => {
    const s = parts(p);
    return (await dirOf(s.slice(0, -1), create)).getFileHandle(s[s.length - 1], { create });
  };
  return {
    kind: 'opfs',
    async list() {
      const out: { path: string; size: number }[] = [];
      const walk = async (d: DirHandle, prefix: string): Promise<void> => {
        for await (const [name, h] of d.entries()) {
          const p = prefix ? `${prefix}/${name}` : name;
          if ((h as FileHandleLike).kind === 'file') out.push({ path: p, size: (await (h as FileHandleLike).getFile()).size });
          else await walk(h as DirHandle, p);
        }
      };
      await walk(root, '');
      return out;
    },
    async read(p) {
      try { return new Uint8Array(await (await (await file(p, false)).getFile()).arrayBuffer()); } catch (e) { if (notFound(e)) return null; throw e; }
    },
    async write(p, data) {
      const w = await (await file(p, true)).createWritable();
      await w.write(data);
      await w.close();
    },
    async append(p, data) {
      const h = await file(p, true);
      const size = (await h.getFile()).size;
      const w = await h.createWritable({ keepExistingData: true });
      await w.seek(size);
      await w.write(data);
      await w.close();
    },
    async remove(p) {
      const s = parts(p);
      try { await (await dirOf(s.slice(0, -1), false)).removeEntry(s[s.length - 1], { recursive: true }); } catch (e) { if (!notFound(e)) throw e; }
    },
  };
}

// MARK: IndexedDB (Safari before writable OPFS streams)

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const done = (t: IDBTransaction): Promise<void> => new Promise((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error); t.onabort = () => fail(t.error); });

/** Files as appended pieces (`pieces`: "path\0seq" → bytes) with a `meta` row per file (size, piece count), so an
 *  append never rewrites the file. */
export async function indexedDBBackend(name = 'yanni-perception-recordings', factory: IDBFactory = indexedDB): Promise<RecordingBackend> {
  const open = factory.open(name, 1);
  open.onupgradeneeded = () => { open.result.createObjectStore('meta'); open.result.createObjectStore('pieces'); };
  const db = await req(open);
  const range = (p: string) => IDBKeyRange.bound(`${p}\u0000`, `${p}\u0000￿`);
  const key = (p: string, n: number) => `${p}\u0000${String(n).padStart(8, '0')}`;
  type Meta = { size: number; n: number };
  return {
    kind: 'indexedDB',
    async list() {
      const t = db.transaction('meta');
      const [keys, vals] = await Promise.all([req(t.objectStore('meta').getAllKeys()), req(t.objectStore('meta').getAll())]);
      return keys.map((k, i) => ({ path: String(k), size: (vals[i] as Meta).size }));
    },
    async read(p) {
      const t = db.transaction(['meta', 'pieces']);
      if (await req(t.objectStore('meta').get(p)) === undefined) return null;
      return concat((await req(t.objectStore('pieces').getAll(range(p)))) as Uint8Array[]);
    },
    async write(p, data) {
      const t = db.transaction(['meta', 'pieces'], 'readwrite');
      t.objectStore('pieces').delete(range(p));
      t.objectStore('pieces').put(data, key(p, 0));
      t.objectStore('meta').put({ size: data.length, n: 1 } satisfies Meta, p);
      await done(t);
    },
    async append(p, data) {
      const t = db.transaction(['meta', 'pieces'], 'readwrite');
      const m = ((await req(t.objectStore('meta').get(p))) as Meta | undefined) ?? { size: 0, n: 0 };
      t.objectStore('pieces').put(data, key(p, m.n));
      t.objectStore('meta').put({ size: m.size + data.length, n: m.n + 1 } satisfies Meta, p);
      await done(t);
    },
    async remove(p) {
      const t = db.transaction(['meta', 'pieces'], 'readwrite');
      for (const k of await req(t.objectStore('meta').getAllKeys())) {
        const s = String(k);
        if (!under(s, p)) continue;
        t.objectStore('meta').delete(s);
        t.objectStore('pieces').delete(range(s));
      }
      await done(t);
    },
  };
}

/** OPFS when it can write from the main thread, else IndexedDB; null when neither exists (an in-memory store then). */
export async function browserRecordingBackend(): Promise<RecordingBackend | null> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (storage?.getDirectory && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype) {
    try { return opfsBackend((await storage.getDirectory()) as unknown as DirHandle); } catch { /* blocked: fall through */ }
  }
  if (typeof indexedDB !== 'undefined') {
    try { return await indexedDBBackend(); } catch { /* private mode: none */ }
  }
  return null;
}

/** The recorder's store on the browser's persistent storage (asks the browser not to evict it). */
export async function openBrowserRecordingStore(): Promise<{ store: FeatureRecordingStore; fs: PersistentFileSystem } | null> {
  const backend = await browserRecordingBackend();
  if (!backend) return null;
  void navigator.storage?.persist?.().catch(() => false);
  const fs = await PersistentFileSystem.open(backend);
  return { store: new FeatureRecordingStore(fs, FeatureRecordingStore.defaultRoot), fs };
}

// MARK: Export

/** One session folder as a POSIX tar (`<id>/header.json`, `chunk-0000.yfr`, …), what the Mac evaluator reads once
 *  extracted. Every file must be readable (preload a PersistentFileSystem first). */
export function tarDirectory(fs: RecordingFileSystem, dir: string, name: string): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const f of fs.list(dir).sort()) {
    const data = fs.read(joinPath(dir, f)) ?? new Uint8Array(0);
    const h = new Uint8Array(512);
    const put = (s: string, at: number) => h.set(enc.encode(s), at);
    const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
    put(`${name}/${f}`.slice(0, 99), 0);
    put(oct(0o644, 8), 100); put(oct(0, 8), 108); put(oct(0, 8), 116);
    put(oct(data.length, 12), 124); put(oct(mtime, 12), 136);
    put('        ', 148); put('0', 156); put('ustar\u000000', 257);
    put(oct(h.reduce((s, b) => s + b, 0), 7) + ' ', 148);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return concat(blocks);
}

/** The files of a tar made by `tarDirectory` (or any ustar of plain files) into `fs`; returns the top folders. */
export function untarInto(fs: RecordingFileSystem, tar: Uint8Array, root = 'import'): string[] {
  const dec = new TextDecoder();
  const str = (a: number, n: number) => dec.decode(tar.subarray(a, a + n)).replace(/\0.*$/s, '');
  const tops = new Set<string>();
  for (let o = 0; o + 512 <= tar.length;) {
    const name = str(o, 100);
    if (name === '') break;
    const size = parseInt(str(o + 124, 12).trim(), 8) || 0;
    const prefix = str(o + 257, 6).startsWith('ustar') ? str(o + 345, 155) : '';
    const path = prefix ? `${prefix}/${name}` : name;
    const type = str(o + 156, 1);
    if ((type === '0' || type === '') && !path.split('/').includes('..')) {
      fs.write(joinPath(root, path), tar.slice(o + 512, o + 512 + size));
      tops.add(path.split('/')[0]);
    }
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return [...tops];
}
