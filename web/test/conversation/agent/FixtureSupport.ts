// Port of ConversationAgentTests/FixtureSupport.swift: the third-party fixtures (yanni's protocol/fixtures/home-assistant,
// copied to test/conversation/fixtures/home-assistant). port-note: the Wyoming scripts are dropped with Wyoming.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { at, arrayValue, stringValue, type JSONValue } from '../../../src/conversation/agent/JSONValue';

const here = dirname(fileURLToPath(import.meta.url));

export const AgentFixtures = {
  homeAssistant: join(here, '..', 'fixtures', 'home-assistant'),

  raw(name: string): JSONValue {
    return JSON.parse(readFileSync(join(AgentFixtures.homeAssistant, name), 'utf8')) as JSONValue;
  },

  haMessages(name: string): { dir: string; msg: JSONValue }[] {
    return (arrayValue(AgentFixtures.raw(name)) ?? []).map((m) => ({ dir: stringValue(at(m, 'dir')) ?? '', msg: at(m, 'msg') ?? at(m, 'raw') ?? null }));
  },

  /** The `s2c` events of a recorded pipeline run (the `event` objects). */
  pipelineEvents(name: string): JSONValue[] {
    return AgentFixtures.haMessages(name).filter((m) => m.dir === 's2c' && stringValue(at(m.msg, 'type')) === 'event')
      .map((m) => at(m.msg, 'event') ?? null);
  },

  serviceResponse(name: string): JSONValue {
    return at(AgentFixtures.haMessages(name).find((m) => m.dir === 's2c')?.msg, 'result', 'response') ?? null;
  },
};
