// The hang monitor's watcher thread: runs HangMonitor off the main thread, pinging it over postMessage.
import { HangMonitor, type HangWorkerIn, type HangWorkerOut } from './HangMonitor';

const post = (m: HangWorkerOut) => (self as unknown as Worker).postMessage(m);
let nextId = 0;
const answers = new Map<number, () => void>();
const monitor = new HangMonitor(() => performance.now() / 1000, (answer) => {
  const id = ++nextId;
  answers.set(id, answer);
  post({ kind: 'ping', id });
});
monitor.onHitch = (s) => post({ kind: 'hitch', seconds: s, counters: { ...monitor.counters } });
monitor.onHang = (s) => post({ kind: 'hang', seconds: s, counters: { ...monitor.counters } });
monitor.onRestart = (s) => post({ kind: 'restart', seconds: s, counters: { ...monitor.counters } });

self.onmessage = (e: MessageEvent<HangWorkerIn>) => {
  const m = e.data;
  if (m.kind === 'pong') { answers.get(m.id)?.(); answers.delete(m.id); }
  else if (m.kind === 'arm') { monitor.restartArmed = m.armed; monitor.start(); }
  else { monitor.stop(); answers.clear(); }
};
