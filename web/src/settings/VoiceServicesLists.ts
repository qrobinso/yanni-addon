// The Voice services pickers' data: VoiceServicesModel.loadLists and VoiceServicesSection's pipeline and picker rows
// (pipeline, agent, decision model, announcements). The lists come through the add-on relay; `get_states` arrives
// already trimmed by the relay (server/src/relay.ts `filterStates`). Empty setting = Swift's `nil` option.
import type { SettingKey, Settings } from '@yanni/server/settings';
import { arrayValue, at, stringValue } from '../conversation/agent/JSONValue';
import type { HAChannel } from '../conversation/agent/homeassistant/HAChannel';
import { HAClient } from '../conversation/agent/homeassistant/HAClient';
import { configEntries, conversationAgents, pipelines, type HAAgentInfo, type HAConfigEntryInfo, type HAPipelineInfo }
  from '../conversation/agent/homeassistant/HACommands';
import { makeHAEndpoint } from '../conversation/core/VoiceServicesEndpoint';

export interface VoiceServicesLists {
  agents: HAAgentInfo[];
  pipelines: HAPipelineInfo[];
  preferredPipelineID: string | null;
  /** null = unknown (the call failed): no Jev row at all. */
  jevEntries: HAConfigEntryInfo[] | null;
  aiTasks: { id: string; name: string }[];
}

/** loadLists: each list on its own, a failed one empty (Swift's `try?`). Throws only when the relay isn't open. */
export async function loadVoiceServicesLists(channel: HAChannel): Promise<VoiceServicesLists> {
  const client = new HAClient(channel);
  await client.connect(makeHAEndpoint(), 0, 3600, 60);
  try {
    const listed = await pipelines(client).catch(() => null);
    const states = await client.call('get_states').catch(() => null);
    return {
      agents: await conversationAgents(client).catch(() => []),
      pipelines: listed?.pipelines ?? [],
      preferredPipelineID: listed?.preferred ?? null,
      jevEntries: await configEntries(client, 'jev').catch(() => null),
      aiTasks: (arrayValue(states) ?? []).flatMap((st) => {
        const id = stringValue(at(st, 'entity_id'));
        return id?.startsWith('ai_task.') ? [{ id, name: stringValue(at(st, 'attributes', 'friendly_name')) ?? id }] : [];
      }),
    };
  } finally {
    client.close();
  }
}

export interface PickerOption { value: string; label: string }
export type VoiceServicesRow =
  | { kind: 'picker'; key: SettingKey; label: string; options: PickerOption[] }
  | { kind: 'fixed'; label: string; value: string }
  | { kind: 'note'; text: string; warn: boolean };

/** The pipeline the speech runs on: the picked one, or Home Assistant's preferred one. */
export function speechPipeline(lists: VoiceServicesLists, s: Settings): HAPipelineInfo | undefined {
  const id = s.pipeline_id || lists.preferredPipelineID;
  return lists.pipelines.find((p) => p.id === id);
}

/** "Home: speech-to-text stt.faster_whisper · speech voice tts.piper (en_US-lessac-medium)". */
export function engines(p: HAPipelineInfo): string {
  const tts = p.ttsEngine ? (p.ttsVoice ? `${p.ttsEngine} (${p.ttsVoice})` : p.ttsEngine) : 'none';
  return `${p.name}: speech-to-text ${p.sttEngine ?? 'none'} · speech voice ${tts}`;
}

/** VoiceServicesSection's pipelineRows + pickerRows for these lists and settings. */
export function voiceServicesRows(lists: VoiceServicesLists, s: Settings): VoiceServicesRow[] {
  const picker = (key: SettingKey, label: string, none: string, items: PickerOption[]): VoiceServicesRow => {
    const current = String(s[key]);
    // A saved id HA no longer lists stays visible (and selected) instead of silently showing the none option.
    const missing = current !== '' && !items.some((o) => o.value === current) ? [{ value: current, label: current }] : [];
    return { kind: 'picker', key, label, options: [{ value: '', label: none }, ...items, ...missing] };
  };
  const rows: VoiceServicesRow[] = [picker('pipeline_id', 'Pipeline', 'Home Assistant’s preferred',
    lists.pipelines.map((p) => ({ value: p.id, label: p.name + (p.preferLocalIntents ? ' · local commands first' : '') })))];
  const sp = speechPipeline(lists, s);
  if (sp) rows.push({ kind: 'note', text: engines(sp), warn: sp.sttEngine === null });
  if (!s.pipeline_id) {
    rows.push(picker('conversation_agent_id', 'Agent', 'The pipeline’s agent', lists.agents.map((a) => ({ value: a.id, label: a.name }))));
  } else if (sp?.conversationEngine) {
    const agent = sp.conversationEngine;
    rows.push({ kind: 'fixed', label: 'Agent', value: lists.agents.find((a) => a.id === agent)?.name ?? agent });
  }
  rows.push({ kind: 'note', warn: false, text: 'Recommended: HA-Jev’s conversation agent with your LLM agent as its fallback agent. Device commands are handled in one quick Jev call; everything else goes to the LLM. A Kev on your network answers fastest; TypeSafe’s hosted Jev adds a few hundred milliseconds to each reply.' });
  const jev = lists.jevEntries;
  if (jev?.length === 0) rows.push({ kind: 'note', warn: false, text: 'Install HA-Jev to let Yanni tell when it’s being talked to.' });
  else if (jev && jev.length > 1) {
    rows.push(picker('jev_config_entry_id', 'Decision model', 'Home Assistant’s choice', jev.map((e) => ({ value: e.entryID, label: e.title }))));
  }
  rows.push(picker('ai_task_entity_id', 'Announcements', 'Short template', lists.aiTasks.map((t) => ({ value: t.id, label: t.name }))));
  return rows;
}
