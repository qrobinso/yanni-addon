// The face's touch surface (port of FaceScreen.swift's FaceTouchSurface / mac press handling). One finger goes to the
// touch classifier (`TouchGestureRecognizer`, web/src/engine/TouchGestures.ts) exactly as the
// app feeds it: begin (excluded in the owner corner) / move / a 30 Hz tick while down / end / cancel. A tap pokes on
// release (even in the corner); holding the bottom-right corner 2.5 s opens the owner menu instead and cancels the
// touch, so lifting the finger doesn't also poke. A second finger cancels the touch. A four-finger press opens the menu
// at 1.2 s and, kept going to 10 s, Reset (the forgotten-PIN escape hatch).
import type { V2 } from '../core/vec';
import type { TouchGestureEvent } from '../engine/TouchGestures';

export type { TouchGestureEvent };

/** The recogniser's API (`TouchGestureRecognizer`), structurally (tests may pass a fake). */
export interface TouchRecognizer {
  readonly isTracking: boolean;
  begin(at: V2, time: number, excluded?: boolean): void;
  move(to: V2, time: number): TouchGestureEvent | null | undefined;
  tick(time: number): TouchGestureEvent | null | undefined;
  end(at: V2, time: number): TouchGestureEvent | null | undefined;
  cancel(): void;
}

export interface TouchInputCallbacks {
  /** A verdict, with the surface size (CSS px) it was made in. */
  onGesture(e: TouchGestureEvent, width: number, height: number): void;
  /** A finger came down outside the corner (it may become hold to talk). */
  onPress?(): void;
  /** Corner ring progress 0…1 once the hold passes `ringDelay`; null when hidden. */
  onCornerProgress?(progress: number | null): void;
  onMenu(): void;
  /** A four-finger press held to `resetHold`. */
  onReset?(): void;
  /** Any touch at all (the owner screens' idle timers). */
  onAnyTouch?(): void;
}

export class TouchInput {
  /** The invisible bottom-right corner that leads to the owner menu (CSS px). */
  static readonly cornerSize = 88;
  /** Corner press-and-hold: the ring appears after `ringDelay` and the menu opens at `cornerHold` (OwnerUIModel). */
  static readonly cornerHold = 2.5;
  static readonly ringDelay = 1;
  static readonly tickInterval = 1 / 30;
  /** The four-finger press: the menu at `fourFingerDuration`, Reset at `resetHold` (OwnerUIModel.resetHold). */
  static readonly fourFingerDuration = 1.2;
  static readonly resetHold = 10;

  private pointer: number | undefined;
  private cornerStart: number | undefined;
  private ringShown = false;
  private width = 1;
  private height = 1;

  constructor(readonly recognizer: TouchRecognizer, private readonly cb: TouchInputCallbacks) {}

  get isTracking(): boolean { return this.pointer !== undefined; }

  private emit(e: TouchGestureEvent | null | undefined): void { if (e) this.cb.onGesture(e, this.width, this.height); }

  down(id: number, x: number, y: number, t: number, width: number, height: number): void {
    this.cb.onAnyTouch?.();
    if (this.pointer !== undefined) { this.cancel(this.pointer); return; } // a second finger: nothing from this touch
    this.pointer = id;
    this.width = width;
    this.height = height;
    const excluded = x >= width - TouchInput.cornerSize && y >= height - TouchInput.cornerSize;
    this.recognizer.begin({ x, y }, t, excluded);
    if (excluded) this.cornerStart = t; else this.cb.onPress?.();
  }

  move(id: number, x: number, y: number, t: number): void {
    if (id === this.pointer) this.emit(this.recognizer.move({ x, y }, t));
  }

  /** Call every `tickInterval` while tracking: fires the hold, ends a stalled scratch, runs the corner hold. */
  tick(t: number): void {
    if (this.pointer === undefined) return;
    this.emit(this.recognizer.tick(t));
    if (this.cornerStart === undefined) return;
    const elapsed = t - this.cornerStart;
    if (elapsed >= TouchInput.cornerHold) {
      this.recognizer.cancel();
      this.reset();
      this.cb.onMenu();
      return;
    }
    if (elapsed >= TouchInput.ringDelay) {
      this.ringShown = true;
      this.cb.onCornerProgress?.(Math.min((elapsed - TouchInput.ringDelay) / (TouchInput.cornerHold - TouchInput.ringDelay), 1));
    }
  }

  up(id: number, x: number, y: number, t: number): void {
    if (id !== this.pointer) return;
    this.reset();
    this.emit(this.recognizer.end({ x, y }, t));
  }

  cancel(id: number): void {
    if (id !== this.pointer) return;
    this.recognizer.cancel();
    this.reset();
  }

  private reset(): void {
    this.pointer = undefined;
    if (this.ringShown) this.cb.onCornerProgress?.(null);
    this.ringShown = false;
    this.cornerStart = undefined;
  }

  /** Normalised gaze space around the face centre (x −1 left … 1 right, y −1 up … 1 down, clamped). */
  static normalised(p: V2, width: number, height: number): V2 {
    const hw = Math.max(width / 2, 1), hh = Math.max(height / 2, 1);
    return { x: Math.min(Math.max((p.x - hw) / hw, -1), 1), y: Math.min(Math.max((p.y - hh) / hh, -1), 1) };
  }

  /** Wires pointer events on `el` (seconds from performance.now()). Returns a detach function. */
  attach(el: HTMLElement): () => void {
    const now = () => performance.now() / 1000;
    let ticker: ReturnType<typeof setInterval> | undefined;
    const press = new FourFingerPress(() => this.cb.onMenu(), () => this.cb.onReset?.());
    const stopTicker = () => { if (ticker !== undefined && !this.isTracking) { clearInterval(ticker); ticker = undefined; } };
    const down = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      press.down(e.pointerId, e.clientX - r.left, e.clientY - r.top);
      this.down(e.pointerId, e.clientX - r.left, e.clientY - r.top, now(), r.width, r.height);
      if (this.pointer === e.pointerId) {
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        ticker ??= setInterval(() => { this.tick(now()); stopTicker(); }, TouchInput.tickInterval * 1000);
      }
      stopTicker();
    };
    const pos = (e: PointerEvent) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    const move = (e: PointerEvent) => { const [x, y] = pos(e); press.move(e.pointerId, x, y); this.move(e.pointerId, x, y, now()); };
    const lift = (id: number) => press.lift(id);
    const up = (e: PointerEvent) => { lift(e.pointerId); const [x, y] = pos(e); this.up(e.pointerId, x, y, now()); stopTicker(); };
    const cancel = (e: PointerEvent) => { lift(e.pointerId); this.cancel(e.pointerId); stopTicker(); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      if (ticker !== undefined) clearInterval(ticker);
      press.end();
    };
  }
}

/** The four-finger press (FaceScreen's UILongPressGestureRecognizer: 4 touches, `fourFingerDuration`,
 *  `allowableMovement` 40 pt): the menu once four fingers have stayed within 40 CSS px of where they came down for
 *  1.2 s, then Reset if the press is kept going to `resetHold` (movement no longer matters once it has begun, as in
 *  UIKit). A finger lifting below four, or a fifth finger, ends it. */
export class FourFingerPress {
  static readonly allowableMovement = 40;
  private readonly fingers = new Map<number, { x: number; y: number }>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private began = false;

  constructor(private readonly onMenu: () => void, private readonly onReset: () => void) {}

  down(id: number, x: number, y: number): void {
    this.fingers.set(id, { x, y });
    if (this.fingers.size === 4) {
      this.end();
      this.timers = [setTimeout(() => { this.began = true; this.onMenu(); }, TouchInput.fourFingerDuration * 1000),
        setTimeout(() => this.onReset(), TouchInput.resetHold * 1000)];
    } else if (this.fingers.size > 4) this.end();
  }

  move(id: number, x: number, y: number): void {
    const s = this.fingers.get(id);
    if (!s || this.began || this.timers.length === 0) return;
    if (Math.hypot(x - s.x, y - s.y) > FourFingerPress.allowableMovement) this.end();
  }

  lift(id: number): void { if (this.fingers.delete(id) && this.fingers.size < 4) this.end(); }

  end(): void {
    for (const h of this.timers) clearTimeout(h);
    this.timers = [];
    this.began = false;
  }
}
