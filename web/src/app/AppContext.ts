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
import type { AnnouncementQueue } from '../conversation/announcements/AnnouncementQueue';
import type { CaptionOverlay } from '../conversation/captions/CaptionModel';
import type { ExpressiveDecisions } from '../conversation/core/ExpressiveDecisions';
import type { TurnDetector } from '../conversation/core/TurnDetection';
import type { LocalAgentTransport } from '../conversation/agent/LocalAgentTransport';
import type { ConversationAudioEngine } from './conversation/ConversationAudioEngine';
import type { PerceptionHarness } from './PerceptionHarness';

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

  // ---- Added by the integration wave (I1); optional so contexts built elsewhere (demos, tests) still type ----
  /** The conversation's audio control (mic mode, privacy gate, reply playout, clips). */
  audioEngine?: ConversationAudioEngine;
  /** The orchestrator's transport (voice services health); null when it couldn't be built. */
  transport?: LocalAgentTransport | null;
  turnDetector?: TurnDetector | null;
  announcements?: AnnouncementQueue | null;
  captions?: CaptionOverlay | null;
  expressive?: ExpressiveDecisions | null;
  /** Perception counters behind the HA perception sensors and "Wrong reaction". */
  harness?: PerceptionHarness;
  /** Hold to talk without the hold (the space bar, the accessibility action, Tuning's Touch preview). */
  talk?: (at: { x: number; y: number } | null) => void;
  /** The owner menu's destinations (Settings, Status, Tuning behind their rules) and the menu itself. */
  openOwner?: (destination: 'menu' | 'settings' | 'status' | 'tuning' | 'reset') => void;
  /** The face's drawable size in CSS px (the edge geometry's input). Perception's settings: `perception.coordinator.settings`. */
  faceSize?: () => { width: number; height: number };
  /** The owner Settings screen is showing (look-to-talk and announcements pause). Set by whoever shows it. */
  settingsOpen?: boolean;
  /** Recent app events (newest last, at most 200; Status). */
  readonly events?: readonly { at: number; category: string; message: string }[];
}
