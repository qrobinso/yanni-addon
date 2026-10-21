// The recorder's browser storage: a session written through the real writer onto a (fake) OPFS survives a reopen
// and reads back frame for frame; chunk files stay out of memory; export / import as tar round-trips.
import { describe, expect, test } from 'vitest';
import {
  FeatureRecordingSession, FeatureRecordingStore, FeatureRecordingWriter, MemoryFileSystem, RecordedEvent, RecordingLimits,
  RecordingPolicy, StageTimings, SyntheticScenes, makePerceptionSnapshot, makeSessionLabels, makeSessionLabel,
} from '../../../src/perception';
import {
  PersistentFileSystem, opfsBackend, tarDirectory, untarInto,
} from '../../../src/perception/web/BrowserRecordingFileSystem';
import { T } from '../TestSupport';
import { FakeDir } from './FakeOPFS';

async function writeSession(store: FeatureRecordingStore, id: string): Promise<FeatureRecordingSession> {
  const s = FeatureRecordingSession.synthetic(SyntheticScenes.simulatorDemo.recording(), 'scripted');
  const w = new FeatureRecordingWriter(store.fs, store.directory(id), T.header(id, ['P1', 'P2', 'P3'], s.frames[0].detections.time),
    RecordingLimits.maxTotalBytes);
  const st = new StageTimings();
  st.rects = 2.5;
  for (const f of s.frames) {
    w.offer(f.detections, makePerceptionSnapshot({ time: f.detections.time, people: f.people, primaryID: f.primaryID, engagedID: f.engagedID }), st, 2);
    w.note(RecordedEvent.make(f.detections.time, 'tick'));
    w.flush();
  }
  w.finish('test');
  return s;
}

describe('BrowserRecordingStore', () => {
  test('a session on OPFS survives a reopen and reads back frame for frame', async () => {
    const root = new FakeDir();
    const fs = await PersistentFileSystem.open(opfsBackend(root), 0);
    const store = new FeatureRecordingStore(fs, FeatureRecordingStore.defaultRoot);
    const p = new RecordingPolicy();
    p.allowed = true;
    p.participants = [T.participant('P1')];
    store.savePolicy(p);
    const original = await writeSession(store, 's1');
    store.saveLabels(makeSessionLabels([makeSessionLabel(1001, 1002, 'wave')]), 's1');
    await fs.flushed();

    // A fresh page: everything comes back from the backend.
    const fs2 = await PersistentFileSystem.open(opfsBackend(root), 0);
    const store2 = new FeatureRecordingStore(fs2, FeatureRecordingStore.defaultRoot);
    expect(store2.loadPolicy().allowed).toBe(true);
    expect(store2.loadPolicy().participants.map((q) => q.pseudonym)).toEqual(['P1']);
    const [summary] = store2.sessions();
    expect(summary.id).toBe('s1');
    expect(summary.bytes).toBe(store.totalBytes());
    expect(summary.header?.framesWritten).toBe(original.frames.length);
    // Chunks are lazy: not readable until preloaded.
    const dir = store2.directory('s1');
    expect(fs2.read(`${dir}/chunk-0000.yfr`)).toBeNull();
    await fs2.preload(dir);
    const back = FeatureRecordingSession.load(fs2, dir);
    fs2.evict(dir);
    expect(fs2.read(`${dir}/chunk-0000.yfr`)).toBeNull();
    expect(back.frames).toHaveLength(original.frames.length);
    expect(back.events).toHaveLength(original.frames.length);
    expect(back.labels.labels.map((l) => l.label)).toEqual(['wave']);
    back.frames.forEach((b, i) => {
      const a = original.frames[i];
      expect(b.detections.time).toBe(a.detections.time);
      expect(b.detections.faces.length).toBe(a.detections.faces.length);
      expect(b.people.map((q) => q.id)).toEqual(a.people.map((q) => q.id));
    });
    // The in-memory reference gives the same frames.
    const [ref] = T.roundTrip(original, ['P1', 'P2', 'P3']);
    expect(back.frames.map((f) => f.detections)).toEqual(ref.frames.map((f) => f.detections));
  });

  test('appends are coalesced: one backend write per flush, not per frame', async () => {
    const root = new FakeDir();
    const fs = await PersistentFileSystem.open(opfsBackend(root), 10_000);
    for (let i = 0; i < 100; i++) fs.append('a/chunk-0000.yfr', new Uint8Array([i]));
    expect(fs.size('a/chunk-0000.yfr')).toBe(100);
    await fs.flushed();
    const f = await (await root.getDirectoryHandle('a')).getFileHandle('chunk-0000.yfr');
    expect(f.writes).toBe(1);
    expect(Array.from(f.data.slice(0, 3))).toEqual([0, 1, 2]);
  });

  test('delete and delete-all reach the backend', async () => {
    const root = new FakeDir();
    const fs = await PersistentFileSystem.open(opfsBackend(root), 0);
    const store = new FeatureRecordingStore(fs, FeatureRecordingStore.defaultRoot);
    await writeSession(store, 'a');
    await writeSession(store, 'b');
    store.delete('a');
    await fs.flushed();
    let again = new FeatureRecordingStore(await PersistentFileSystem.open(opfsBackend(root), 0), FeatureRecordingStore.defaultRoot);
    expect(again.sessions().map((s) => s.id)).toEqual(['b']);
    store.deleteAll();
    await fs.flushed();
    again = new FeatureRecordingStore(await PersistentFileSystem.open(opfsBackend(root), 0), FeatureRecordingStore.defaultRoot);
    expect(again.sessions()).toEqual([]);
  });

  test('export as tar and import it back', async () => {
    const mem = new MemoryFileSystem();
    const store = new FeatureRecordingStore(mem, 'Perception');
    const original = await writeSession(store, 's9');
    const tar = tarDirectory(mem, store.directory('s9'), 's9');
    expect(tar.length % 512).toBe(0);
    const into = new MemoryFileSystem();
    expect(untarInto(into, tar)).toEqual(['s9']);
    const back = FeatureRecordingSession.load(into, 'import/s9');
    expect(back.frames).toHaveLength(original.frames.length);
    expect(back.header.id).toBe('s9');
  });
});
