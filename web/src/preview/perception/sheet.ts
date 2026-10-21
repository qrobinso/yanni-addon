// A modal sheet for the perception dev tools (Swift `.sheet`): a native <dialog> (focus trap, Escape) with a title,
// a Done button and a body the caller fills. Removed from the page when closed.
import { button, h } from '../ui';

const CSS = `
.pv-sheet { max-width: min(760px, 96vw); width: 96vw; max-height: 92vh; overflow: auto; border: 0; border-radius: 14px;
  background: #15171c; color: #e8e8ea; padding: 12px 14px; font: 13px/1.4 system-ui, sans-serif; }
.pv-sheet::backdrop { background: rgba(0, 0, 0, 0.55); }
.pv-sheet header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.pv-sheet header h2 { flex: 1; font-size: 16px; margin: 0; }
.pv-sheet canvas { width: 100%; height: auto; border-radius: 8px; background: #000; }
.pv-sheet .pv-mono { font: 11px/1.35 ui-monospace, monospace; white-space: pre-wrap; }
.pv-sheet .pv-session { border-top: 1px solid rgba(255,255,255,0.1); padding: 6px 0; }
.pv-sheet label { display: block; margin: 4px 0; }
.pv-sheet .t-warn { color: #f6a54a; } .pv-sheet .t-accent { color: #6aa8ff; } .pv-sheet .t-good { color: #6ad38a; }
`;
let styled = false;

export interface Sheet { dialog: HTMLDialogElement; body: HTMLElement; setTitle(t: string): void; close(): void }

export function openSheet(title: string, onClose?: () => void, doneLabel = 'Done'): Sheet {
  if (!styled && typeof document !== 'undefined') {
    document.head.append(h('style', { textContent: CSS }));
    styled = true;
  }
  const heading = h('h2', {}, title);
  const body = h('div', {});
  const dialog = h('dialog', { className: 'pv-sheet' });
  dialog.setAttribute('aria-label', title);
  const close = () => dialog.close();
  dialog.append(h('header', {}, heading, button(doneLabel, close)), body);
  dialog.addEventListener('close', () => { dialog.remove(); onClose?.(); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, setTitle: (t) => { heading.textContent = t; dialog.setAttribute('aria-label', t); }, close };
}

/** Saves bytes as a file (Swift's share sheet). */
export function download(name: string, bytes: Uint8Array, type = 'application/x-tar'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
