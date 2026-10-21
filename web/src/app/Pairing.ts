// First run: the display redeems the 6-digit code shown on the add-on's Ingress page for a device token (POST
// /api/pair) and keeps it in local storage. Every display socket presents it.

export interface Pairing { token: string; deviceId: string; room: string }

const KEY = 'yanni.device';

/** Local storage that never throws (private mode, blocked site data): reads come back empty, writes are dropped. */
export const storage = {
  get<T>(key: string): T | undefined {
    try { const v = localStorage.getItem(key); return v === null ? undefined : JSON.parse(v) as T; } catch { return undefined; }
  },
  set(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* dropped */ } },
  remove(key: string): void { try { localStorage.removeItem(key); } catch { /* dropped */ } },
};

export function loadPairing(): Pairing | undefined {
  const p = storage.get<Pairing>(KEY);
  return typeof p?.token === 'string' && p.token ? p : undefined;
}

export const forgetPairing = (): void => storage.remove(KEY);

/** Redeems a code. Throws with the server's message on failure. */
export async function redeem(code: string, fetcher: typeof fetch = fetch): Promise<Pairing> {
  const r = await fetcher(new URL('api/pair', document.baseURI), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const body = await r.json().catch(() => ({})) as Partial<Pairing> & { error?: string };
  if (!r.ok || typeof body.token !== 'string') throw new Error(body.error ?? `pairing failed (${r.status})`);
  const p = { token: body.token, deviceId: String(body.deviceId), room: String(body.room) };
  storage.set(KEY, p);
  return p;
}

/** Shows the pairing screen until a code is redeemed. */
export function showPairing(root: HTMLElement): Promise<Pairing> {
  return new Promise((resolve) => {
    const form = document.createElement('form');
    form.className = 'pairing';
    form.innerHTML = `<h1>Pair this display</h1>
      <p>Open Yanni in Home Assistant and enter the code it shows.</p>
      <label for="pair-code">Pairing code</label>
      <input id="pair-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,6}" maxlength="6" required>
      <button type="submit">Pair</button>
      <p class="pair-error" role="alert"></p>`;
    const input = form.querySelector('input')!;
    const error = form.querySelector('.pair-error')!;
    const button = form.querySelector('button')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      button.disabled = true;
      error.textContent = '';
      redeem(input.value.trim()).then((p) => { form.remove(); resolve(p); }, (err: Error) => {
        error.textContent = err.message;
        button.disabled = false;
        input.select();
      });
    });
    root.append(form);
    input.focus();
  });
}
