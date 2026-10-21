// A minimal origin private file system for node: directory and file handles with writable streams, the subset
// `opfsBackend` uses. Files are kept in memory.
const err = (name: string) => Object.assign(new Error(name), { name });

export class FakeFile {
  readonly kind = 'file' as const;
  data = new Uint8Array(0);
  writes = 0;
  async getFile() {
    const d = this.data;
    return { size: d.length, arrayBuffer: async () => d.slice().buffer };
  }
  async createWritable(o?: { keepExistingData?: boolean }) {
    let buf = o?.keepExistingData ? this.data.slice() : new Uint8Array(0);
    let pos = 0;
    return {
      seek: async (n: number) => { pos = n; },
      write: async (d: Uint8Array) => {
        if (pos + d.length > buf.length) { const n = new Uint8Array(pos + d.length); n.set(buf); buf = n; }
        buf.set(d, pos);
        pos += d.length;
      },
      close: async () => { this.data = buf; this.writes += 1; },
    };
  }
}

export class FakeDir {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeDir | FakeFile>();
  async getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FakeDir> {
    let c = this.children.get(name);
    if (!c) { if (!o?.create) throw err('NotFoundError'); c = new FakeDir(); this.children.set(name, c); }
    if (c.kind !== 'directory') throw err('TypeMismatchError');
    return c;
  }
  async getFileHandle(name: string, o?: { create?: boolean }): Promise<FakeFile> {
    let c = this.children.get(name);
    if (!c) { if (!o?.create) throw err('NotFoundError'); c = new FakeFile(); this.children.set(name, c); }
    if (c.kind !== 'file') throw err('TypeMismatchError');
    return c;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw err('NotFoundError');
  }
  async *entries(): AsyncIterable<[string, FakeDir | FakeFile]> { yield* this.children.entries(); }
}
