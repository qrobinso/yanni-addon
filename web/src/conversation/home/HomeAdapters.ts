// Port of ConversationHome/HomeAdapters.swift.
// port-note: YanniHome's `ProactiveCoordinator` is `AnnouncementQueue` (src/conversation/announcements) in the port.
import {
  type AnnouncementQueue, type DeliveryResult, type ProactiveConversation,
} from '../announcements/AnnouncementQueue';
import type { ConversationController } from '../core/ConversationController';
import type { AnnouncementDelivery, ProactiveBatch, ProactiveOutcome } from '../core/Ports';

/** The Home Assistant announcement queue as the voice loop's `AnnouncementDelivery` (review H2). The loop pulls a
 *  batch when engagement starts (and when a follow-up ends with the person still engaged) and reports how it ended. */
export class CoordinatorAnnouncements implements AnnouncementDelivery {
  /** A batch starts delivery, with its priority only (the expressive delivery face; never the text). */
  onBatchTaken: ((priority: string) => void) | null = null;

  constructor(readonly coordinator: AnnouncementQueue) {}

  hasDeliverable(people: number, engaged: boolean): boolean {
    return this.coordinator.hasDeliverable({ people, engaged });
  }

  takeBatch(people: number, engaged: boolean): ProactiveBatch | null {
    const b = this.coordinator.takeBatch({ people, engaged });
    if (b === null) return null;
    this.onBatchTaken?.(b.items.some((i) => i.priority === 'high') ? 'high' : 'normal');
    return {
      id: b.id, ids: b.items.map((i) => i.id),
      items: b.items.map((i) => ({ kind: 'announcement', text: i.text, context: i.context })),
    };
  }

  finish(batchID: number, outcome: ProactiveOutcome): void {
    this.coordinator.finish(batchID, CoordinatorAnnouncements.result(outcome));
  }

  /** The loop's outcome → the coordinator's `DeliveryResult` (the transport's `proactiveDone` statuses map the same). */
  static result(o: ProactiveOutcome): DeliveryResult {
    switch (o) {
      case 'spoken': return 'spoken';
      case 'interrupted': return 'interrupted';
      case 'unavailable': return 'unavailable';
      case 'cancelled': return 'cancelled';
    }
  }
}

/** The coordinator's handle on the voice loop: settings-open suppression and the high-priority push. port-note:
 *  Swift holds the controller weakly; here it's a plain reference. */
export class ConversationProactiveLink implements ProactiveConversation {
  private suppressed = false;

  constructor(public controller: ConversationController | null) {}

  /** Look-to-talk and proactive delivery closed while the owner Settings screen is open. */
  get isSuppressed(): boolean { return this.controller?.isSuppressed ?? this.suppressed; }
  set isSuppressed(v: boolean) {
    this.suppressed = v;
    if (this.controller !== null) this.controller.isSuppressed = v;
  }

  requestProactiveTurn(): void { this.controller?.requestProactiveTurn(); }
}
