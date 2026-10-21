// Port of ConversationHome/VoiceServicesState.swift.
import type { VoiceServicesState } from '@yanni/server/protocol';
import type { ConversationStatus } from '../core/ConversationController';

/** The Home Assistant voice services diagnostic (design §13.4) from the conversation status and the transport's
 *  health: not set up / voice off → `not_configured`; Home Assistant up but speech recognition, the speech voice it
 *  needs or Jev down (`servicesDown`) → `degraded`; the last attempt failed or the session dropped → `unreachable`;
 *  otherwise `connected` (ready, or idle between conversations after a good session). */
export function voiceServicesState(status: ConversationStatus, servicesDown = false): VoiceServicesState {
  if (status.session === 'dormant') return 'not_configured';
  if (servicesDown) return 'degraded';
  return status.servicesReachable === false ? 'unreachable' : 'connected';
}
