// Port of ConversationAgentTests/CaptionTests.swift: caption bubbles end to end (caption bubbles design §3), the real
// controller over `LocalAgentTransport` with the fake HA. port-note: Swift string interpolation of a caption becomes
// `describeCaption` / `describeCaptionText`.
import { describe, expect, test } from 'vitest';
import { makeConversationSettings } from '../../../src/conversation/core/ConversationSettings';
import { describeCaption, describeCaptionText, type Caption } from '../../../src/conversation/events/Captions';
import { AsyncMailbox } from '../support/AgentTestKit';
import { FakeHA, result } from '../support/FakeHomeAssistant';
import { FakeSpeechToText } from '../support/FakeSpeechToText';
import { AgentControllerRig } from './AgentControllerRig';

const heard = "what's the weather like today?";

function rigWithBox(make: () => AgentControllerRig = () => new AgentControllerRig()) {
  const rig = make();
  const box: [Caption, number][] = [];
  rig.controller.onCaption = (c) => box.push([c, rig.clock.now]);
  return { rig, box };
}

describe('CaptionTests', () => {
  test('aTurnCaptionsTheTranscriptThenEachSentenceAsItIsHeardThenTheEnd', async () => {
    const { rig, box } = rigWithBox();
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(8, () => rig.phase === 'followUp')).toBe(true);
    const captions = box.map(([c]) => c);
    expect(captions[0]).toEqual({ kind: 'transcriptPartial', text: '' }); // the bubble shows at speech start
    expect(captions.find((c) => c.kind === 'transcript')).toEqual({ kind: 'transcript', turnId: 't-1', text: heard });
    const sentences = box.flatMap(([c, t]) => (c.kind === 'replySentence' && c.turnId === 't-1' ? [{ c, t }] : []));
    expect(sentences.map((s) => s.c.index)).toEqual([0, 1]);
    expect(sentences.map((s) => s.c.text).join('').replaceAll(' ', '')).toBe('Hello there, my friend! It is sunny today.'.replaceAll(' ', ''));
    // Each piece is emitted when the reply clock reaches it, stamped with its audible host time.
    expect(sentences.every((s) => Math.abs(s.c.audibleAtHostTime - s.t) < 0.1)).toBe(true);
    expect(sentences[1].t).toBeGreaterThan(sentences[0].t); // the second piece waits for its audio
    expect(captions.at(-1)).toEqual({ kind: 'replyEnded', turnId: 't-1' });
    expect(await rig.runUntil(8, () => rig.phase === 'idle')).toBe(true);
    expect(box.at(-1)?.[0]).toEqual({ kind: 'cleared' }); // the conversation's end takes them down
  });

  test('notForMeAndUnclearTurnsClearTheListeningBubbleAndNeverShowTheTranscript', async () => {
    for (const jev of [FakeHA.jevResponse({ addressed: 0.05 }), FakeHA.jevResponse({ understood: 0.1 })]) {
      const stt = new FakeSpeechToText();
      stt.configure({ partials: ["what's", "what's the wether"] });
      const { rig, box } = rigWithBox(() => new AgentControllerRig({ stt }));
      rig.ha.configure((c) => { c.onJev = async () => result(jev); });
      expect(await rig.toListening()).toBe(true);
      await rig.userTurn();
      expect(await rig.runUntil(3, () => rig.state === 'notForMe' || rig.state === 'confused')).toBe(true);
      await rig.run(0.5);
      const captions = box.map(([c]) => c);
      expect(captions).toContainEqual({ kind: 'transcriptPartial', text: "what's the wether" }); // partials show while speaking
      expect(captions.some((c) => c.kind === 'transcript')).toBe(false);
      expect(captions.at(-1)).toEqual({ kind: 'cleared' }); // the verdict pops the partial bubble away
    }
  });

  test('partialsAreDisplayOnlyTheGateAndAgentGetTheFinalTranscript', async () => {
    const stt = new FakeSpeechToText();
    stt.configure({ partials: ["what's", "what's the wether", "what's the weather like"] });
    const { rig, box } = rigWithBox(() => new AgentControllerRig({ stt }));
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(8, () => rig.phase === 'followUp')).toBe(true);
    const captions = box.map(([c]) => c);
    const partials = captions.flatMap((c) => (c.kind === 'transcriptPartial' ? [c.text] : []));
    expect(partials).toEqual(['', "what's", "what's the wether", "what's the weather like"]);
    const iPartial = captions.findIndex((c) => c.kind === 'transcriptPartial' && c.text === "what's the weather like");
    const iFinal = captions.findIndex((c) => c.kind === 'transcript' && c.turnId === 't-1' && c.text === heard);
    expect(iPartial).toBeLessThan(iFinal);
    const sent = JSON.stringify(rig.ha.log);
    expect(sent.includes('the weather like today')).toBe(true); // the gate and the agent get the final transcript
    expect(sent.includes('wether')).toBe(false); // partials never leave the display
    expect(rig.log.map((e) => e.detail).join('').includes('wether') || JSON.stringify(rig.events).includes('wether')).toBe(false);
  });

  test('eachReplyPieceCarriesItsAudioLength', async () => {
    const { rig, box } = rigWithBox();
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(8, () => rig.phase === 'followUp')).toBe(true);
    // Every piece gets its audio length, at once or by a timing that follows (never more than one untimed).
    const timed = new Map<number, number>();
    for (const [c] of box) {
      if (c.kind === 'replySentence' && c.audioSeconds !== null) timed.set(c.index, c.audioSeconds);
      if (c.kind === 'replyTiming') timed.set(c.index, c.audioSeconds);
    }
    expect([...timed.keys()].sort()).toEqual([0, 1]);
    expect([...timed.values()].every((d) => d > 0.05)).toBe(true);
  });

  test('theTranscriptCaptionFollowsTheGateVerdict', async () => {
    const { rig } = rigWithBox();
    const order: Caption[] = [];
    rig.transport.onAgentEvent = (e) => {
      rig.events.push(e);
      if (e.kind === 'decision' && e.payload.pass === 'utterance') order.push({ kind: 'cleared' });
    };
    rig.controller.onCaption = (c) => { if (c.kind === 'transcript') order.push(c); };
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(5, () => order.length >= 2)).toBe(true);
    expect(order).toEqual([{ kind: 'cleared' }, { kind: 'transcript', turnId: 't-1', text: heard }]); // the Pass A decision comes first
  });

  test('bargeInClearsAtOnce', async () => {
    const { rig, box } = rigWithBox();
    const hold = new AsyncMailbox<void>();
    rig.ha.configure((c) => { c.onTTS = async (_t, run) => { if (run === 1) await hold.pop(); return FakeHA.ttsRun(`tts-${run}.wav`); }; });
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(6, () => rig.phase === 'speaking')).toBe(true);
    expect(await rig.runUntil(2, () => box.some(([c]) => c.kind === 'replySentence'))).toBe(true);
    rig.speak();
    await rig.frame();
    expect(rig.phase).toBe('interrupted');
    // The reply clears at once; the barge-in's own speech then opens a fresh listening bubble.
    expect(box.slice(-2).map(([c]) => c)).toEqual([{ kind: 'cleared' }, { kind: 'transcriptPartial', text: '' }]);
    const n = box.length;
    await rig.run(1);
    expect(box.length).toBe(n); // nothing from the cut reply after the clear
    hold.close();
  });

  test('captionsOffEmitsNothing', async () => {
    const { rig, box } = rigWithBox();
    rig.controller.settings = makeConversationSettings({ showCaptions: false });
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(8, () => rig.phase === 'followUp')).toBe(true);
    expect(box).toEqual([]);
  });

  test('switchingCaptionsOffMidReplyClears', async () => {
    const { rig, box } = rigWithBox();
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(5, () => box.length > 0)).toBe(true);
    rig.controller.settings = { ...rig.controller.settings, showCaptions: false };
    expect(box.at(-1)?.[0]).toEqual({ kind: 'cleared' });
  });

  test('noCaptionTextInTheLogOrTheAgentEvents', async () => {
    const { rig, box } = rigWithBox();
    expect(await rig.toListening()).toBe(true);
    await rig.userTurn();
    expect(await rig.runUntil(8, () => rig.phase === 'followUp')).toBe(true);
    expect(box.length).toBeGreaterThan(0);
    const logged = rig.log.map((e) => `${e.kind} ${e.detail}`).join('\n') + JSON.stringify(rig.events);
    for (const word of ['weather', 'sunny', 'friend']) expect(logged.includes(word), `${word} leaked`).toBe(false);
    // A description of a caption prints lengths, never words.
    expect(box.map(([c]) => describeCaption(c)).join('').includes('weather')).toBe(false);
    expect(describeCaptionText({ kind: 'transcript', turnId: 't-1', text: heard }).includes('weather')).toBe(false);
  });
});
