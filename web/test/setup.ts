// Yield one macrotask after every test. Synchronous tests otherwise run back to back on microtasks, so the worker never
// handles Vitest's RPC replies; a file of heavy sweeps (PupilGlyph: ~60 s on CI) then hits "Timeout calling onTaskUpdate".
import { afterEach } from 'vitest';

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
