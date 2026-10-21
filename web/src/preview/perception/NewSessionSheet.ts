// Port of yanni/Perception/NewSessionSheet.swift: starting a recording — what kind of session, who takes part, the
// consent text read with everyone, then the PIN.
import type { PerceptionHarness } from '../../app/PerceptionHarness';
import { CollectPreset } from '../../perception/CollectScript';
import { RecordingConsentText } from '../../perception/RecordingConsent';
import type { RecordingSessionType } from '../../perception/FeatureRecordFormat';
import { fmtG } from '../../perception/PerceptionTypes';
import { button, h, select, toggle } from '../ui';
import { openSheet } from './sheet';

export type SessionKind = 'scripted' | 'none' | 'free';
const KINDS: readonly (readonly [SessionKind, string])[] = [['scripted', 'Scripted prompts'], ['none', '"None" (ordinary living)'], ['free', 'Free']];

/** Asks for the owner PIN in a sheet; resolves true once it verifies. */
export function askPIN(harness: PerceptionHarness, purpose: string): Promise<boolean> {
  return new Promise((done) => {
    let ok = false;
    const sheet = openSheet(`PIN to ${purpose}`, () => done(ok), 'Cancel');
    const input = h('input', { type: 'password', inputMode: 'numeric', maxLength: 4, autocomplete: 'off' });
    input.setAttribute('aria-label', 'Owner PIN');
    const msg = h('p', { className: 'pv-note t-warn', role: 'alert' });
    const form = h('form', {}, input, button('Unlock', () => {}), msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = await harness.access?.verify(input.value);
      if (v === 'ok') { ok = true; sheet.close(); return; }
      msg.textContent = v && typeof v === 'object' ? `Locked for ${Math.ceil(v.locked)} s` : 'Wrong PIN';
      input.value = '';
    });
    (form.querySelector('button') as HTMLButtonElement).type = 'submit';
    sheet.body.append(form);
    input.focus();
  });
}

export function openNewSessionSheet(harness: PerceptionHarness, done: () => void = () => {}): void {
  let kind: SessionKind = 'scripted', preset: CollectPreset = 'handShapes', mark = 1.3, confirmed = false;
  const chosen = new Set<string>();
  const sheet = openSheet('New recording', done, 'Cancel');
  const result = h('p', { className: 'pv-note t-warn', role: 'alert' });
  const startButton = button('Enter PIN & start', async () => {
    if (!(await askPIN(harness, 'start recording'))) return;
    const type: RecordingSessionType = kind === 'none' ? 'none' : kind === 'free' ? 'free' : CollectPreset.sessionType(preset);
    const order = harness.policy.participants.map((p) => p.pseudonym).filter((p) => chosen.has(p));
    const check = harness.start({ type, declared: order, consentConfirmed: confirmed, pinVerified: true,
      preset: kind === 'scripted' ? preset : null, distance: kind === 'scripted' && preset !== 'tracking' ? mark : null });
    if (check.kind === 'ok' && harness.isRecording) sheet.close(); else result.textContent = harness.message;
  });
  const enable = () => { startButton.disabled = chosen.size === 0 || !confirmed; };
  const session = h('div', {});
  const renderSession = (): void => {
    session.replaceChildren(select('Kind', KINDS, () => kind, (v) => { kind = v; renderSession(); }),
      ...(kind === 'scripted' ? [
        select('Preset', CollectPreset.allCases.map((p) => [p, CollectPreset.title(p)] as const), () => preset, (v) => { preset = v; renderSession(); }),
        preset !== 'tracking' ? select('Floor mark', CollectPreset.floorMarks.map((m) => [m, `${fmtG(m)} m`] as const), () => mark, (v) => { mark = v; }) : '',
        h('p', { className: 'pv-note' }, 'Tape marks at 0.6, 1, 1.3, 1.6, 2, 2.5, 3 and 3.5 m from the screen. Prompt cards show on the face; each "go" window is the label.'),
      ] : kind === 'none' ? [h('p', { className: 'pv-note' }, 'Ordinary household activity (cooking, TV, homework, play). Every reaction in it counts as a false positive; mark real ones later in the skeleton viewer.')] : []));
  };
  renderSession();
  const people = harness.policy.participants.map((p) => toggle(p.isChild ? `${p.pseudonym} (child)` : p.pseudonym,
    () => chosen.has(p.pseudonym), (on) => { if (on) chosen.add(p.pseudonym); else chosen.delete(p.pseudonym); enable(); }));
  sheet.body.append(
    h('h3', {}, 'Session'), session,
    h('h3', {}, 'Who takes part (only they may be in view)'), ...people,
    h('h3', {}, 'Consent'), h('p', { className: 'pv-mono' }, RecordingConsentText.text),
    toggle('Everyone taking part (a guardian for each child) has read this and agrees', () => confirmed, (v) => { confirmed = v; enable(); }),
    result, startButton);
  enable();
}
