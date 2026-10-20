import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../src/protocol.js';

const ok = (m: unknown) => expect(parseClientMessage(JSON.stringify(m))).not.toHaveProperty('error');
const bad = (m: unknown) => expect(parseClientMessage(typeof m === 'string' ? m : JSON.stringify(m))).toHaveProperty('error');

describe('parseClientMessage', () => {
  it('accepts every message kind', () => {
    ok({ type: 'hello', protocol: 1, token: 't', appVersion: '0.1.0', settings: { room: 'Kitchen', chirp_volume: 70, reply_voice: 'Yanni' },
      state: { face_state: 'idle', battery: null } });
    ok({ type: 'settings', values: { bedtime_start: 1320, mood_background: 'Fixed colour' } });
    ok({ type: 'state', values: { people_count: 2, pending_ids: ['a'], life_phase: 'half_awake' } });
    ok({ type: 'event', entity: 'last_gesture', eventType: 'wave' });
    ok({ type: 'event', entity: 'announcement', eventType: 'delivered', id: 'msg-1' });
    ok({ type: 'ha.call', id: 7, request: { type: 'conversation/process', text: 'hi' } });
  });

  it('rejects malformed frames', () => {
    bad('not json');
    bad([]);
    bad({ type: 'nope' });
    bad({ type: 'hello', protocol: 1, appVersion: '1', settings: {} }); // no token
    bad({ type: 'settings', values: { chirp_volume: 101 } });
    bad({ type: 'settings', values: { bedtime_start: 12.5 } });
    bad({ type: 'settings', values: { admin: true } });
    bad({ type: 'settings', values: { reply_voice: 'Robot' } });
    bad({ type: 'state', values: { face_state: 'dancing' } });
    bad({ type: 'state', values: { conversation_context: 'x'.repeat(256) } });
    bad({ type: 'event', entity: 'last_gesture', eventType: 'punch' });
    bad({ type: 'event', entity: 'other', eventType: 'wave' });
    bad({ type: 'ha.call', id: 0, request: { type: 'get_states' } });
    bad({ type: 'ha.call', id: 1.5, request: { type: 'get_states' } });
    bad({ type: 'ha.call', id: 1, request: { type: 'get_states', id: 99 } });
  });
});
