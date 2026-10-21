// VoiceServicesModel.loadLists and VoiceServicesSection's picker rows, against the fake Home Assistant.
import { describe, expect, test } from 'vitest';
import { SETTING_DEFAULTS, type Settings } from '@yanni/server/settings';
import { engines, loadVoiceServicesLists, voiceServicesRows } from '../../src/settings/VoiceServicesLists';
import { FakeHomeAssistant, haError } from '../conversation/support/FakeHomeAssistant';

const settings = (p: Partial<Settings> = {}): Settings => ({ ...SETTING_DEFAULTS, ...p });

describe('Voice services pickers', () => {
  test('lists come through the channel, AI Tasks only from get_states', async () => {
    const l = await loadVoiceServicesLists(new FakeHomeAssistant());
    expect(l.pipelines.map((p) => p.id)).toEqual(['01PIPE']);
    expect(l.preferredPipelineID).toBe('01PIPE');
    expect(l.agents.map((a) => a.id)).toEqual(['conversation.jev', 'conversation.openai']);
    expect(l.jevEntries?.map((e) => e.entryID)).toEqual(['01JEVENTRY']);
    expect(l.aiTasks).toEqual([{ id: 'ai_task.openai', name: 'OpenAI AI Task' }]);
  });

  test('a failed list is empty, a failed Jev lookup unknown; a closed relay throws', async () => {
    const ha = new FakeHomeAssistant();
    const orig = ha.call.bind(ha);
    ha.call = (r, t) => (r.type === 'conversation/agent/list' || r.type === 'config_entries/get'
      ? Promise.reject(haError('unknown_command', 'x')) : orig(r, t));
    const l = await loadVoiceServicesLists(ha);
    expect(l.agents).toEqual([]);
    expect(l.jevEntries).toBeNull();
    expect(l.pipelines).toHaveLength(1);
    ha.connected = false;
    await expect(loadVoiceServicesLists(ha)).rejects.toThrow();
  });

  test('rows: none options, the engines note, the agent only without a pipeline, Jev picker only with several', async () => {
    const l = await loadVoiceServicesLists(new FakeHomeAssistant());
    const rows = voiceServicesRows(l, settings());
    expect(rows.map((r) => r.kind === 'note' ? 'note' : r.label)).toEqual(['Pipeline', 'note', 'Agent', 'note', 'Announcements']);
    const pipe = rows[0]!;
    expect(pipe.kind === 'picker' && pipe.options[0]).toEqual({ value: '', label: 'Home Assistant’s preferred' });
    expect(rows[1]).toMatchObject({ text: engines(l.pipelines[0]!), warn: false });
    expect(engines(l.pipelines[0]!)).toBe('Home: speech-to-text stt.faster_whisper · speech voice tts.piper (en_US-lessac-medium)');
    const ann = rows[4]!;
    expect(ann.kind === 'picker' && ann.options.map((o) => o.label)).toEqual(['Short template', 'OpenAI AI Task']);

    // A picked pipeline shows its agent instead of the agent picker.
    expect(voiceServicesRows(l, settings({ pipeline_id: '01PIPE' }))[2]).toEqual({ kind: 'fixed', label: 'Agent', value: 'Jev' });

    // Jev: none installed → a note; several → the Decision model picker.
    expect(voiceServicesRows({ ...l, jevEntries: [] }, settings()).some((r) => r.kind === 'note' && r.text.startsWith('Install HA-Jev'))).toBe(true);
    const two = { ...l, jevEntries: [{ entryID: 'a', title: 'Kev', state: '' }, { entryID: 'b', title: 'Hosted', state: '' }] };
    const jev = voiceServicesRows(two, settings()).find((r) => r.kind === 'picker' && r.key === 'jev_config_entry_id');
    expect(jev?.kind === 'picker' && jev.options.map((o) => o.label)).toEqual(['Home Assistant’s choice', 'Kev', 'Hosted']);
  });

  test('a saved id HA no longer lists stays selectable', async () => {
    const l = await loadVoiceServicesLists(new FakeHomeAssistant());
    const ann = voiceServicesRows(l, settings({ ai_task_entity_id: 'ai_task.gone' })).at(-1)!;
    expect(ann.kind === 'picker' && ann.options.at(-1)).toEqual({ value: 'ai_task.gone', label: 'ai_task.gone' });
  });
});
