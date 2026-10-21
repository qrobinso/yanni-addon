// Fakes shared by the kiosk tests: an in-memory Storage and a browser environment.
import type { KeyValue } from '../../src/app/OwnerAccess';
import type { BrowserEnv } from '../../src/kiosk/DeviceProfile';

export const memoryStore = (): KeyValue & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

export const iPadSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

/// An iPad (Safari reports a Mac with touch) with a screen in CSS px.
export const iPadEnv = (w: number, h: number): BrowserEnv =>
  ({ userAgent: iPadSafari, maxTouchPoints: 5, screenWidth: w, screenHeight: h, devicePixelRatio: 2 });

export const desktopEnv: BrowserEnv = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36',
  maxTouchPoints: 0, screenWidth: 2560, screenHeight: 1440, devicePixelRatio: 1, deviceMemory: 8 };
