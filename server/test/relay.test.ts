import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { checkRequest, HaRelay, RATE_BURST } from '../src/relay.js';
import type { ServerMessage } from '../src/protocol.js';

/** A fake Home Assistant: auth handshake, records every frame, answers with `reply`. */
async function mockHA(reply: (m: any, ws: WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const seen: any[] = [];
  const binary: Buffer[] = [];
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.10.0' }));
    ws.on('message', (data, isBinary) => {
      if (isBinary) { binary.push(data as Buffer); return; }
      const m = JSON.parse(data.toString());
      if (m.type === 'auth') {
        ws.send(JSON.stringify(m.access_token === 'good' ? { type: 'auth_ok', ha_version: '2026.10.0' } : { type: 'auth_invalid' }));
        return;
      }
      seen.push(m);
      reply(m, ws);
    });
  });
  const port = (wss.address() as { port: number }).port;
  return { wss, seen, binary, url: `ws://127.0.0.1:${port}` };
}

function client(key: string) {
  const got: ServerMessage[] = [];
  return { key, got, send: (m: ServerMessage) => { got.push(m); } };
}

const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect(f()).toBe(true); };

let cleanup: (() => void)[] = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

async function rig(reply: (m: any, ws: WebSocket) => void) {
  const ha = await mockHA(reply);
  const relay = new HaRelay({ url: ha.url, token: 'good' });
  relay.start();
  cleanup.push(() => { relay.stop(); ha.wss.close(); });
  await until(() => relay.connected);
  return { ha, relay };
}

describe('checkRequest (the whitelist)', () => {
  it.each([
    { type: 'assist_pipeline/run', start_stage: 'stt', end_stage: 'stt', input: { sample_rate: 16000, no_vad: true } },
    { type: 'assist_pipeline/run', start_stage: 'intent', end_stage: 'tts', input: { text: 'hi' } },
    { type: 'assist_pipeline/pipeline/list' },
    { type: 'assist_pipeline/pipeline/get', pipeline_id: 'x' },
    { type: 'conversation/process', text: 'hi' },
    { type: 'conversation/agent/list' },
    { type: 'config_entries/get', domain: 'jev' },
    { type: 'call_service', domain: 'jev', service: 'ask', return_response: true, service_data: { questions: [] } },
    { type: 'call_service', domain: 'ai_task', service: 'generate_data', return_response: true, service_data: { task_name: 'x', instructions: 'y' } },
    { type: 'get_states' },
    { type: 'unsubscribe_events', subscription: 3 },
    { type: 'ping' },
  ])('allows $type', (r) => expect(checkRequest(r)).toBeUndefined());

  it.each([
    { type: 'call_service', domain: 'lock', service: 'unlock', return_response: true, target: { entity_id: 'lock.front' } },
    { type: 'call_service', domain: 'lock', service: 'unlock', return_response: true },
    { type: 'call_service', domain: 'jev', service: 'ask' }, // no return_response
    { type: 'call_service', domain: 'jev', service: 'ask', return_response: true, target: {} },
    { type: 'call_service', domain: 'ai_task', service: 'generate_data', return_response: true,
      service_data: { attachments: [{ media_content_id: 'media-source://camera/camera.front' }] } },
    { type: 'assist_pipeline/run', start_stage: 'wake_word', end_stage: 'tts' },
    { type: 'config_entries/get', domain: 'mqtt' },
    { type: 'config_entries/get' },
    { type: 'subscribe_events' },
    { type: 'subscribe_trigger' },
    { type: 'execute_script' },
    { type: 'fire_event' },
    { type: 'auth/long_lived_access_token' },
    { type: 'config/auth/create' },
    { type: 'supervisor/api' },
    { type: 'render_template', template: '{{ states }}' },
  ])('refuses $type $domain $service', (r) => expect(checkRequest(r)).toBeTypeOf('string'));
});

describe('HaRelay against a mock Home Assistant', () => {
  it('remaps ids per display and routes results back', async () => {
    const { ha, relay } = await rig((m, ws) => ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: { echo: m.text } })));
    const a = client('aaaa0001'), b = client('bbbb0002');
    relay.addClient(a); relay.addClient(b);
    relay.call(a.key, 1, { type: 'conversation/process', text: 'from a' });
    relay.call(b.key, 1, { type: 'conversation/process', text: 'from b' });
    await until(() => a.got.length === 1 && b.got.length === 1);
    expect(a.got[0]).toEqual({ type: 'ha.result', id: 1, success: true, result: { echo: 'from a' } });
    expect(b.got[0]).toEqual({ type: 'ha.result', id: 1, success: true, result: { echo: 'from b' } });
    const ids = ha.seen.map((m) => m.id);
    expect(new Set(ids).size).toBe(2); // same display id, distinct upstream ids
  });

  it('refuses non-whitelisted calls without sending them upstream', async () => {
    const { ha, relay } = await rig(() => {});
    const a = client('aaaa0001');
    relay.addClient(a);
    relay.call(a.key, 5, { type: 'call_service', domain: 'lock', service: 'unlock', return_response: true });
    expect(a.got[0]).toMatchObject({ type: 'ha.result', id: 5, success: false, error: { code: 'not_allowed' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(ha.seen).toEqual([]);
  });

  it('rate-limits each display', async () => {
    const { relay } = await rig((m, ws) => ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: null })));
    const a = client('aaaa0001');
    relay.addClient(a);
    for (let i = 1; i <= RATE_BURST + 1; i++) relay.call(a.key, i, { type: 'ping' });
    expect(a.got.at(-1)).toMatchObject({ success: false, error: { code: 'rate_limited' } });
  });

  it('filters get_states to the domains Yanni needs', async () => {
    const { relay } = await rig((m, ws) => ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: [
      { entity_id: 'ai_task.openai', state: 'unknown', attributes: { friendly_name: 'OpenAI', secret: 1 } },
      { entity_id: 'lock.front', state: 'locked', attributes: {} },
      { entity_id: 'person.quentin', state: 'home', attributes: {} },
    ] })));
    const a = client('aaaa0001');
    relay.addClient(a);
    relay.call(a.key, 1, { type: 'get_states' });
    await until(() => a.got.length === 1);
    expect(a.got[0]).toEqual({ type: 'ha.result', id: 1, success: true,
      result: [{ entity_id: 'ai_task.openai', state: 'unknown', attributes: { friendly_name: 'OpenAI' } }] });
  });

  it('streams a pipeline run, forwards audio only to its own handler, remaps unsubscribe', async () => {
    const { ha, relay } = await rig((m, ws) => {
      if (m.type === 'assist_pipeline/run') {
        ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: null }));
        ws.send(JSON.stringify({ id: m.id, type: 'event', event: { type: 'run-start', data: { runner_data: { stt_binary_handler_id: 3 } } } }));
      } else {
        ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: null }));
      }
    });
    const a = client('aaaa0001'), b = client('bbbb0002');
    relay.addClient(a); relay.addClient(b);
    relay.call(a.key, 10, { type: 'assist_pipeline/run', start_stage: 'stt', end_stage: 'stt', input: { sample_rate: 16000 } });
    await until(() => a.got.length === 2);
    expect(a.got[1]).toMatchObject({ type: 'ha.event', id: 10, event: { type: 'run-start' } });
    expect(relay.binary(a.key, Buffer.from([3, 1, 2]))).toBeUndefined();
    expect(relay.binary(b.key, Buffer.from([3, 9, 9]))).toBeTypeOf('string'); // not b's run
    expect(relay.binary(a.key, Buffer.from([4, 1, 2]))).toBeTypeOf('string');
    await until(() => ha.binary.length === 1);
    expect([...ha.binary[0]!]).toEqual([3, 1, 2]);
    const runUp = ha.seen[0].id;
    relay.call(b.key, 1, { type: 'unsubscribe_events', subscription: 10 }); // b can't cancel a's run
    expect(b.got.at(-1)).toMatchObject({ success: false, error: { code: 'not_found' } });
    relay.call(a.key, 11, { type: 'unsubscribe_events', subscription: 10 });
    await until(() => ha.seen.length === 2);
    expect(ha.seen[1]).toMatchObject({ type: 'unsubscribe_events', subscription: runUp });
    expect(relay.binary(a.key, Buffer.from([3]))).toBeTypeOf('string'); // the run is gone
  });

  it('fails pending calls and reports status when HA drops', async () => {
    const { ha, relay } = await rig(() => {});
    const a = client('aaaa0001');
    relay.addClient(a);
    relay.call(a.key, 1, { type: 'conversation/process', text: 'x' });
    await until(() => ha.seen.length === 1);
    for (const ws of ha.wss.clients) ws.terminate();
    await until(() => a.got.length === 2);
    expect(a.got).toContainEqual(expect.objectContaining({ id: 1, success: false, error: expect.objectContaining({ code: 'ha_unavailable' }) }));
    expect(a.got).toContainEqual({ type: 'ha.status', connected: false });
  });
});
