// Port of ConversationTrust/ClipStore.swift plus the greeting-clip half of yanni/Conversation/VoiceServicesModel.swift:
// the greeting and "I can't think right now" clips rendered by `ClipRenderer` through Home Assistant's TTS, kept in
// Cache Storage (memory where it's missing), as the controller's `GreetingClips` (never the same greeting twice in a
// row). A render follows the session's speech voice (`servicesChanged`) and waits until no conversation is going on.
import { ClipRenderer, HAClipVoice, MemoryClipStorage, type ClipManifest, type ClipStorage } from '../../conversation/agent/ClipRenderer';
import type { HAChannel } from '../../conversation/agent/homeassistant/HAChannel';
import { HAClient } from '../../conversation/agent/homeassistant/HAClient';
import { pipelines } from '../../conversation/agent/homeassistant/HACommands';
import { HATextToSpeech, type HAMediaFetching, type MediaDecoder } from '../../conversation/agent/homeassistant/HASpeech';
import type { CachedClip, GreetingClips } from '../../conversation/core/Ports';
import type { VoiceServicesEndpoint } from '../../conversation/core/VoiceServicesEndpoint';
import type { ServicesInfo } from '../../conversation/events/AgentEvents';
import { makeHAEndpoint } from '../../conversation/core/VoiceServicesEndpoint';

type ReadableClipStorage = ClipStorage & { read(file: string): Promise<Blob | null> };

class MemoryReadableClipStorage extends MemoryClipStorage {
  async read(file: string): Promise<Blob | null> {
    const d = this.files.get(file);
    return d ? new Blob([d as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }) : null;
  }
}

/** Clips in Cache Storage under `yanni-clips` (survives reloads; the origin's private storage). */
class CacheClipStorage implements ReadableClipStorage {
  private static readonly name = 'yanni-clips';
  private static url(file: string): string { return new URL(`/__yanni-clips/${file}`, location.origin).href; }
  private cache(): Promise<Cache> { return caches.open(CacheClipStorage.name); }
  async readManifest(): Promise<ClipManifest | null> {
    const r = await (await this.cache()).match(CacheClipStorage.url('manifest.json'));
    try { return r ? await r.json() as ClipManifest : null; } catch { return null; }
  }
  async writeManifest(m: ClipManifest): Promise<void> {
    await (await this.cache()).put(CacheClipStorage.url('manifest.json'), new Response(JSON.stringify(m)));
  }
  async write(file: string, data: Uint8Array): Promise<void> {
    await (await this.cache()).put(CacheClipStorage.url(file), new Response(data as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'audio/wav' } }));
  }
  async exists(file: string): Promise<boolean> { return (await (await this.cache()).match(CacheClipStorage.url(file))) !== undefined; }
  async read(file: string): Promise<Blob | null> { return (await (await this.cache()).match(CacheClipStorage.url(file)))?.blob() ?? null; }
  async clear(): Promise<void> { await caches.delete(CacheClipStorage.name); }
}

export interface ClipStoreDeps {
  channel: HAChannel;
  fetcher: () => HAMediaFetching;
  decoder: MediaDecoder;
  endpoint: () => VoiceServicesEndpoint | null;
  conversationActive: () => boolean;
  /** A clip's object URL became playable (the audio engine decodes it ahead). */
  preload: (url: string) => void;
  forget: (url: string) => void;
  onLog: (line: string) => void;
}

export class ClipStore implements GreetingClips {
  private readonly storage: ReadableClipStorage;
  private readonly renderer: ClipRenderer;
  private manifest: ClipManifest | null = null;
  private urls = new Map<string, string>();
  private lastGreeting: string | null = null;
  private renderPending = false;
  private rendering = false;

  constructor(private readonly d: ClipStoreDeps) {
    this.storage = typeof caches !== 'undefined' ? new CacheClipStorage() : new MemoryReadableClipStorage();
    this.renderer = new ClipRenderer(this.storage);
    void this.reload();
  }

  get voiceId(): string | null { return this.manifest?.voiceId ?? null; }

  nextGreeting(): CachedClip | null {
    const g = (this.manifest?.clips ?? []).filter((c) => c.kind === 'greeting' && this.urls.has(c.file));
    if (g.length === 0) return null;
    const pool = g.length > 1 ? g.filter((c) => c.id !== this.lastGreeting) : g;
    // Not engine randomness: which greeting plays never touches the face's seeded RNG.
    const pick = pool[Math.floor(Math.random() * pool.length)];
    this.lastGreeting = pick.id;
    return { url: this.urls.get(pick.file)!, text: pick.text };
  }

  get cantThink(): CachedClip | null {
    const c = this.manifest?.clips.find((x) => x.kind === 'cantThink' && this.urls.has(x.file));
    return c ? { url: this.urls.get(c.file)!, text: c.text } : null;
  }

  /** A new session's services: in the Spoken voice the greeting clips follow the TTS voice (`voiceId`). */
  servicesChanged(info: ServicesInfo): void {
    if (info.replyVoice !== 'spoken' || this.d.endpoint()?.tts == null) return;
    if (info.voiceId !== null && info.voiceId === this.voiceId) return;
    this.renderPending = true;
    this.render();
  }

  /** The 4 Hz poll: a render that waited for the conversation to end runs now. */
  tick(): void {
    const ep = this.d.endpoint();
    if (!this.renderPending || this.rendering || this.d.conversationActive() || ep?.tts == null || ep.replyVoice !== 'spoken') return;
    this.render();
  }

  /** Reset: the clips go with the settings. */
  async clear(): Promise<void> {
    await this.storage.clear();
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.manifest = await this.storage.readManifest().catch(() => null);
    for (const u of this.urls.values()) { this.d.forget(u); URL.revokeObjectURL(u); }
    this.urls.clear();
    for (const c of this.manifest?.clips ?? []) {
      const blob = await this.storage.read(c.file).catch(() => null);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      this.urls.set(c.file, url);
      this.d.preload(url);
    }
  }

  private render(): void {
    if (this.rendering) return;
    this.rendering = true;
    const active = this.d.conversationActive();
    void (async () => {
      const ep = this.d.endpoint();
      const client = new HAClient(this.d.channel);
      try {
        if (!ep?.tts) throw new Error('no speech voice');
        await client.connect(makeHAEndpoint(), ep.tunables.requestTimeout, 3600, 60);
        const listed = await pipelines(client);
        const p = listed.pipelines.find((x) => x.id === (ep.tts!.pipelineID ?? listed.preferred));
        if (!p || p.ttsEngine === null) throw new Error('no speech voice');
        const tts = new HATextToSpeech(client, ep.tts.pipelineID, this.d.fetcher(), this.d.decoder, ep.tunables);
        const outcome = await this.renderer.renderIfNeeded(new HAClipVoice(tts, p), active);
        if (outcome.kind !== 'deferred') this.renderPending = false;
        if (outcome.kind === 'rendered') this.d.onLog(`greeting clips rendered (${outcome.count})`);
        if (outcome.kind === 'failed') this.d.onLog('greeting clips: render failed');
        if (outcome.kind === 'rendered' || outcome.kind === 'failed') await this.reload();
      } catch {
        this.renderPending = false;
        this.d.onLog('greeting clips: no speech voice to render with');
      } finally {
        client.close();
        this.rendering = false;
      }
    })();
  }
}
