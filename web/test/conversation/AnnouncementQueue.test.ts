import { describe, expect, test } from 'vitest';
import { parseAnnounce } from '@yanni/server/announce';
import { AnnouncementQueue, localAnnouncementStore, type AnnouncementResult, type HeldAnnouncement, type ProactiveContext }
  from '../../src/conversation/announcements';
import type { AgentState } from '../../src/engine/AgentState';

function rig(stored?: HeldAnnouncement[]) {
  let t = 0;
  let wall = 1_700_000_000_000;
  const results: AnnouncementResult[] = [];
  const states: AgentState[] = [];
  const nudges: unknown[] = [];
  const conversation = { isSuppressed: false, requests: 0, requestProactiveTurn() { this.requests += 1; } };
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
  if (stored) storage.setItem('yanni.pendingAnnouncements', JSON.stringify(stored));
  const ctx: ProactiveContext = { agentState: 'idle', lifePhase: 'awake', isBedtime: false, isForceSleep: false,
    personPresent: false, eyeContact: false, quietMode: false, settingsOpen: false };
  const q = new AnnouncementQueue({
    now: () => t, wallNow: () => wall, store: localAnnouncementStore(storage), conversation,
    setAgentState: (s) => { states.push(s); ctx.agentState = s; },
    onResult: (r) => results.push(r), onNudge: (n) => nudges.push(n),
  });
  const say = (payload: string) => {
    const c = parseAnnounce(payload, 1800, wall);
    if (c.kind === 'rejected') throw new Error(c.reason);
    q.receive(c);
  };
  const tick = (dt: number, patch: Partial<ProactiveContext> = {}) => { t += dt; wall += dt * 1000; Object.assign(ctx, patch); q.update({ ...ctx }); };
  return { q, say, tick, ctx, results, states, nudges, conversation, mem };
}

const one = { people: 1, engaged: true };

describe('AnnouncementQueue (ProactiveCoordinator port)', () => {
  test('holds until someone is there, shows has-a-message, delivers a batch', () => {
    const r = rig();
    r.say('Laundry is done');
    r.tick(1);
    expect(r.states).toEqual([]); // nobody in view: hold
    r.tick(1, { personPresent: true });
    expect(r.states).toEqual(['hasMessage']);
    const b = r.q.takeBatch(one)!;
    expect(b.items.map((a) => a.text)).toEqual(['Laundry is done']);
    expect(r.q.report().pending_messages).toBe(1);
    r.q.finish(b.id, 'spoken');
    expect(r.results).toEqual([{ id: b.items[0]!.id, outcome: 'delivered' }]);
    expect(r.q.report()).toEqual({ pending_messages: 0, pending_ids: [], pending_expires: [] });
  });

  test('bedtime, sleep and quiet mode hold; quiet mode shows the face but never delivers', () => {
    const r = rig();
    r.say('x');
    r.tick(1, { personPresent: true, isBedtime: true });
    expect(r.states).toEqual([]);
    expect(r.q.takeBatch(one)).toBeNull();
    r.tick(1, { isBedtime: false, lifePhase: 'asleep' });
    expect(r.states).toEqual([]);
    r.tick(1, { lifePhase: 'awake', quietMode: true });
    expect(r.states).toEqual(['hasMessage']);
    expect(r.q.takeBatch(one)).toBeNull();
    r.tick(1, { quietMode: false });
    expect(r.q.takeBatch(one)).toBeDefined();
  });

  test('a repeated id replaces the pending one; cancel removes it; overflow drops the oldest normal', () => {
    const r = rig();
    r.say('{"kind":"announce","id":"dryer","text":"5 min left"}');
    r.say('{"kind":"announce","id":"dryer","text":"Dryer done"}');
    expect(r.q.items.map((a) => a.text)).toEqual(['Dryer done']);
    expect(r.results).toEqual([{ id: 'dryer', outcome: 'cancelled', reason: 'replaced' }]);
    r.say('{"kind":"cancel","id":"dryer"}');
    expect(r.results.at(-1)).toEqual({ id: 'dryer', outcome: 'cancelled', reason: 'cancel' });
    r.say('{"kind":"announce","id":"h","text":"urgent","priority":"high"}');
    for (let i = 0; i < 8; i++) { r.tick(0.01); r.say(`{"kind":"announce","id":"n${i}","text":"n${i}"}`); }
    expect(r.q.items).toHaveLength(8);
    expect(r.q.items[0]!.id).toBe('h'); // high first
    expect(r.results.at(-1)).toEqual({ id: 'n0', outcome: 'cancelled', reason: 'overflow' });
  });

  test('expiry: expired, or failed after an unavailable attempt', () => {
    const r = rig();
    r.say('{"kind":"announce","id":"a","text":"a","expires_in":60}');
    r.say('{"kind":"announce","id":"b","text":"b","expires_in":120}');
    r.tick(1, { personPresent: true });
    const b = r.q.takeBatch(one)!;
    r.q.finish(b.id, 'unavailable');
    r.tick(61);
    expect(r.results).toEqual([{ id: 'a', outcome: 'failed', reason: 'unavailable' }]);
    r.tick(60);
    expect(r.results.at(-1)).toEqual({ id: 'b', outcome: 'failed', reason: 'unavailable' });
    expect(r.states.at(-1)).toBe('noticing'); // nothing left: leaves has-a-message
  });

  test('interrupted twice counts as delivered (partial); a replacement during delivery waits', () => {
    const r = rig();
    r.say('{"kind":"announce","id":"x","text":"one"}');
    r.tick(1, { personPresent: true });
    let b = r.q.takeBatch(one)!;
    r.say('{"kind":"announce","id":"x","text":"two"}');
    r.q.finish(b.id, 'interrupted');
    expect(r.q.items.map((a) => a.text)).toEqual(['two']);
    b = r.q.takeBatch(one)!;
    r.q.finish(b.id, 'interrupted');
    expect(r.q.items).toHaveLength(1); // the replacement is new: no interruptions yet
    b = r.q.takeBatch(one)!;
    r.q.finish(b.id, 'interrupted');
    expect(r.results.at(-1)).toEqual({ id: 'x', outcome: 'delivered', reason: 'partial' });
  });

  test('high priority asks for a turn after 1.5 s of presence; gives up the face after 3 minutes unengaged', () => {
    const r = rig();
    r.say('{"kind":"announce","text":"door","priority":"high"}');
    r.tick(0.5, { personPresent: true });
    r.tick(1.25);
    expect(r.conversation.requests).toBe(0); // 1.25 s present
    r.tick(0.25);
    expect(r.conversation.requests).toBe(1);
    r.tick(1);
    expect(r.conversation.requests).toBe(1);
    r.tick(180);
    expect(r.states).toEqual(['hasMessage', 'noticing']);
    expect(r.q.armed).toBe(false);
    r.tick(0.25, { eyeContact: true }); // new eye contact re-arms
    expect(r.states.at(-1)).toBe('hasMessage');
  });

  test('settings open pauses delivery and suppresses look-to-talk', () => {
    const r = rig();
    r.say('x');
    r.tick(1, { personPresent: true, settingsOpen: true });
    expect(r.conversation.isSuppressed).toBe(true);
    expect(r.q.takeBatch(one)).toBeNull();
  });

  test('nudges only while awake and not at bedtime', () => {
    const r = rig();
    r.say('{"kind":"nudge","feeling":"joy"}');
    r.tick(0.25, { isBedtime: true });
    r.say('{"kind":"nudge","feeling":"joy"}');
    expect(r.nudges).toEqual([{ feeling: 'joy', strength: 0.5 }]);
  });

  test('survives a relaunch: expired dropped, mid-delivery back to pending with an interruption', () => {
    const now = 1_700_000_000_000;
    const base = { context: {}, priority: 'normal' as const, receivedAt: now - 1000, interruptions: 0, lastAttemptUnavailable: false };
    const r = rig([{ ...base, id: 'old', text: 'o', expiresAt: now - 1, state: 'pending' },
      { ...base, id: 'mid', text: 'm', expiresAt: now + 60_000, state: 'delivering' }, { id: 'junk' } as never]);
    expect(r.q.items.map((a) => [a.id, a.state, a.interruptions])).toEqual([['mid', 'pending', 1]]);
    r.q.clearAll('reset');
    expect(r.results).toEqual([{ id: 'mid', outcome: 'cancelled', reason: 'reset' }]);
    expect(r.mem.has('yanni.pendingAnnouncements')).toBe(false);
  });
});
