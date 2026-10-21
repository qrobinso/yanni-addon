// Port of FaceScreen.swift's FaceAccessibilityElement over yanni/Kiosk/FaceAccessibility.swift (the spoken state and
// its throttle live in the kiosk services: kiosk/FaceSpokenState.ts, `KioskServices.spokenState()`): the face is one element, "Yanni", whose spoken state ("awake and looking at
// you", "asleep", "has a message") changes at most every few seconds, never per frame. port-note: the web has no custom
// actions rotor, so the actions (Talk to Yanni, Open menu, Settings, Status, Wake up / Go to sleep) are real buttons in
// a visually hidden toolbar right after the face, reachable from the keyboard (Tab) and any screen reader. Activating
// the face itself (Enter on it) pokes the face centre.
import './accessibility.css';

export interface FaceAccessibilityActions {
  poke(): void;
  talk(): void;
  openMenu(): void;
  settings(): void;
  status(): void;
  wake(): void;
  sleep(): void;
}

/** The face's element (the canvas) and its actions toolbar. Fed by the app's 4 Hz poll. */
export class FaceAccessibility {
  private asleep = false;
  private readonly desc: HTMLElement;
  private readonly sleepButton: HTMLButtonElement;

  constructor(face: HTMLElement, desc: HTMLElement, actions: FaceAccessibilityActions) {
    this.desc = desc;
    face.setAttribute('role', 'img');
    face.setAttribute('aria-label', 'Yanni');
    face.setAttribute('aria-describedby', desc.id);
    face.setAttribute('aria-roledescription', 'face');
    face.tabIndex = 0;
    face.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.repeat) return;
      e.preventDefault();
      actions.poke();
    });
    const bar = document.createElement('div');
    bar.className = 'face-actions';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Yanni actions');
    const b = (label: string, act: () => void) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = label;
      el.addEventListener('click', act);
      bar.append(el);
      return el;
    };
    b('Talk to Yanni', actions.talk);
    b('Open menu', actions.openMenu);
    b('Settings', actions.settings);
    b('Status', actions.status);
    this.sleepButton = b('Go to sleep', () => { if (this.asleep) actions.wake(); else actions.sleep(); });
    face.after(bar);
    desc.textContent = 'awake';
  }

  /** The 4 Hz poll: the throttled spoken state, and asleep or drowsy (the last action then reads "Wake up"). */
  update(spoken: string, asleep: boolean): void {
    if (this.desc.textContent !== spoken) this.desc.textContent = spoken;
    if (asleep === this.asleep) return;
    this.asleep = asleep;
    this.sleepButton.textContent = asleep ? 'Wake up' : 'Go to sleep';
  }
}
