// The owner pages on Ingress: Displays (pair, rename, revoke), Settings and Status per display, Announcements (a test
// message) and Help (kiosk setup). Plain DOM; built by esbuild into public/app.js (`npm run owner -w server`). Every
// URL is relative, so the pages work under Home Assistant's ingress path. Text from the server goes in with
// textContent only.
import { SETTINGS_CHECKS, type DisplayState, type DisplayStatus, type EntitySettings } from '../src/protocol.js';
import { SETTING_GROUPS, SETTING_KEYS, settingDef, type SettingDef, type SettingKey } from '../src/settingsSchema.js';

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener);
    else if (k in e && !k.includes('-')) (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

interface Overview {
  ha: boolean; mqtt: boolean; defaultRoom: string;
  devices: { id: string; room: string; pairedAt: string; online: boolean }[];
  codes: { code: string; room: string; expiresAt: number }[];
}
interface Detail { device: { id: string; room: string; pairedAt: string }; settings: EntitySettings; status: DisplayStatus | null }

async function api<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const r = await fetch(path, init && { method: init.method, headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? `HTTP ${r.status}`), { key: data.key });
  return data as T;
}

const main = document.getElementById('main')!;
const head = document.getElementById('head')!;
let overview: Overview | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

const PAGES = [['displays', 'Displays'], ['settings', 'Settings'], ['status', 'Status'], ['announce', 'Announcements'],
  ['help', 'Help']] as const;
type Page = (typeof PAGES)[number][0];

function route(): { page: Page; id?: string } {
  const [p, id] = location.hash.replace(/^#\/?/, '').split('/');
  return { page: (PAGES.some(([k]) => k === p) ? p : 'displays') as Page, id: id && /^[0-9a-f]{8}$/.test(id) ? id : undefined };
}

async function render(): Promise<void> {
  clearInterval(timer);
  const { page, id } = route();
  try { overview = await api<Overview>('api/status'); } catch (e) { main.replaceChildren(h('p', { className: 'err', role: 'alert' }, (e as Error).message)); return; }
  head.replaceChildren(
    h('h1', {}, 'Yanni'),
    h('p', { className: 'muted' }, `Home Assistant: ${overview.ha ? 'connected' : 'not connected'} · MQTT: ${overview.mqtt ? 'on' : 'no broker'}`),
    h('nav', { 'aria-label': 'Pages' }, ...PAGES.map(([k, label]) =>
      h('a', { href: `#/${k}${id && k !== 'displays' && k !== 'help' ? `/${id}` : ''}`, 'aria-current': k === page ? 'page' : undefined }, label))),
  );
  const d = id ?? overview.devices[0]?.id;
  if (page === 'displays') return displaysPage();
  if (page === 'help') return helpPage();
  if (!d) { main.replaceChildren(h('p', {}, 'No display is paired yet. ', h('a', { href: '#/displays' }, 'Pair one first.'))); return; }
  const picker = displayPicker(page, d);
  if (page === 'settings') return settingsPage(d, picker);
  if (page === 'status') return statusPage(d, picker);
  return announcePage(d, picker);
}

function displayPicker(page: Page, id: string): HTMLElement {
  if (overview!.devices.length < 2) return h('span');
  const sel = h('select', { id: 'display-pick', onchange: () => { location.hash = `#/${page}/${sel.value}`; } },
    ...overview!.devices.map((x) => h('option', { value: x.id, selected: x.id === id }, `Yanni ${x.room}`)));
  return h('p', {}, h('label', { htmlFor: 'display-pick' }, 'Display '), sel);
}

const ago = (iso?: string) => iso ? new Date(iso).toLocaleString() : '—';

// ---- Displays ----

function displaysPage(): void {
  const o = overview!;
  const room = h('input', { id: 'room', required: true, maxLength: 40, value: o.defaultRoom });
  const install = h('input', { id: 'install', maxLength: 64, pattern: '[0-9a-fA-F-]{8,64}' });
  const err = h('span', { className: 'err', role: 'alert' });
  const form = h('form', { onsubmit: async (e: Event) => {
    e.preventDefault();
    try { await api('api/codes', { method: 'POST', body: { room: room.value, installId: install.value || undefined } }); render(); }
    catch (x) { err.textContent = (x as Error).message; }
  } },
  h('label', { htmlFor: 'room' }, 'Room'), room,
  h('details', {}, h('summary', { className: 'muted' }, 'Moving from the iPad app?'),
    h('label', { htmlFor: 'install' }, 'Install ID (iPad Settings → Status; keeps its Home Assistant entities)'), install),
  h('button', {}, 'Make a pairing code'), ' ', err);

  const rows = o.devices.map((d) => {
    const name = h('input', { value: d.room, maxLength: 40, 'aria-label': `Room for yanni_${d.id}` });
    const msg = h('span', { className: 'muted', role: 'status' });
    return h('tr', {},
      h('td', {}, name, ' ', h('button', { type: 'button', onclick: async () => {
        if (!SETTINGS_CHECKS.room(name.value.trim())) { msg.textContent = 'Use 1–40 characters'; return; }
        try { await api(`api/devices/${d.id}/settings`, { method: 'PUT', body: { values: { room: name.value.trim() } } }); msg.textContent = 'Saved'; }
        catch (x) { msg.textContent = (x as Error).message; }
      } }, 'Rename'), ' ', msg),
      h('td', { className: 'muted' }, `yanni_${d.id}`),
      h('td', {}, h('span', { className: d.online ? 'ok' : 'muted' }, d.online ? 'online' : 'offline')),
      h('td', {}, h('a', { href: `#/settings/${d.id}` }, 'Settings'), ' · ', h('a', { href: `#/status/${d.id}` }, 'Status')),
      h('td', {}, h('button', { type: 'button', className: 'danger', onclick: async () => {
        if (!confirm(`Revoke Yanni ${d.room}? It is removed from Home Assistant and must pair again.`)) return;
        await api(`api/devices/${d.id}`, { method: 'DELETE' }).catch(() => {});
        render();
      } }, 'Revoke')));
  });
  main.replaceChildren(
    h('h2', {}, 'Pair a display'),
    h('p', { className: 'muted' }, 'Open the display address on the tablet (see Help), then enter the code there. Codes work once and expire after 10 minutes.'),
    form,
    ...o.codes.map((c) => h('p', {}, h('span', { className: 'code' }, c.code), ' ',
      h('span', { className: 'muted' }, `${c.room}, until ${new Date(c.expiresAt).toLocaleTimeString()}`))),
    h('h2', {}, 'Displays'),
    h('table', {}, h('thead', {}, h('tr', {}, ...['Room', 'Node', 'Status', '', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...(rows.length ? rows : [h('tr', {}, h('td', { colSpan: 5, className: 'muted' }, 'None yet.'))]))),
  );
  timer = setInterval(async () => {
    // Codes and online state change without the owner: refresh unless they are typing.
    if (!main.contains(document.activeElement) || document.activeElement === document.body) render();
  }, 5000);
}

// ---- Settings ----

const minutesToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** One labelled control for a setting; `save` validates with the shared check and reports errors next to it. */
function control(key: SettingKey, def: SettingDef, value: unknown, save: (key: SettingKey, v: unknown) => Promise<string | undefined>):
  { row: HTMLElement; set(v: unknown): void } {
  const id = `set-${key}`;
  const msg = h('span', { className: 'note', role: 'status', id: `${id}-msg` });
  let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  let extra: Kid = null;
  let read: () => unknown;
  let set: (v: unknown) => void;
  switch (def.type) {
    case 'bool': {
      const i = h('input', { type: 'checkbox', id });
      read = () => i.checked; set = (v) => { i.checked = v === true; };
      // Room understanding: off always works here; on only on the display (consent, and no vision path yet).
      if (key === 'room_understanding') set = (v) => { i.checked = v === true; i.disabled = v !== true; };
      input = i;
      break;
    }
    case 'number': {
      const i = h('input', { type: 'number', id, min: def.min, max: def.max, step: def.step, inputMode: 'decimal' });
      read = () => (i.value.trim() === '' ? Number.NaN : Number(i.value)); set = (v) => { i.value = String(v); };
      input = i;
      break;
    }
    case 'time': {
      const i = h('input', { type: 'time', id, step: 60 });
      read = () => { const [hh, mm] = i.value.split(':').map(Number); return hh! * 60 + mm!; };
      set = (v) => { i.value = minutesToHHMM(Number(v)); };
      input = i;
      break;
    }
    case 'enum': {
      const s = h('select', { id }, ...def.options.map((o, n) => h('option', { value: o }, def.labels?.[n] ?? o)));
      read = () => s.value; set = (v) => { s.value = String(v); };
      input = s;
      break;
    }
    case 'color': {
      const i = h('input', { type: 'color', id });
      read = () => i.value.toLowerCase(); set = (v) => { i.value = v ? String(v) : '#000000'; };
      if (def.optional) {
        // '' = the display's style colour (no preview here: the style is composed on the display).
        const note = h('span', { className: 'muted' });
        const reset = h('button', { type: 'button', onclick: async () => {
          msg.textContent = 'Saving…'; msg.textContent = (await save(key, '')) ?? 'Saved';
        } }, 'Use preset');
        const s0 = set;
        set = (v) => { s0(v); note.textContent = v ? '' : ' (preset)'; reset.disabled = !v; };
        extra = h('span', {}, note, ' ', reset);
      }
      input = i;
      break;
    }
    case 'json': {
      const t = h('textarea', { id, rows: 5, spellcheck: false, className: 'json' });
      read = () => { try { return JSON.parse(t.value); } catch { return undefined; } };
      set = (v) => { t.value = JSON.stringify(v ?? {}, null, 1); };
      input = t;
      break;
    }
    case 'text': {
      const i = h('input', { type: 'text', id, maxLength: def.maxLength, required: def.required, autocomplete: 'off' });
      read = () => i.value.trim(); set = (v) => { i.value = String(v); };
      input = i;
      break;
    }
  }
  input.setAttribute('aria-describedby', `${id}-msg${def.help ? ` ${id}-help` : ''}`);
  set(value);
  input.addEventListener('change', async () => {
    const v = read();
    if (!SETTINGS_CHECKS[key](v)) {
      input.setAttribute('aria-invalid', 'true');
      msg.textContent = def.type === 'number' ? `Between ${def.min} and ${def.max}${def.integer ? ', whole numbers' : ''}`
        : def.type === 'json' ? 'Not a JSON object (or too large)' : 'Not a valid value';
      return;
    }
    input.removeAttribute('aria-invalid');
    msg.textContent = 'Saving…';
    const error = await save(key, v);
    msg.textContent = error ?? 'Saved';
    if (error) input.setAttribute('aria-invalid', 'true');
  });
  const unit = def.type === 'number' && def.unit ? h('span', { className: 'muted' }, ` ${def.unit}`) : null;
  const row = def.type === 'bool'
    ? h('div', { className: 'row check' }, input, h('label', { htmlFor: id }, def.label), msg)
    : h('div', { className: def.type === 'json' ? 'row wide' : 'row' }, h('label', { htmlFor: id }, def.label), h('span', {}, input, unit, extra), msg);
  if (def.help) row.append(h('p', { className: 'muted help', id: `${id}-help` }, def.help));
  return { row, set: (v) => { if (document.activeElement !== input) set(v); } };
}

async function settingsPage(id: string, picker: HTMLElement): Promise<void> {
  let detail: Detail;
  try { detail = await api<Detail>(`api/devices/${id}`); } catch (e) { main.replaceChildren(h('p', { className: 'err' }, (e as Error).message)); return; }
  const controls = new Map<SettingKey, ReturnType<typeof control>>();
  const save = async (key: SettingKey, v: unknown) => {
    try {
      const r = await api<{ settings: EntitySettings }>(`api/devices/${id}/settings`, { method: 'PUT', body: { values: { [key]: v } } });
      for (const [k, c] of controls) c.set(r.settings[k]);
      return undefined;
    } catch (e) { return (e as Error).message; }
  };
  // Every setting, in the display's Settings groups: per-game and per-shape rows and the developer-level tunables
  // fold away, as on the display.
  const sections = SETTING_GROUPS.map((g) => {
    const keys = SETTING_KEYS.filter((k) => settingDef(k).group === g.id);
    const each = (k: SettingKey) => /^(game_|pupil_(star|heart|note|question|exclaim))/.test(k);
    const top = keys.filter((k) => !each(k) && !settingDef(k).advanced);
    const detailKeys = keys.filter((k) => each(k) && !settingDef(k).advanced);
    const advKeys = keys.filter((k) => settingDef(k).advanced);
    const make = (k: SettingKey) => { const c = control(k, settingDef(k), detail.settings[k], save); controls.set(k, c); return c.row; };
    return h('fieldset', {}, h('legend', {}, g.title), ...top.map(make),
      detailKeys.length ? h('details', {}, h('summary', {}, g.id === 'games' ? 'Each game' : 'Each shape'), ...detailKeys.map(make)) : null,
      advKeys.length ? h('details', {}, h('summary', {}, top.length ? 'Advanced' : `Show ${advKeys.length} settings`), ...advKeys.map(make)) : null,
      g.note ? h('p', { className: 'muted' }, g.note) : null);
  });
  main.replaceChildren(h('h2', {}, `Settings · Yanni ${detail.device.room}`), picker,
    h('p', { className: 'muted' }, detail.status?.online
      ? 'Changes go to the display at once (and to Home Assistant for the settings it shows).'
      : 'The display is offline: changes are kept, but the display’s own values win when it reconnects.'),
    ...sections);
  // Live: values changed on the display or in Home Assistant show up here (not while a control has focus).
  timer = setInterval(async () => {
    const d = await api<Detail>(`api/devices/${id}`).catch(() => undefined);
    if (d) for (const [k, c] of controls) c.set(d.settings[k]);
  }, 4000);
}

// ---- Status ----

type Row = [string, string];
function statusRows(s: DisplayStatus | null): Row[] {
  if (!s) return [['Connection', 'never connected since the add-on started']];
  const st: Partial<DisplayState> = s.state;
  const v = (x: unknown, suffix = '') => (x === undefined || x === null ? '—' : `${String(x)}${suffix}`);
  const yn = (b: unknown) => (b === undefined ? '—' : b ? 'yes' : 'no');
  return [
    ['Connection', s.online ? `online since ${ago(s.connectedAt)}` : `offline (last seen ${ago(s.lastSeenAt)})`],
    ['App', `${s.appVersion} · ${s.deviceModel}`],
    ['Face state', v(st.face_state)],
    ['Life phase', v(st.life_phase)],
    ['Bedtime', yn(st.bedtime_active)],
    ['Voice services', v(st.voice_services)],
    ['Person present', st.person_present === undefined ? '—' : `${yn(st.person_present)} (${v(st.people_count)} in view)`],
    ['Pending messages', v(st.pending_messages)],
    ['Frame rate', st.fps === undefined ? '—' : `${st.fps} fps · gap p99 ${v(st.frame_gap_p99_ms, ' ms')} · ${v(st.render_tier)} tier`],
    ['False engagements', v(st.false_engagements_per_hour, ' /h')],
    ['Gesture reactions', v(st.gesture_reactions_per_hour, ' /h')],
    ['Gesture false reports', v(st.gesture_false_reports_per_hour, ' /h')],
    ['Perception recording', yn(st.perception_recording)],
    ['Health', st.health === undefined ? '—' : `${st.health}${st.health_degraded?.length ? ` (${st.health_degraded.join(', ')})` : ''}`],
    ['Started', ago(st.started_at ?? undefined)],
    ['Last restart', st.last_restart ? `${st.last_restart} at ${ago(st.last_restart_at ?? undefined)}` : '—'],
    ['Thermal state', v(st.thermal_state)],
    ['Resource level', st.resource_level === undefined ? '—' : `${st.resource_level} (${v(st.resource_reason)})`],
    ['Battery', st.battery === undefined || st.battery === null ? '—' : `${st.battery} %${st.power_plugged ? ', plugged in' : ''}`],
    ['Kiosk lock', yn(st.kiosk_lock)],
  ];
}

async function statusPage(id: string, picker: HTMLElement): Promise<void> {
  const dl = h('dl');
  const fill = async () => {
    const d = await api<Detail>(`api/devices/${id}`).catch(() => undefined);
    if (!d) return;
    dl.replaceChildren(...statusRows(d.status).flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val)]));
  };
  await fill();
  const room = overview!.devices.find((x) => x.id === id)?.room ?? id;
  main.replaceChildren(h('h2', {}, `Status · Yanni ${room}`), picker, dl,
    h('p', { className: 'muted' }, 'The latest reports from the display, refreshed every 2 seconds. Nothing anyone said is ever reported.'));
  timer = setInterval(fill, 2000);
}

// ---- Announcements ----

function announcePage(id: string, picker: HTMLElement): void {
  const room = overview!.devices.find((x) => x.id === id)?.room ?? id;
  const text = h('textarea', { id: 'ann-text', maxLength: 500, rows: 3, required: true }, 'This is a test announcement.');
  const priority = h('select', { id: 'ann-priority' }, h('option', { value: 'normal' }, 'Normal'), h('option', { value: 'high' }, 'High'));
  const expires = h('input', { id: 'ann-expires', type: 'number', min: 1, max: 720, step: 1, value: 10 });
  const msg = h('p', { role: 'status' });
  const form = h('form', { onsubmit: async (e: Event) => {
    e.preventDefault();
    try {
      const r = await api<{ id: string }>(`api/devices/${id}/announce`, { method: 'POST',
        body: { text: text.value, priority: priority.value, expires_in: Number(expires.value) * 60 } });
      msg.textContent = `Sent (id ${r.id}). Yanni waits for someone to be there, awake, outside bedtime and quiet mode; the outcome arrives on the Announcement event entity.`;
    } catch (x) { msg.textContent = (x as Error).message; }
  } },
  h('label', { htmlFor: 'ann-text' }, 'Message'), text,
  h('div', { className: 'row' }, h('label', { htmlFor: 'ann-priority' }, 'Priority'), priority),
  h('div', { className: 'row' }, h('label', { htmlFor: 'ann-expires' }, 'Expires after'), h('span', {}, expires, h('span', { className: 'muted' }, ' min'))),
  h('button', {}, 'Send test announcement'), msg);
  const yaml = `action: notify.send_message
target:
  entity_id: notify.yanni_${room.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_announce
data:
  message: The laundry is done`;
  const json = `{"kind": "announce", "id": "dryer", "text": "The dryer is done",
 "priority": "high", "expires_in": 1800, "context": {"room": "laundry"}}
{"kind": "cancel", "id": "dryer"}
{"kind": "nudge", "feeling": "Happiness", "strength": 0.4, "look": "left"}`;
  main.replaceChildren(h('h2', {}, `Announcements · Yanni ${room}`), picker, form,
    h('h3', {}, 'From Home Assistant'),
    h('p', {}, 'Plain text through the notify entity:'), h('pre', {}, yaml),
    h('p', {}, 'Structured messages (priority, expiry, an id to replace or cancel) and nudges, published as JSON to ',
      h('code', {}, `yanni/${id}/announce/set`), ' (mqtt.publish, not retained):'), h('pre', {}, json),
    h('p', { className: 'muted' }, 'Yanni says it in character (the AI Task entity phrases it, treating the message as data); it never goes to the conversation agent.'));
}

// ---- Help ----

function helpPage(): void {
  const host = location.hostname || 'homeassistant.local';
  const li = (...k: Kid[]) => h('li', {}, ...k);
  main.replaceChildren(
    h('h2', {}, 'Setting up a tablet'),
    h('ol', {},
      li('On the tablet, open ', h('code', {}, `https://${host}:8443/`), ' (the add-on’s display port; change the host port under the add-on’s Network settings).'),
      li('Make a pairing code on ', h('a', { href: '#/displays' }, 'Displays'), ' and enter it on the tablet. It keeps its device token; revoke it there.'),
      li('Allow the camera and microphone when the browser asks. Tap the face once so it may play sound.')),
    h('h3', {}, 'HTTPS'),
    h('p', {}, 'Browsers allow the camera and microphone only on HTTPS. Without a certificate the display falls back to plain HTTP: the face works, but Yanni cannot see or hear (the add-on log warns).'),
    h('ul', {},
      li(h('b', {}, 'Let’s Encrypt or DuckDNS add-on: '), 'they write ', h('code', {}, 'fullchain.pem'), ' and ', h('code', {}, 'privkey.pem'), ' to /ssl, the add-on’s defaults. Open the display by the certificate’s host name, not the IP.'),
      li(h('b', {}, 'Your own certificate: '), 'put it in /ssl and set ', h('code', {}, 'certfile'), ' / ', h('code', {}, 'keyfile'), ' in the add-on options, then restart the add-on.'),
      li(h('b', {}, 'Self-signed: '), 'works once the tablet trusts it: install the certificate (Android: Settings → Security → Install a certificate; iPadOS: install the profile, then Settings → General → About → Certificate Trust Settings).')),
    h('h3', {}, 'Fully Kiosk Browser (Android)'),
    h('ul', {},
      li('Start URL: the display address above.'),
      li('Web Content Settings: enable Autoplay Videos (sound without a tap), Enable Webcam Access and Enable Microphone Access.'),
      li('Device Management: Keep Screen On, and Screen Off Timer off (Yanni dims itself when asleep).'),
      li('Kiosk Mode: on, with a PIN, so the face can’t be swiped away.')),
    h('h3', {}, 'Safari on iPad (Guided Access)'),
    h('ul', {},
      li('Open the display address and Share → Add to Home Screen, then open it from the Home Screen (full screen).'),
      li('Settings → Display & Brightness → Auto-Lock: Never.'),
      li('Settings → Accessibility → Guided Access: on, with a passcode. Open Yanni and triple-click the top button to start it.'),
      li('Safari asks for the camera and microphone once per site; choose Allow (Settings → Apps → Safari → Camera / Microphone: Allow).')),
    h('h3', {}, 'On the tablet'),
    h('p', {}, 'Hold the bottom-right corner for a couple of seconds for the owner menu (Settings, Status, HUD). A 4-digit PIN can guard it.'),
  );
}

addEventListener('hashchange', () => { render(); });
render();
