import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HomeBridge, type Publisher } from '../src/mqtt.js';
import { SettingsStore } from '../src/store.js';
import type { ServerMessage } from '../src/protocol.js';

const device = { id: 'a1b2c3d4', installId: 'A1B2C3D4-0000-4000-8000-000000000000', room: 'Kitchen' };

function rig(share = true) {
  const published: { topic: string; payload: string; retain: boolean }[] = [];
  const pub: Publisher = { publish: (topic, payload, retain) => { published.push({ topic, payload, retain }); }, subscribe: () => {} };
  const settings = new SettingsStore(mkdtempSync(join(tmpdir(), 'yanni-')));
  settings.merge(device.id, { share_presence: share, chirp_volume: 70, bedtime_start: 1320, sounds: true, room_understanding: false });
  const sent: ServerMessage[] = [];
  const bridge = new HomeBridge(pub, settings, { send: (_id, m) => { sent.push(m); return true; }, device: (id) => (id === device.id ? device : undefined) });
  bridge.connected();
  bridge.displayOnline(device, '0.1.0', 'Chrome on Android', { face_state: 'idle', people_count: 1, battery: null, pending_messages: 0 });
  const last = (topic: string) => published.filter((p) => p.topic === topic).at(-1)?.payload;
  return { published, settings, sent, bridge, last };
}

describe('MQTT discovery', () => {
  it('matches the snapshot for one display', () => {
    const { last } = rig();
    const payload = JSON.parse(last('homeassistant/device/yanni_a1b2c3d4/config')!);
    expect(payload).toMatchSnapshot();
    expect(payload.dev.name).toBe('Yanni Kitchen');
    expect(payload.cmps.chirp_volume.uniq_id).toBe('yanni_a1b2c3d4_chirp_volume'); // the iPad app's unique_ids
  });

  it('publishes retained states, availability and the heartbeat', () => {
    const { published, last } = rig();
    expect(last('yanni/a1b2c3d4/chirp_volume/state')).toBe('70');
    expect(last('yanni/a1b2c3d4/bedtime_start/state')).toBe('22:00');
    expect(last('yanni/a1b2c3d4/face_state/state')).toBe('idle');
    expect(last('yanni/a1b2c3d4/people_count/state')).toBe('1');
    expect(last('yanni/a1b2c3d4/battery/state')).toBeUndefined(); // unknown: nothing published
    expect(last('yanni/a1b2c3d4/availability')).toBe('online');
    expect(last('yanni/a1b2c3d4/last_seen/state')).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(last('yanni/addon/availability')).toBe('online');
    expect(published.filter((p) => p.topic.endsWith('/state')).every((p) => p.retain)).toBe(true);
  });

  it('drops presence entities (with removal stubs) when presence is not shared', () => {
    const { last } = rig(false);
    const cmps = JSON.parse(last('homeassistant/device/yanni_a1b2c3d4/config')!).cmps;
    expect(cmps.person_present).toEqual({ p: 'binary_sensor' });
    expect(cmps.people_count).toEqual({ p: 'sensor' });
    expect(last('yanni/a1b2c3d4/people_count/state')).toBe('');
  });
});

describe('MQTT commands', () => {
  it('applies a valid setting, tells the display and republishes the canonical state', () => {
    const { bridge, settings, sent, last } = rig();
    bridge.message('yanni/a1b2c3d4/chirp_volume/set', Buffer.from('42.4'), false);
    expect(settings.get(device.id).chirp_volume).toBe(42);
    expect(sent).toContainEqual({ type: 'settings', values: { chirp_volume: 42 }, origin: 'homeassistant' });
    expect(last('yanni/a1b2c3d4/chirp_volume/state')).toBe('42');
    bridge.message('yanni/a1b2c3d4/bedtime_end/set', Buffer.from('07:30'), false);
    expect(settings.get(device.id).bedtime_end).toBe(450);
  });

  it('rejects bad values and snaps HA back', () => {
    const { bridge, settings, published } = rig();
    const n = published.length;
    bridge.message('yanni/a1b2c3d4/chirp_volume/set', Buffer.from('900'), false);
    expect(settings.get(device.id).chirp_volume).toBe(70);
    expect(published.slice(n)).toContainEqual({ topic: 'yanni/a1b2c3d4/chirp_volume/state', payload: '70', retain: true });
    bridge.message('yanni/a1b2c3d4/room_understanding/set', Buffer.from('ON'), false); // HA may only turn it off
    expect(settings.get(device.id).room_understanding).toBe(false);
  });

  it('ignores and clears retained commands, ignores empty ones', () => {
    const { bridge, settings, published } = rig();
    bridge.message('yanni/a1b2c3d4/sounds/set', Buffer.from('OFF'), true);
    expect(settings.get(device.id).sounds).toBe(true);
    expect(published.at(-1)).toEqual({ topic: 'yanni/a1b2c3d4/sounds/set', payload: '', retain: true });
    bridge.message('yanni/a1b2c3d4/sounds/set', Buffer.alloc(0), false);
    expect(settings.get(device.id).sounds).toBe(true);
  });

  it('forwards buttons and announcements to the display', () => {
    const { bridge, sent } = rig();
    bridge.message('yanni/a1b2c3d4/force_sleep/set', Buffer.from('PRESS'), false);
    bridge.message('yanni/a1b2c3d4/announce/set', Buffer.from('Dinner is ready'), false);
    expect(sent).toEqual([{ type: 'command', command: 'force_sleep' }, { type: 'command', command: 'announce', payload: 'Dinner is ready' }]);
  });

  it('pushes events unretained; gestures only while presence is shared', () => {
    const hidden = rig(false);
    hidden.bridge.event(device.id, 'last_gesture', { event_type: 'wave' });
    expect(hidden.published.some((p) => p.topic.endsWith('last_gesture/state'))).toBe(false);
    const { bridge, published } = rig();
    bridge.event(device.id, 'last_gesture', { event_type: 'wave' });
    expect(published.at(-1)).toEqual({ topic: 'yanni/a1b2c3d4/last_gesture/state', payload: '{"event_type":"wave"}', retain: false });
  });
});
