// Port of ConversationAgent/ClipRenderer.swift. Renders the greeting and "I can't think right now" clips through the
// speech route's TTS (design §10), as 16-bit mono WAV, keyed by the voice's `voiceId`. Re-renders when the voice
// changes, when a clip is missing, or when forced. Never while a conversation is active (a render would delay a reply).
// A failed render keeps the previous set only if its `voiceId` still matches.
// port-note: the HA clip voice only (no Wyoming); files go through an injected `ClipStorage` (IndexedDB, Cache
// Storage or memory in the app) instead of Application Support. `ClipManifest` lives here (ConversationTrust isn't
// ported).
import type { HAPipelineInfo } from './homeassistant/HACommands';
import type { HATextToSpeech } from './homeassistant/HASpeech';

export type ClipKind = 'greeting' | 'cantThink';

/** What is stored next to the rendered clips. */
export interface ClipManifest {
  voiceId: string;
  clips: { id: string; kind: ClipKind; text: string; /** SHA-256 of the text (a changed line re-renders). */ textHash: string; file: string }[];
}

/** Where clips live. */
export interface ClipStorage {
  readManifest(): Promise<ClipManifest | null>;
  writeManifest(m: ClipManifest): Promise<void>;
  write(file: string, data: Uint8Array): Promise<void>;
  exists(file: string): Promise<boolean>;
  /** Deletes every rendered clip and the manifest. */
  clear(): Promise<void>;
}

/** In memory (tests, or a page that renders on every load). */
export class MemoryClipStorage implements ClipStorage {
  files = new Map<string, Uint8Array>();
  manifest: ClipManifest | null = null;
  async readManifest() { return this.manifest ? structuredClone(this.manifest) : null; }
  async writeManifest(m: ClipManifest) { this.manifest = structuredClone(m); }
  async write(file: string, data: Uint8Array) { this.files.set(file, data); }
  async exists(file: string) { return this.files.has(file); }
  async clear() { this.files.clear(); this.manifest = null; }
}

/** A voice the greeting clips are rendered in: its cache key and one line as 16-bit mono WAV. */
export interface ClipVoice {
  /** `ha:<pipeline>:<engine>:<voice>`. */
  readonly voiceId: string;
  wav(text: string): Promise<Uint8Array>;
}

/** Clips through Home Assistant's pipeline: a TTS run per line, decoded and stored as 16-bit mono WAV. */
export class HAClipVoice implements ClipVoice {
  static readonly rate = 22050;
  readonly voiceId: string;

  /** `pipeline` is the resolved pipeline (HA's preferred one resolved to its id), so a change re-renders. */
  constructor(readonly tts: HATextToSpeech, pipeline: HAPipelineInfo) { this.voiceId = HAClipVoice.voiceId(pipeline); }

  static voiceId(p: HAPipelineInfo): string { return `ha:${p.id}:${p.ttsEngine ?? ''}:${p.ttsVoice ?? ''}`; }

  async wav(text: string): Promise<Uint8Array> {
    const floats = await this.tts.synthesize(text, HAClipVoice.rate);
    return WAV.encode(WAV.pcm16(floats), HAClipVoice.rate);
  }
}

export type ClipRenderOutcome =
  | { kind: 'upToDate' } | { kind: 'rendered'; count: number } | { kind: 'deferred' } | { kind: 'failed'; why: string };

export class ClipRenderer {
  static readonly lines: readonly { id: string; kind: ClipKind; text: string }[] = [
    { id: 'hi', kind: 'greeting', text: 'hi!' }, { id: 'hey-there', kind: 'greeting', text: 'hey there!' },
    { id: 'hello', kind: 'greeting', text: 'hello!' }, { id: 'cant-think', kind: 'cantThink', text: "I can't think right now." },
  ];

  renders = 0;

  constructor(readonly storage: ClipStorage) {}

  manifest(): Promise<ClipManifest | null> { return this.storage.readManifest(); }

  /** Brings the clips in line with `voice`. `conversationActive` defers the render (call again at noticing / idle). */
  async renderIfNeeded(voice: ClipVoice, conversationActive: boolean, force = false): Promise<ClipRenderOutcome> {
    const voiceId = voice.voiceId;
    const current = await this.manifest();
    let complete = false;
    if (current && current.voiceId === voiceId) {
      complete = true;
      for (const l of ClipRenderer.lines) {
        const hash = await ClipRenderer.hash(l.text);
        const c = current.clips.find((x) => x.id === l.id && x.textHash === hash);
        if (!c || !(await this.storage.exists(c.file))) { complete = false; break; }
      }
    }
    if (complete && !force) return { kind: 'upToDate' };
    if (conversationActive) return { kind: 'deferred' };
    const clips: ClipManifest['clips'] = [];
    for (const l of ClipRenderer.lines) {
      try {
        const wav = await voice.wav(l.text);
        const file = `${l.id}.wav`;
        await this.storage.write(file, wav);
        clips.push({ id: l.id, kind: l.kind, text: l.text, textHash: await ClipRenderer.hash(l.text), file });
      } catch (error) {
        if (current?.voiceId !== voiceId) await this.storage.clear(); // a stale voice's set is not kept
        return { kind: 'failed', why: error instanceof Error ? error.message : typeof error };
      }
    }
    this.renders += 1;
    await this.storage.writeManifest({ voiceId, clips });
    return { kind: 'rendered', count: clips.length };
  }

  /** One line rendered to a WAV (the Settings TTS Test plays "Hi, I'm Yanni."). */
  renderSample(text: string, voice: ClipVoice): Promise<Uint8Array> { return voice.wav(text); }

  static async hash(s: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

export const WAV = {
  encode(pcm: Uint8Array, rate: number): Uint8Array {
    const out = new Uint8Array(44 + pcm.byteLength);
    const v = new DataView(out.buffer);
    const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); tag(8, 'WAVE');
    tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    tag(36, 'data'); v.setUint32(40, pcm.byteLength, true);
    out.set(pcm, 44);
    return out;
  },

  /** Float −1…1 → 16-bit little-endian PCM. */
  pcm16(floats: Float32Array): Uint8Array {
    const out = new Uint8Array(floats.length * 2);
    const v = new DataView(out.buffer);
    for (let i = 0; i < floats.length; i++) v.setInt16(i * 2, Math.trunc(Math.max(-1, Math.min(1, floats[i])) * 32767), true);
    return out;
  },
};
