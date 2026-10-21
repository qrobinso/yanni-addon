// The running app's object graph, shared by the kiosk shell, the settings hub, the kiosk services (governor, health,
// diagnostics) and the owner tools (Tuning, Status). main.ts builds it once; everything else receives it.
import type { FaceEngine } from '../engine/FaceEngine';
import type { LifeCycleController } from '../life/LifeCycleController';
import type { FaceRenderer } from '../render/FaceRenderer';
import type { FrameClock } from '../render/FrameClock';
import type { RenderStyle } from '../render/RenderStyle';
import type { EmotionLayer } from '../emotion/EmotionLayer';
import type { VoiceDirector } from '../voice/bridge/VoiceDirector';
import type { ConversationController } from '../conversation/core/ConversationController';
import type { ConversationAudio } from '../conversation/audio/ConversationAudio';
import type { PerceptionHandle } from '../perception/web/startPerception';
import type { DisplayClient } from './DisplayClient';
import type { Hud } from './Hud';

export interface AppContext {
  engine: FaceEngine;
  life: LifeCycleController;
  renderer: FaceRenderer;
  clock: FrameClock;
  /** Current render style; `setStyle` re-pushes edge geometry and redraws. */
  style(): RenderStyle;
  setStyle(style: RenderStyle): void;
  audioContext: AudioContext;
  conversationAudio: ConversationAudio;
  voice: VoiceDirector | null;
  emotion: EmotionLayer | null;
  conversation: ConversationController | null;
  perception: PerceptionHandle | null;
  client: DisplayClient | null;
  hud: Hud;
  /** Append to the app event log (Status page, diagnostics): never message text, transcripts or tokens. */
  logEvent(category: string, message: string): void;
  /** Wall-clock and monotonic seconds (performance.now based), injectable for tests. */
  now(): number;
}
