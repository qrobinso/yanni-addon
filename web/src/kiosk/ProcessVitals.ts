// Port of FaceRuntime/ProcessVitals.swift for the browser. One minute's vitals (hardening design §6.6, H5): what the
// leak alarm watches. Browser mapping (MAPPING.md):
// - footprint: `performance.measureUserAgentSpecificMemory()` (cross-origin isolated Chromium; the page is), else
//   `performance.memory.usedJSHeapSize` (Chromium), else 0;
// - available memory: `jsHeapSizeLimit − usedJSHeapSize` (Chromium), else null (the alarm's stand-in);
// - threads, open files, GPU bytes: no web API, always 0.

export interface VitalsSample {
  /// Seconds since the monitor started.
  uptime: number;
  footprint: number;
  threads: number;
  openFiles: number;
  metalBytes: number;
  availableMemory: number | null;
  /// The kiosk's thermal level (0 nominal … 3 critical).
  thermal: number;
}

export const makeVitalsSample = (o: Partial<VitalsSample> & Pick<VitalsSample, 'uptime' | 'footprint'>): VitalsSample =>
  ({ threads: 0, openFiles: 0, metalBytes: 0, availableMemory: null, thermal: 0, ...o });

interface ChromiumMemory { usedJSHeapSize: number; jsHeapSizeLimit: number }
type MemoryPerformance = Performance & {
  memory?: ChromiumMemory;
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
};

export const ProcessVitals = {
  /// Chromium's synchronous heap numbers, or null.
  heap(perf: MemoryPerformance = performance): ChromiumMemory | null {
    const m = perf.memory;
    return m && m.jsHeapSizeLimit > 0 ? m : null;
  },

  /// Footprint in bytes (0 if unavailable). The precise measure can take seconds (it waits for a GC); time it out.
  async footprint(perf: MemoryPerformance = performance, isolated = globalThis.crossOriginIsolated === true): Promise<number> {
    if (isolated && typeof perf.measureUserAgentSpecificMemory === 'function') {
      try {
        const r = await Promise.race([perf.measureUserAgentSpecificMemory(),
          new Promise<null>((res) => setTimeout(() => res(null), 30_000))]);
        if (r) return r.bytes;
      } catch { /* SecurityError outside isolation */ }
    }
    return ProcessVitals.heap(perf)?.usedJSHeapSize ?? 0;
  },

  availableMemory(perf: MemoryPerformance = performance): number | null {
    const m = ProcessVitals.heap(perf);
    return m ? Math.max(m.jsHeapSizeLimit - m.usedJSHeapSize, 0) : null;
  },

  async sample(uptime: number, thermal: number, perf: MemoryPerformance = performance): Promise<VitalsSample> {
    return makeVitalsSample({ uptime, footprint: await ProcessVitals.footprint(perf), availableMemory: ProcessVitals.availableMemory(perf), thermal });
  },
};
