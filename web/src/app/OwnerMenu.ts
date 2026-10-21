// The hidden owner ways in (port of FaceScreen.swift's CornerMenu / OwnerUIModel and PINViews.swift's
// ResetConfirmView): the corner ring while the corner is held, then a menu of Settings · Status · Tuning (developer
// tools only) · HUD · Reload. Settings and Tuning sit behind the optional PIN (Status never: it's read-only). The menu
// closes itself after 5 s untouched, Settings after 3 min. Reset all settings (typed RESET) is reached from Settings
// or by holding a four-finger press for 10 s (the forgotten-PIN escape hatch). The full Settings, Status and Tuning
// screens come from the settings hub and the owner tools when they are built in (`external`); the panels here are the
// fallback.
import { SETTINGS_CHECKS, type EntitySettings } from '@yanni/server/protocol';
import { OwnerAccess } from './OwnerAccess';

export type OwnerDestination = 'settings' | 'status' | 'tuning';

export interface OwnerMenuDeps {
  access: OwnerAccess;
  developerTools(): boolean;
  setDeveloperTools(on: boolean): void;
  settings(): Partial<EntitySettings>;
  /** A setting changed on the display (already validated). */
  changeSetting<K extends keyof EntitySettings>(key: K, value: EntitySettings[K]): void;
  status(): [string, string][];
  toggleHud(): void;
  /** The owner's "Wrong reaction" (counts a perception false positive); returns the message to show. */
  wrongReaction(): string;
  /** Reset all settings (after typed RESET). */
  resetAll(): void;
  /** The Settings screen opened or closed (look-to-talk and announcements pause while it is open). */
  onSettingsOpenChange(open: boolean): void;
  /** Full screens from the settings hub / owner tools; each takes over its destination when present. */
  external?: Partial<Record<OwnerDestination, () => void>>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: object = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

export class OwnerMenu {
  static readonly menuTimeout = 5;
  static readonly settingsIdleTimeout = 180;

  private readonly ring = el('div', { className: 'corner-ring', hidden: true });
  private layer: HTMLElement | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timeout = 0;
  private settingsShown = false;

  constructor(private readonly root: HTMLElement, private readonly deps: OwnerMenuDeps) {
    this.ring.setAttribute('aria-hidden', 'true');
    root.append(this.ring);
  }

  get isOpen(): boolean { return this.layer !== undefined; }

  /** Corner hold progress 0…1, or null to hide the ring. */
  progress(p: number | null): void {
    this.ring.hidden = p === null;
    if (p !== null) this.ring.style.setProperty('--p', String(p));
  }

  showMenu(): void {
    const b = (label: string, act: () => void) => el('button', { type: 'button', onclick: act }, label);
    const items = [
      b('Settings', () => this.go('settings')),
      b('Status', () => this.go('status')),
      ...(this.deps.developerTools() ? [b('Tuning', () => this.go('tuning'))] : []),
      b('HUD', () => { this.close(); this.deps.toggleHud(); }),
      b('Reload', () => location.reload()),
    ];
    this.present(el('nav', { className: 'owner-menu', ariaLabel: 'Owner menu' }, ...items), OwnerMenu.menuTimeout);
  }

  close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.layer?.remove();
    this.layer = undefined;
    this.setSettingsShown(false);
  }

  /** Any touch on the face (an owner screen's idle timer restarts). */
  noteTouch(): void { if (this.layer) this.restartTimer(); }

  /** Opens a destination, asking for the PIN first when one is set (Status never). */
  open(d: OwnerDestination): void { this.go(d); }

  /** Reset all settings: typed RESET confirms. Also clears the PIN, so it is never behind it. */
  showReset(): void {
    const input = el('input', { type: 'text', id: 'owner-reset', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false });
    const reset = el('button', { type: 'button', disabled: true, className: 'owner-destructive', onclick: () => {
      this.close();
      this.deps.resetAll();
    } }, 'Reset all settings');
    input.addEventListener('input', () => { reset.disabled = input.value.trim() !== 'RESET'; });
    this.present(this.panel('Reset all settings',
      el('p', {}, 'Every setting goes back to its default. The PIN is forgotten, the greeting clips are deleted and waiting '
        + 'announcements are dropped. The Home Assistant device itself is kept, so Yanni keeps its entities.'),
      el('label', { htmlFor: 'owner-reset' }, 'Type RESET to confirm'), input, reset), OwnerMenu.settingsIdleTimeout);
  }

  private setSettingsShown(on: boolean): void {
    if (on === this.settingsShown) return;
    this.settingsShown = on;
    this.deps.onSettingsOpenChange(on);
  }

  /** Puts `content` over the face in a dismissable layer that closes after `timeout` seconds untouched. */
  private present(content: HTMLElement, timeout: number): void {
    this.close();
    const layer = el('div', { className: 'owner-layer' }, content);
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.addEventListener('pointerdown', (e) => { if (e.target === layer) this.close(); });
    layer.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    for (const t of ['pointerdown', 'keydown', 'input']) layer.addEventListener(t, () => this.restartTimer(), { capture: true });
    this.layer = layer;
    this.timeout = timeout;
    this.root.append(layer);
    this.restartTimer();
    layer.querySelector<HTMLElement>('button, input, select')?.focus();
  }

  private restartTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), this.timeout * 1000);
  }

  private go(d: OwnerDestination): void {
    if (d !== 'status' && this.deps.access.isPINRequired) this.askPIN(d); else this.show(d);
  }

  private askPIN(d: OwnerDestination): void {
    const input = el('input', { type: 'password', inputMode: 'numeric', maxLength: OwnerAccess.pinLength, autocomplete: 'off', id: 'owner-pin' });
    const msg = el('p', { className: 'owner-msg' });
    msg.setAttribute('role', 'alert');
    const form = el('form', { className: 'owner-panel' }, el('h2', {}, d === 'settings' ? 'Settings' : 'Tuning'),
      el('label', { htmlFor: 'owner-pin' }, 'Owner PIN'), input, el('button', { type: 'submit' }, 'Unlock'), msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = await this.deps.access.verify(input.value);
      if (v === 'ok') return this.show(d);
      input.value = '';
      msg.textContent = v === 'wrong' ? 'Wrong PIN' : `Too many tries. Wait ${Math.ceil(v.locked)} s.`;
    });
    this.present(form, OwnerMenu.menuTimeout * 6);
  }

  private show(d: OwnerDestination): void {
    const external = this.deps.external?.[d];
    if (external) { this.close(); external(); return; }
    if (d === 'settings') {
      this.present(this.settingsPanel(), OwnerMenu.settingsIdleTimeout);
      this.setSettingsShown(true);
      return;
    }
    if (d === 'status') {
      const dl = el('dl');
      for (const [k, v] of this.deps.status()) dl.append(el('dt', {}, k), el('dd', {}, v));
      const msg = el('p', { className: 'owner-msg' });
      msg.setAttribute('role', 'status');
      const wrong = el('button', { type: 'button', onclick: () => { msg.textContent = this.deps.wrongReaction(); } }, 'Wrong reaction');
      return this.present(this.panel('Status', dl, wrong, msg), OwnerMenu.settingsIdleTimeout);
    }
    const a = (href: string, label: string) => el('a', { href }, label);
    this.present(this.panel('Tuning', el('p', {}, a('render-demo.html', 'Renderer'), ' · ', a('turn-demo.html', 'Turn detection'))),
      OwnerMenu.settingsIdleTimeout);
  }

  private panel(title: string, ...body: Node[]): HTMLElement {
    return el('section', { className: 'owner-panel' }, el('h2', {}, title), ...body,
      el('button', { type: 'button', onclick: () => this.close() }, 'Done'));
  }

  /** The settings Home Assistant also sees, as the display has them; each change is validated before it is sent.
   *  shortcut: shows only the keys the display already has values for, typed by value; WP13 brings the real Settings. */
  private settingsPanel(): HTMLElement {
    const form = el('div', { className: 'owner-fields' });
    const s = this.deps.settings();
    for (const key of Object.keys(SETTINGS_CHECKS) as (keyof EntitySettings)[]) {
      const value = s[key];
      if (value === undefined) continue;
      const id = `set-${key}`;
      const input = el('input', { id });
      if (typeof value === 'boolean') { input.type = 'checkbox'; input.checked = value; } else {
        input.type = typeof value === 'number' ? 'number' : 'text';
        input.value = String(value);
      }
      input.addEventListener('change', () => {
        const v = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
        if (SETTINGS_CHECKS[key](v)) this.deps.changeSetting(key, v as never);
        else input.setAttribute('aria-invalid', 'true');
      });
      form.append(el('label', { htmlFor: id }, key.replaceAll('_', ' ')), input);
    }
    const dev = el('input', { type: 'checkbox', id: 'set-dev', checked: this.deps.developerTools() });
    dev.addEventListener('change', () => this.deps.setDeveloperTools(dev.checked));
    form.append(el('label', { htmlFor: 'set-dev' }, 'developer tools'), dev);
    return this.panel('Settings', form, this.pinControls(),
      el('button', { type: 'button', className: 'owner-destructive', onclick: () => this.showReset() }, 'Reset all settings…'));
  }

  private pinControls(): HTMLElement {
    const access = this.deps.access;
    const box = el('div', { className: 'owner-fields' });
    if (!OwnerAccess.available) { box.append(el('p', {}, 'An owner PIN needs HTTPS.')); return box; }
    const input = el('input', { type: 'password', inputMode: 'numeric', maxLength: 4, id: 'set-pin', autocomplete: 'new-password' });
    const msg = el('p', { className: 'owner-msg' });
    box.append(el('label', { htmlFor: 'set-pin' }, access.isPINRequired ? 'new owner PIN' : 'owner PIN'), input,
      el('button', { type: 'button', onclick: async () => {
        msg.textContent = await access.setPIN(input.value) ? 'PIN set' : 'Use four digits';
        input.value = '';
      } }, 'Set PIN'),
      ...(access.isPINRequired ? [el('button', { type: 'button', onclick: () => { access.clearPIN(); msg.textContent = 'PIN removed'; } }, 'Remove PIN')] : []),
      msg);
    return box;
  }
}
