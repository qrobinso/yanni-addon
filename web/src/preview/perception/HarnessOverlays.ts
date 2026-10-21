// Port of yanni/Perception/HarnessOverlays.swift: face-screen overlays of the measurement harness — the recording
// banner (always while a session runs), the scripted session's prompt card, and the developer perception HUD. None of
// them take touches except the HUD's isolated-timing button (not available on the web: see the panel's note).
import type { PerceptionHarness } from '../../app/PerceptionHarness';
import type { ScriptedPhase } from '../../perception/CollectScript';
import type { CollectPrompt } from '../../perception/CollectScript';
import { StagePercentiles, StageTimings } from '../../perception/HarnessTiming';
import { fmtG } from '../../perception/PerceptionTypes';
import { h } from '../ui';

const BOX = 'position:fixed;z-index:40;pointer-events:none;color:rgba(255,255,255,0.85);';

const header = (p: CollectPrompt): string => [p.person, p.distance !== null ? `${fmtG(p.distance)} m` : null, p.title].filter(Boolean).join(' · ');

/** The prompt card's text ("P2 · 1.5 m · thumbs down" / "in 3…"). */
export function promptLines(p: ScriptedPhase): { head: string; big: string; colour: string } {
  switch (p.kind) {
    case 'countdown': return { head: header(p.prompt), big: `in ${p.secondsLeft}…`, colour: '#ffd60a' };
    case 'go': return { head: header(p.prompt), big: `GO · ${p.secondsLeft}`, colour: '#32d74b' };
    case 'rest': return { head: `next\n${header(p.next)}`, big: '', colour: '#fff' };
    case 'done': return { head: '', big: 'Done — thank you!', colour: '#fff' };
  }
}

/** The HUD's lines (live per-stage latency, the face's frame delivery over the same window). */
export function hudLines(harness: PerceptionHarness): string[] {
  const hd = harness.hud;
  const f = (v: number, w = 5) => v.toFixed(1).padStart(w);
  return [
    `perception · ${hd.tier} · ${hd.summary.fps.toFixed(1)} fps · late ${(hd.lateFraction * 100).toFixed(0)} %`,
    hd.plan,
    'stage      p50   p90   p99',
    ...StageTimings.names.map((n, i) => {
      const s = hd.summary.stages[i] ?? StagePercentiles.make();
      return `${n.padEnd(9)} ${f(s.p50)} ${f(s.p90)} ${f(s.p99)}`;
    }),
    `total     ${f(hd.summary.total.p50)} ${f(hd.summary.total.p90)} ${f(hd.summary.total.p99)}`,
    `face frames delivered ${hd.delivered.toFixed(3)} · hitch ${hd.hitchMsPerSecond.toFixed(2)} ms/s`,
  ];
}

/** Mounts the three overlays over the face and refreshes them at 4 Hz. Returns the unmount. */
export function mountHarnessOverlays(harness: PerceptionHarness, root: HTMLElement = document.body): () => void {
  const dot = h('span', {});
  dot.style.cssText = 'display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;';
  const bannerText = h('span', {});
  const banner = h('div', { role: 'status' }, dot, bannerText);
  banner.style.cssText = BOX + 'left:18px;bottom:18px;padding:6px 10px;border-radius:999px;background:rgba(0,0,0,0.5);font:500 12px system-ui,sans-serif;';
  const head = h('div', {}), big = h('div', {});
  head.style.cssText = 'font:600 34px system-ui,sans-serif;white-space:pre-line;text-align:center;';
  big.style.cssText = 'font:700 64px system-ui,sans-serif;text-align:center;';
  const card = h('div', { role: 'status' }, head, big);
  card.style.cssText = BOX + 'left:50%;bottom:40px;transform:translateX(-50%);padding:24px;border-radius:20px;background:rgba(0,0,0,0.6);color:#fff;';
  const hud = h('pre', {});
  hud.style.cssText = BOX + 'top:48px;right:12px;max-width:340px;margin:0;padding:8px;border-radius:8px;background:rgba(0,0,0,0.55);font:11px/1.3 ui-monospace,monospace;';
  hud.setAttribute('aria-hidden', 'true');
  root.append(banner, card, hud);
  const refresh = (): void => {
    const s = harness.status;
    banner.hidden = !s;
    if (s) {
      const paused = s.state === 'paused';
      dot.style.background = paused ? '#ff9f0a' : '#ff453a';
      bannerText.textContent = paused ? 'recording paused (someone undeclared in view)' : 'recording movement data';
      banner.setAttribute('aria-label', paused ? 'Movement recording paused' : 'Recording movement data');
    }
    const p = harness.prompt;
    card.hidden = !p;
    if (p) {
      const l = promptLines(p);
      head.textContent = l.head;
      big.textContent = l.big;
      big.style.color = l.colour;
    }
    hud.hidden = !harness.hudEnabled;
    if (harness.hudEnabled) {
      const lines = hudLines(harness);
      hud.textContent = lines.join('\n');
      hud.style.color = harness.hud.delivered < 0.98 ? '#ff9f0a' : 'rgba(255,255,255,0.85)';
    }
  };
  refresh();
  const timer = setInterval(refresh, 250);
  return () => { clearInterval(timer); banner.remove(); card.remove(); hud.remove(); };
}
