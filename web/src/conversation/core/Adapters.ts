// Port of ConversationCore/Adapters.swift: the real subsystems as the controller's ports, with no behaviour of their
// own. port-note: Swift conforms the types by extension; TS wraps the engine and the perception coordinator, while
// `LifeCycleController` and `VoiceDirector` already match their ports structurally.
import type { FaceEngine } from '../../engine/FaceEngine';
import { LifeCycleController } from '../../life/LifeCycleController';
import type { PerceptionCoordinator } from '../../perception/PerceptionCoordinator';
import type { VoiceDirector } from '../../voice/bridge/VoiceDirector';
import type { ConversationFace, ConversationLife, ConversationPerception, ConversationVoice } from './Ports';

export function conversationFace(engine: FaceEngine): ConversationFace {
  return {
    get conversationAgentState() { return engine.state.agentState; },
    get conversationEngagedID() { return engine.state.engagedPersonID; },
    get conversationPeopleCount() { return engine.state.people.length; },
    get conversationSomeoneFacing() { return engine.state.people.some((p) => p.facing >= LifeCycleController.facingThreshold); },
    get conversationActiveOneShots() { return engine.state.activeOneShots; },
    get conversationCompletedOneShots() { return engine.state.completedOneShots; },
    setAgentState: (s) => engine.setAgentState(s),
    send: (c) => engine.send(c),
    setSpeechLevel: (l) => engine.setSpeechLevel(l),
    setListeningGlow: (t) => engine.setListeningGlow(t),
    setListeningVoice: (l) => engine.setListeningVoice(l),
    setListeningLevel: (l) => engine.setListeningLevel(l),
  };
}

export const conversationLife = (life: LifeCycleController): ConversationLife => life;

export const conversationVoice = (director: VoiceDirector): ConversationVoice => director;

export function conversationPerception(c: PerceptionCoordinator): ConversationPerception {
  return {
    pinTurn: (id) => c.pinTurn(id),
    unpinTurn: () => c.unpinTurn(),
    releaseTurn: () => c.releaseTurn(),
    noteEngagementOutcome: (id, spoke) => c.noteEngagementOutcome(id, spoke),
    setLookToTalkDryRun: (on) => { if (c.dryRunAllowed !== on) c.dryRunAllowed = on; },
  };
}
