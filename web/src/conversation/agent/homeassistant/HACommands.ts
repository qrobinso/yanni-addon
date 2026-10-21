// Port of ConversationAgent/HomeAssistant/HACommands.swift. Typed wrappers over the commands Yanni sends (each one is
// on the add-on relay's whitelist).
// port-note: Swift's `extension HAClient` becomes free functions taking the client.
import { arrayValue, at, stringValue, type JSONObject, type JSONValue } from '../JSONValue';
import { boolValue, jsonOrNull } from '../JSONValue+Agent';
import { HAError } from './HAChannel';
import type { HAClient, HASubscription } from './HAClient';

export interface HAAgentInfo { id: string; name: string; supportedLanguages: string[] }

export interface HAPipelineInfo {
  id: string;
  name: string;
  conversationEngine: string | null;
  conversationLanguage: string | null;
  preferLocalIntents: boolean;
  /** The speech stages' engines (`stt.faster_whisper`, `tts.piper`, …); null = the pipeline has none. */
  sttEngine: string | null;
  ttsEngine: string | null;
  ttsVoice: string | null;
}

export interface HAConfigEntryInfo { entryID: string; title: string; state: string }

/** A whole agent reply (`conversation/process`, or a pipeline's `intent-end`). */
export interface HAConversationResult {
  speech: string;
  conversationID: string | null;
  continueConversation: boolean;
  /** `action_done`, `query_answer` or `error`. */
  responseType: string | null;
}

/** From an `intent_output` / `conversation/process` result object. */
export function haConversationResult(v: JSONValue): HAConversationResult {
  return {
    speech: stringValue(at(v, 'response', 'speech', 'plain', 'speech')) ?? '',
    responseType: stringValue(at(v, 'response', 'response_type')),
    conversationID: stringValue(at(v, 'conversation_id')),
    continueConversation: boolValue(at(v, 'continue_conversation')) ?? false,
  };
}

/** `jev.ask` (`call_service`, `return_response: true`) → the service response (`answers`, `latency_ms`, …). */
export async function jevAsk(ha: HAClient, state: JSONValue, questions: JSONValue, configEntry: string | null,
  signal?: AbortSignal): Promise<JSONValue> {
  const data: JSONObject = { state, questions };
  if (configEntry) data.config_entry = configEntry;
  const r = await ha.call('call_service', { domain: 'jev', service: 'ask', return_response: true, service_data: data }, signal);
  return at(r, 'response') ?? null;
}

/** `ai_task.generate_data` → the generated text (`data`, a string without `structure`). */
export async function aiTaskGenerate(ha: HAClient, entityID: string, taskName: string, instructions: string,
  signal?: AbortSignal): Promise<string> {
  const r = await ha.call('call_service', {
    domain: 'ai_task', service: 'generate_data', return_response: true,
    service_data: { task_name: taskName, entity_id: entityID, instructions },
  }, signal);
  const text = stringValue(at(r, 'response', 'data'));
  if (text === null) throw HAError.protocolError('ai_task data');
  return text;
}

/** `conversation/process` (the fallback path; the whole reply at once). */
export async function conversationProcess(ha: HAClient, text: string, conversationID: string | null, agentID: string | null,
  language: string | null, signal?: AbortSignal): Promise<HAConversationResult> {
  const p: JSONObject = { text, conversation_id: jsonOrNull(conversationID) };
  if (agentID !== null) p.agent_id = agentID;
  if (language !== null) p.language = language;
  return haConversationResult(await ha.call('conversation/process', p, signal));
}

/** `assist_pipeline/run`, intent stage only, streaming `intent-progress` deltas. */
export function runIntentPipeline(ha: HAClient, text: string, pipeline: string | null, conversationID: string | null,
  timeout: number, signal?: AbortSignal): Promise<HASubscription> {
  const p: JSONObject = { start_stage: 'intent', end_stage: 'intent', input: { text },
    conversation_id: jsonOrNull(conversationID), timeout };
  if (pipeline !== null) p.pipeline = pipeline;
  return ha.subscribe('assist_pipeline/run', p, signal);
}

/** `assist_pipeline/run`, stt stage only (design §6.8): 16 kHz audio follows as binary frames; HA's VAD is off
 *  (`no_vad`), so only Yanni's turn end finishes the stream. `pipeline` null = HA's preferred pipeline. */
export function runSpeechToText(ha: HAClient, pipeline: string | null, timeout: number, signal?: AbortSignal): Promise<HASubscription> {
  const p: JSONObject = { start_stage: 'stt', end_stage: 'stt', input: { sample_rate: 16000, no_vad: true }, timeout };
  if (pipeline !== null) p.pipeline = pipeline;
  return ha.subscribe('assist_pipeline/run', p, signal);
}

/** `assist_pipeline/run`, tts stage only: `tts-end` carries the audio's URL (`/api/tts_proxy/…`). */
export function runTextToSpeech(ha: HAClient, text: string, pipeline: string | null, timeout: number,
  signal?: AbortSignal): Promise<HASubscription> {
  const p: JSONObject = { start_stage: 'tts', end_stage: 'tts', input: { text }, timeout };
  if (pipeline !== null) p.pipeline = pipeline;
  return ha.subscribe('assist_pipeline/run', p, signal);
}

export async function conversationAgents(ha: HAClient, language: string | null = null): Promise<HAAgentInfo[]> {
  const r = await ha.call('conversation/agent/list', language !== null ? { language } : {});
  const out: HAAgentInfo[] = [];
  for (const a of arrayValue(at(r, 'agents')) ?? []) {
    const id = stringValue(at(a, 'id'));
    if (id === null) continue;
    const s = stringValue(at(a, 'supported_languages'));
    const langs = s !== null ? [s] // "*"
      : (arrayValue(at(a, 'supported_languages')) ?? []).map(stringValue).filter((x): x is string => x !== null);
    out.push({ id, name: stringValue(at(a, 'name')) ?? id, supportedLanguages: langs });
  }
  return out;
}

export async function pipelines(ha: HAClient, signal?: AbortSignal): Promise<{ pipelines: HAPipelineInfo[]; preferred: string | null }> {
  const r = await ha.call('assist_pipeline/pipeline/list', {}, signal);
  const list: HAPipelineInfo[] = [];
  for (const p of arrayValue(at(r, 'pipelines')) ?? []) {
    const id = stringValue(at(p, 'id'));
    if (id === null) continue;
    list.push({
      id, name: stringValue(at(p, 'name')) ?? id,
      conversationEngine: stringValue(at(p, 'conversation_engine')),
      conversationLanguage: stringValue(at(p, 'conversation_language')),
      preferLocalIntents: boolValue(at(p, 'prefer_local_intents')) ?? false,
      sttEngine: stringValue(at(p, 'stt_engine')), ttsEngine: stringValue(at(p, 'tts_engine')),
      ttsVoice: stringValue(at(p, 'tts_voice')),
    });
  }
  return { pipelines: list, preferred: stringValue(at(r, 'preferred_pipeline')) };
}

export async function configEntries(ha: HAClient, domain: string): Promise<HAConfigEntryInfo[]> {
  const r = await ha.call('config_entries/get', { domain });
  const out: HAConfigEntryInfo[] = [];
  for (const e of arrayValue(r) ?? []) {
    const id = stringValue(at(e, 'entry_id'));
    if (id === null) continue;
    out.push({ entryID: id, title: stringValue(at(e, 'title')) ?? id, state: stringValue(at(e, 'state')) ?? '' });
  }
  return out;
}

/** HA's version string → (year, month) for feature gates ("2025.3.1" → (2025, 3)). */
export function haVersionAtLeast(version: string, year: number, month: number): boolean {
  const parts = version.split('.').filter((s) => s !== '').map((s) => /^\d+/.exec(s)?.[0]).filter((s): s is string => s !== undefined)
    .map(Number);
  if (parts.length < 2) return true; // unknown or dev builds: assume current
  return parts[0] > year || (parts[0] === year && parts[1] >= month);
}
