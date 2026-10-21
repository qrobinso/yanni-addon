// The kiosk Settings screen: a port of OwnerSettingsView.swift (with PrivacySection, the Voice services rows that
// apply on the web, PupilReactionsSettingsPage, PINViews and the auto-close of OwnerUIModel). Every setting in the
// schema has a labelled control, in its group, with the schema default on a fresh install; developer-level tunables
// fold under "Advanced". Every control writes through the hub (origin `app`) one field at a time and follows
// changes from Home Assistant live (not while it has focus). While it is open Yanni stays awake and look-to-talk and
// proactive messages wait; it closes itself after 3 minutes untouched.
import { SETTING_GROUPS, SETTING_KEYS, isJsonObject, isValidSetting, settingDef, type SettingDef, type SettingGroup,
  type SettingKey, type Settings } from '@yanni/server/settings';
import type { AppContext } from '../app/AppContext';
import { OwnerAccess } from '../app/OwnerAccess';
import { PersonalityPreset } from '../emotion/EmotionSettings';
import { RenderStyle } from '../render/RenderStyle';
import { emotionSettings, perceptionSettings, turnTunables } from './SettingsAppliers';
import type { SettingsHub } from './SettingsHub';
import { developerStyle, linearToHex, StyleComposer } from './StyleComposer';
import './settings.css';

export interface PanelOptions {
  /** Where the layer goes (default: document.body). */
  root?: HTMLElement;
  appVersion?: string;
  /** Reset all settings (default: `resetAllSettings`-like hub reset + PIN clear, supplied by index.ts). */
  onReset?: () => void;
  /** The burn-in check (kiosk), when the app has one: Settings closes first. */
  burnInCheck?: () => void;
  /** Called when the panel closes (any reason). */
  onClose?: () => void;
  /** Seconds untouched before it closes itself. */
  idleTimeout?: number;
}

export interface SettingsPanel {
  readonly element: HTMLElement;
  close(): void;
}

/** OwnerUIModel: close after this long untouched; count as activity this often while open. */
export const SETTINGS_IDLE_TIMEOUT = 180;
export const SETTINGS_ACTIVITY_INTERVAL = 30;

type Kid = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k in e && !k.includes('-')) (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/** OwnerSettingsView's row order where the schema's order (fixed by the Home Assistant discovery order) differs. */
const ROW_ORDER: Partial<Record<SettingGroup, readonly SettingKey[]>> = {
  playfulness: ['personality', 'screen_antics', 'antics_frequency', 'expressive_reactions', 'reaction_budget_per_hour', 'idle_mood_drift'],
  sound: ['sounds', 'quiet_mode', 'chirp_volume', 'voice_volume', 'listening_sound', 'bedtime_sounds'],
  sleep: ['bedtime_schedule', 'bedtime_start', 'bedtime_end', 'bedtime', 'minutes_to_drowsy', 'minutes_to_asleep', 'taps_to_wake',
    'wake_on_motion_at_bedtime', 'bedtime_awake_minutes'],
  look: ['theme_preset', 'eyebrows', 'ink_brows', 'brow_intensity', 'mood_colour', 'mood_colour_strength', 'mood_background',
    'mood_background_strength', 'mood_background_vignette', 'mood_background_speed', 'mood_background_colour', 'colour_bursts',
    'burst_strength', 'mood_background_at_bedtime', 'listening_glow', 'custom_sclera_colour', 'custom_crescent_colour'],
  conversation: ['pipeline_id', 'conversation_agent_id', 'jev_config_entry_id', 'ai_task_entity_id', 'reply_voice',
    'listen_on_eye_contact', 'show_captions', 'asr_language', 'thinking_timeout_seconds', 'send_mood_note'],
};

/** OwnerSettingsView's rows that only make sense while another switch is on (shown, but disabled, so every setting
 *  is always listed). */
const ENABLED_WHEN: Partial<Record<SettingKey, (s: Settings) => boolean>> = {
  chirp_volume: (s) => s.sounds,
  listening_sound: (s) => s.sounds,
  mood_colour_strength: (s) => s.mood_colour,
  mood_background_strength: (s) => s.mood_background !== 'Black',
  mood_background_vignette: (s) => s.mood_background !== 'Black',
  mood_background_speed: (s) => s.mood_background === 'Mood',
  mood_background_colour: (s) => s.mood_background === 'Fixed colour',
  colour_bursts: (s) => s.mood_background === 'Mood',
  burst_strength: (s) => s.mood_background === 'Mood' && s.colour_bursts,
  mood_background_at_bedtime: (s) => s.mood_background !== 'Black',
  antics_frequency: (s) => s.screen_antics,
  pupil_intensity: (s) => s.pupil_reactions,
  reaction_budget_per_hour: (s) => s.expressive_reactions,
  bedtime_start: (s) => s.bedtime_schedule,
  bedtime_end: (s) => s.bedtime_schedule,
  self_restart_on_hang: (s) => s.restart_verified,
  maintenance_restart: (s) => s.restart_verified,
  tuning_style: (s) => s.pin_style,
};
for (const k of SETTING_KEYS) {
  if (/^pupil_(star|heart|note|question|exclaim)/.test(k)) ENABLED_WHEN[k] = (s) => s.pupil_reactions;
  if (/^game_/.test(k)) ENABLED_WHEN[k] = (s) => s.idle_games;
  if (/^antic_/.test(k)) ENABLED_WHEN[k] = (s) => s.screen_antics;
}

const percent = (v: number) => `${Math.round(v)} %`;
function valueText(def: SettingDef & { type: 'number' }, v: number): string {
  if (def.unit === '%') return percent(v);
  if (def.unit === '×') return `${v.toFixed(2)}×`;
  if (def.unit === 's') return v >= 60 && v % 60 === 0 ? `${v / 60} min` : `${Number(v.toFixed(v < 10 ? 3 : 0))} s`;
  if (def.unit === 'min') return v < 1 ? `${Math.round(v * 60)} s` : `${Number(v.toFixed(2))} min`;
  return `${Number(v.toFixed(3))}${def.unit ? ` ${def.unit}` : ''}`;
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The developer section as its subsystem sees it (defaults filled in), for editing. */
function expandedJson(k: SettingKey, s: Settings): Record<string, unknown> {
  switch (k) {
    case 'emotion_tunables': return emotionSettings(s).toJSON();
    case 'perception_tunables': return perceptionSettings(s).toJSON();
    case 'turn_tunables': return { ...turnTunables(s) };
    case 'tuning_style': return RenderStyle.encode(developerStyle(s));
    default: return s[k] as unknown as Record<string, unknown>;
  }
}

interface Control { key: SettingKey; row: HTMLElement; sync(s: Settings): void }

/** One labelled control for a setting, validated with the schema before it goes to the hub. */
function control(hub: SettingsHub, key: SettingKey): Control {
  const def = settingDef(key);
  const id = `ys-${key}`;
  const msg = el('span', { className: 'ys-msg', id: `${id}-msg`, role: 'status' });
  const describedBy = `${id}-msg${def.help ? ` ${id}-help` : ''}`;
  let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  let read: () => unknown;
  let write: (v: unknown, s: Settings) => void;
  let extra: Kid = null;
  switch (def.type) {
    case 'bool': {
      const i = el('input', { type: 'checkbox', id, role: 'switch' });
      read = () => i.checked;
      write = (v) => { i.checked = v === true; };
      input = i;
      break;
    }
    case 'number': {
      const slider = !def.integer && def.unit !== 'min' && def.unit !== '/h';
      const i = el('input', { type: slider ? 'range' : 'number', id, min: def.min, max: def.max, step: def.step, inputMode: 'decimal' });
      const out = el('output', { htmlFor: id, className: 'ys-value' });
      read = () => (i.value.trim() === '' ? Number.NaN : Number(i.value));
      // A stepper field shows its unit; a slider its formatted value.
      write = (v) => {
        i.value = String(v);
        out.textContent = slider ? valueText(def, Number(v)) : (def.unit ?? '');
        if (slider) i.setAttribute('aria-valuetext', out.textContent);
      };
      if (slider) i.addEventListener('input', () => { out.textContent = valueText(def, Number(i.value)); i.setAttribute('aria-valuetext', out.textContent); });
      extra = out;
      input = i;
      break;
    }
    case 'time': {
      const i = el('input', { type: 'time', id, step: 60 });
      read = () => { const [h, m] = i.value.split(':').map(Number); return h! * 60 + m!; };
      write = (v) => { i.value = hhmm(Number(v)); };
      input = i;
      break;
    }
    case 'enum': {
      const sel = el('select', { id }, ...def.options.map((o, n) => el('option', { value: o }, def.labels?.[n] ?? o)));
      read = () => sel.value;
      write = (v) => { sel.value = String(v); };
      input = sel;
      break;
    }
    case 'color': {
      const i = el('input', { type: 'color', id });
      read = () => i.value.toLowerCase();
      // An optional colour follows the style until one is picked (Swift: the preset's colour shows).
      write = (v, s) => {
        const style = StyleComposer.compose(s);
        i.value = v ? String(v) : key === 'custom_sclera_colour' ? linearToHex(style.scleraColor)
          : key === 'custom_crescent_colour' ? linearToHex(style.crescentColor) : '#000000';
      };
      if (def.optional) {
        const reset = el('button', { type: 'button', className: 'ys-link', onclick: () => hub.update('app', { [key]: '' } as Partial<Settings>) }, 'Use preset');
        extra = reset;
        const w0 = write;
        write = (v, s) => { w0(v, s); reset.disabled = !v; };
      }
      input = i;
      break;
    }
    case 'text': {
      const i = el('input', { type: 'text', id, maxLength: def.maxLength, required: def.required, autocomplete: 'off',
        autocapitalize: 'off', spellcheck: false });
      read = () => i.value.trim();
      write = (v) => { i.value = String(v); };
      input = i;
      break;
    }
    case 'json': {
      const t = el('textarea', { id, rows: 6, spellcheck: false, autocapitalize: 'off', className: 'ys-json' });
      read = () => { try { return JSON.parse(t.value); } catch { return undefined; } };
      write = (_v, s) => { t.value = JSON.stringify(expandedJson(key, s), null, 1); };
      const reset = el('button', { type: 'button', className: 'ys-link', onclick: () => hub.update('app', { [key]: {} } as Partial<Settings>) }, 'Defaults');
      extra = reset;
      input = t;
      break;
    }
  }
  input.setAttribute('aria-describedby', describedBy);
  input.addEventListener('change', () => {
    const v = read();
    const ok = def.type === 'json' ? isJsonObject(v) : isValidSetting(def, v);
    if (!ok) {
      input.setAttribute('aria-invalid', 'true');
      msg.textContent = def.type === 'number' ? `Between ${def.min} and ${def.max}${def.integer ? ', whole numbers' : ''}`
        : def.type === 'json' ? 'Not a JSON object (or too large)' : def.type === 'text' && def.required ? 'Can’t be empty' : 'Not a valid value';
      return;
    }
    input.removeAttribute('aria-invalid');
    msg.textContent = '';
    hub.update('app', { [key]: v } as Partial<Settings>);
  });
  const label = el('label', { htmlFor: id }, def.label);
  const row = def.type === 'bool'
    ? el('div', { className: 'ys-row ys-check' }, label, input, msg)
    : el('div', { className: `ys-row${def.type === 'json' ? ' ys-wide' : ''}` }, label, el('span', { className: 'ys-input' }, input, extra), msg);
  if (def.help) row.append(el('p', { className: 'ys-help', id: `${id}-help` }, def.help));
  const enabledWhen = ENABLED_WHEN[key];
  return {
    key, row,
    sync(s) {
      if (document.activeElement !== input) write(s[key], s);
      const on = enabledWhen ? enabledWhen(s) : true;
      // Room understanding: shown, never available (no encrypted vision path).
      input.disabled = key === 'room_understanding' || !on;
      row.classList.toggle('ys-off', input.disabled);
    },
  };
}

/** The PIN pad (PINEntryView / PINSetupView): four digits in a numeric field. */
function pinField(id: string, label: string): { field: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { type: 'password', id, inputMode: 'numeric', pattern: '[0-9]*', maxLength: OwnerAccess.pinLength,
    autocomplete: 'off', className: 'ys-pin' });
  return { field: el('div', { className: 'ys-row' }, el('label', { htmlFor: id }, label), input), input };
}

/** Opens Settings (asking for the PIN first when one is set). */
export function openSettingsPanel(ctx: AppContext, hub: SettingsHub, access: OwnerAccess, opts: PanelOptions = {}): SettingsPanel {
  const root = opts.root ?? document.body;
  const layer = el('div', { className: 'ys-layer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ys-title' });
  const sheet = el('div', { className: 'ys-sheet' });
  layer.append(sheet);
  const controls: Control[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  let closed = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const conversation = ctx.conversation;
  const wasSuppressed = conversation?.isSuppressed ?? false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    for (const t of timers) clearInterval(t);
    off();
    if (conversation) conversation.isSuppressed = wasSuppressed;
    ctx.settingsOpen = false;
    layer.remove();
    opts.onClose?.();
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(close, (opts.idleTimeout ?? SETTINGS_IDLE_TIMEOUT) * 1000);
  };
  for (const t of ['pointerdown', 'keydown', 'input', 'wheel', 'scroll']) layer.addEventListener(t, touch, { capture: true, passive: true });
  layer.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // While Settings is open: look-to-talk and proactive delivery wait, and Yanni doesn't doze off behind it.
  if (conversation) conversation.isSuppressed = true;
  ctx.settingsOpen = true;
  ctx.life.noteActivity('other');
  timers.push(setInterval(() => ctx.life.noteActivity('other'), SETTINGS_ACTIVITY_INTERVAL * 1000));
  const off = hub.subscribe(() => { for (const c of controls) c.sync(hub.settings); });

  const show = (...kids: Kid[]) => {
    sheet.replaceChildren(...kids.filter((k): k is Node | string => !!k));
    sheet.querySelector<HTMLElement>('input, select, button, textarea')?.focus();
  };
  const header = (title: string, done = true) => el('header', { className: 'ys-head' },
    el('h2', { id: 'ys-title' }, title), done ? el('button', { type: 'button', className: 'ys-done', onclick: close }, 'Done') : null);

  // ---- PIN entry before Settings ----
  const askPIN = () => {
    const { field, input } = pinField('ys-pin-entry', 'Enter PIN');
    const note = el('p', { className: 'ys-help', role: 'alert' }, 'to open Settings');
    const form = el('form', { className: 'ys-pinform' }, header('Settings'), field, note,
      el('div', { className: 'ys-buttons' }, el('button', { type: 'submit' }, 'Unlock'), el('button', { type: 'button', onclick: close }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = await access.verify(input.value);
      input.value = '';
      if (v === 'ok') return showSettings();
      note.textContent = v === 'wrong' ? `Wrong PIN. ${OwnerAccess.maxTries - access.failures} tries left.`
        : `Too many tries. Try again in ${Math.ceil(v.locked)} s.`;
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) input.animate?.([{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'none' }], 240);
    });
    show(form);
  };

  // ---- Set or change the PIN: enter it twice ----
  const setupPIN = (back: () => void) => {
    let first: string | undefined;
    const { field, input } = pinField('ys-pin-new', 'Choose a 4-digit PIN');
    const label = field.querySelector('label')!;
    const note = el('p', { className: 'ys-help', role: 'alert' }, 'It will be asked before Settings and Tuning.');
    const form = el('form', { className: 'ys-pinform' }, header('PIN', false), field, note,
      el('div', { className: 'ys-buttons' }, el('button', { type: 'submit' }, 'Next'), el('button', { type: 'button', onclick: back }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = input.value;
      input.value = '';
      if (!OwnerAccess.isWellFormed(pin)) { note.textContent = 'Use four digits.'; return; }
      if (first === undefined) { first = pin; label.textContent = 'Enter it again'; note.textContent = ''; return; }
      if (first !== pin) { first = undefined; label.textContent = 'Choose a 4-digit PIN'; note.textContent = 'Those didn’t match. Start again.'; return; }
      if (await access.setPIN(pin)) { hub.update('app', { pin_prompt_shown: true }); back(); }
      else { first = undefined; label.textContent = 'Choose a 4-digit PIN'; note.textContent = OwnerAccess.available ? 'The PIN couldn’t be saved. Try again.' : 'An owner PIN needs HTTPS.'; }
    });
    show(form);
  };

  // ---- Reset, confirmed by typing RESET ----
  const confirmReset = () => {
    const input = el('input', { type: 'text', id: 'ys-reset', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false });
    const go = el('button', { type: 'submit', className: 'ys-danger', disabled: true }, 'Reset all settings');
    input.addEventListener('input', () => { go.disabled = input.value.trim() !== 'RESET'; });
    const form = el('form', { className: 'ys-pinform' }, header('Reset', false),
      el('p', {}, 'Every setting goes back to its default and the PIN is forgotten. The display stays paired, so Home Assistant keeps the same device and entities.'),
      el('div', { className: 'ys-row' }, el('label', { htmlFor: 'ys-reset' }, 'Type RESET to confirm'), input),
      el('div', { className: 'ys-buttons' }, go, el('button', { type: 'button', onclick: showSettings }, 'Cancel')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim() !== 'RESET') return;
      (opts.onReset ?? (() => { access.clearPIN(); hub.resetToDefaults(); }))();
      close();
    });
    show(form);
  };

  // ---- The screen ----
  function showSettings(): void {
    controls.length = 0;
    const s = hub.settings;
    const make = (k: SettingKey) => { const c = control(hub, k); controls.push(c); return c.row; };
    const keysOf = (g: SettingGroup) => SETTING_KEYS.filter((k) => settingDef(k).group === g);
    const section = (g: (typeof SETTING_GROUPS)[number], before: Kid[] = [], after: Kid[] = []) => {
      const keys = keysOf(g.id);
      const order = ROW_ORDER[g.id];
      if (order) keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const main = keys.filter((k) => !settingDef(k).advanced);
      const adv = keys.filter((k) => settingDef(k).advanced);
      return el('section', { className: 'ys-section', 'aria-labelledby': `ys-g-${g.id}` },
        el('h3', { id: `ys-g-${g.id}` }, g.title), ...before, ...main.flatMap((k) => [make(k), ...(rowAfter[k] ?? [])]), ...after,
        adv.length ? el('details', { className: 'ys-adv' }, el('summary', {}, main.length ? 'Advanced' : `Show ${adv.length} settings`), ...adv.map(make)) : null,
        g.note && g.id !== 'yanni' ? el('p', { className: 'ys-note' }, g.note) : null);
    };
    const rowAfter: Partial<Record<SettingKey, Node[]>> = {
      personality: [el('p', { className: 'ys-help', id: 'ys-personality' }, PersonalityPreset.summary(s.personality))],
    };
    const special: Partial<Record<SettingGroup, [Kid[], Kid[]]>> = {
      yanni: [[], [el('p', { className: 'ys-help', id: 'ys-room-preview' }, `Home Assistant shows this display as “Yanni ${s.room}”.`)]],
      sleep: [[sleepReadout(), el('div', { className: 'ys-buttons' },
        el('button', { type: 'button', onclick: () => ctx.life.forceSleep() }, 'Put to sleep'),
        el('button', { type: 'button', onclick: () => ctx.life.forceWake() }, 'Wake up'))], []],

      conversation: [[statusRow('Home Assistant', () => ctx.client ? (ctx.client.haConnected ? 'Connected through the add-on' : 'Not connected (the add-on manages the connection)') : 'Not paired')],
        [personaSnippet()]],
      home: [[statusRow('Add-on', () => ctx.client ? `${ctx.client.status}${ctx.client.room ? ` · “Yanni ${ctx.client.room}”` : ''}` : 'Not paired')], []],
      access: [[accessRows()], []],
      kiosk: [[], opts.burnInCheck ? [el('button', { type: 'button', onclick: () => { close(); opts.burnInCheck!(); } }, 'Burn-in check'),
        el('p', { className: 'ys-help' }, 'Shows dark grey, mid grey, red, green, blue and a grey ramp, 20 seconds each. Tap the screen to stop.')] : []],
    };
    const sections = SETTING_GROUPS.map((g) => section(g, ...(special[g.id] ?? [[], []])));
    const about = el('section', { className: 'ys-section', 'aria-labelledby': 'ys-g-about' }, el('h3', { id: 'ys-g-about' }, 'About'),
      statusRow('Version', () => opts.appVersion ?? '–'), statusRow('Display', () => ctx.client?.deviceId ? `yanni_${ctx.client.deviceId}` : '–'),
      el('button', { type: 'button', className: 'ys-danger', onclick: confirmReset }, 'Reset all settings…'),
      el('p', { className: 'ys-note' }, 'Reset keeps the pairing, so Home Assistant still recognises this Yanni afterwards.'));
    show(header('Settings'), el('div', { className: 'ys-body' }, ...sections, about));
    for (const c of controls) c.sync(hub.settings);
    // Live text that follows other settings.
    controls.push({ key: 'room', row: sheet, sync: (x) => {
      const p = sheet.querySelector('#ys-room-preview');
      if (p) p.textContent = `Home Assistant shows this display as “Yanni ${x.room}”.`;
      const q = sheet.querySelector('#ys-personality');
      if (q) q.textContent = PersonalityPreset.summary(x.personality);
    } });
    // First open: offer a PIN once (skippable; marked shown either way).
    if (!hub.settings.pin_prompt_shown && !access.isPINRequired && OwnerAccess.available) {
      hub.update('app', { pin_prompt_shown: true });
      const prompt = el('div', { className: 'ys-prompt', role: 'alertdialog', 'aria-labelledby': 'ys-prompt-t' },
        el('h3', { id: 'ys-prompt-t' }, 'Set a PIN?'),
        el('p', {}, 'A 4-digit PIN keeps curious hands out of Settings. Status stays open to everyone.'),
        el('div', { className: 'ys-buttons' }, el('button', { type: 'button', onclick: () => setupPIN(showSettings) }, 'Set a PIN'),
          el('button', { type: 'button', onclick: () => prompt.remove() }, 'Not now')));
      sheet.querySelector('.ys-head')!.after(prompt);
      prompt.querySelector('button')?.focus();
    }
  }

  function statusRow(label: string, value: () => string): HTMLElement {
    const v = el('span', { className: 'ys-value' }, value());
    timers.push(setInterval(() => { v.textContent = value(); }, 1000));
    return el('div', { className: 'ys-row' }, el('span', {}, label), v);
  }

  function sleepReadout(): HTMLElement {
    const names = { awake: 'Awake', drowsy: 'Drowsy', asleep: 'Asleep', halfAwake: 'Half awake', waking: 'Waking up' } as const;
    return statusRow('Now', () => {
      const l = ctx.life;
      const parts: string[] = [names[l.phase]];
      if (l.isForceSleepActive) parts.push('put to sleep');
      else if (l.isBedtime) parts.push('bedtime');
      return parts.join(' · ');
    });
  }

  function accessRows(): HTMLElement {
    const box = el('div', {});
    const render = () => {
      const required = access.isPINRequired;
      const toggle = el('input', { type: 'checkbox', id: 'ys-pin-required', role: 'switch', checked: required, disabled: !OwnerAccess.available });
      toggle.addEventListener('change', () => {
        if (toggle.checked) setupPIN(showSettings); else { access.clearPIN(); render(); }
      });
      box.replaceChildren(el('div', { className: 'ys-row ys-check' }, el('label', { htmlFor: 'ys-pin-required' }, 'Require a PIN'), toggle),
        ...(required ? [el('button', { type: 'button', onclick: () => setupPIN(showSettings) }, 'Change PIN')] : []),
        ...(OwnerAccess.available ? [] : [el('p', { className: 'ys-help' }, 'An owner PIN needs HTTPS.')]));
    };
    render();
    return box;
  }

  function personaSnippet(): HTMLElement {
    const text = () => {
      const room = hub.settings.room.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '_');
      return `You are Yanni, a small, playful, warm creature who lives in a tablet and is only two big expressive eyes. Children may be listening: be kind, never scary or crude. Answer in one to three short spoken sentences, natural and warm. No markdown, lists, emoji or stage directions. You can't see anything unless it's stated, and you can't show pictures, timers or cards. Right now: {{ states('sensor.yanni_${room}_conversation_context') }}. Let it colour your tone; never read it out.`;
    };
    const pre = el('pre', { className: 'ys-snippet', id: 'ys-persona' }, text());
    const copy = el('button', { type: 'button', className: 'ys-link', onclick: async () => {
      try { await navigator.clipboard.writeText(text()); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select the text to copy'; }
    } }, 'Copy');
    return el('details', { className: 'ys-adv' }, el('summary', {}, 'Persona for your agent’s instructions'), pre, copy);
  }

  root.append(layer);
  touch();
  if (access.isPINRequired) askPIN(); else showSettings();
  return { element: layer, close };
}
