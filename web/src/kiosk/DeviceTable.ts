// Port of YanniDevice/DeviceTable.swift for the browser. A web page can't read `hw.machine`, so a row is keyed by what
// Safari does report: the screen in CSS points (landscape long × short) at its pixel ratio, plus the probed refresh
// rate where two models share a screen (iPad Pro 12.9 at 120 Hz vs iPad Air 13 at 60 Hz). Display kinds, chips,
// camera edges and sizes are the Swift table's.
import type { CameraEdge, ChipClass, DisplayKind, Family } from './DeviceProfile';

export interface DeviceRow {
  /// Screen keys `iPad <long>x<short>@<dpr>` (CSS px, landscape).
  ids: string[];
  name: string;
  family: Family;
  /// The oldest chip that has this screen (the perception tier hint stays conservative).
  chip: ChipClass;
  display: DisplayKind;
  maxHz: number;
  camera: CameraEdge;
  size: [number, number];
  /// port-note: false when the screen class spans models whose camera edges differ (the offset can't be known).
  calibrated: boolean;
}

const pro11: [number, number] = [0.2328, 0.1605];
const pro13: [number, number] = [0.2648, 0.1986];
const pro11Old: [number, number] = [0.2298, 0.1605];
const pro129: [number, number] = [0.2629, 0.1970];
const air11: [number, number] = [0.2271, 0.1578];
const air13: [number, number] = [0.2629, 0.1970];
const mini: [number, number] = [0.1766, 0.1159];
const ipad102: [number, number] = [0.2058, 0.1544];
const air105: [number, number] = [0.2140, 0.1606];
const mini5: [number, number] = [0.1595, 0.1196];

const r = (ids: string[], name: string, family: Family, chip: ChipClass, display: DisplayKind, maxHz: number,
  camera: CameraEdge, size: [number, number], calibrated = true): DeviceRow =>
  ({ ids, name, family, chip, display, maxHz, camera, size, calibrated });

export const DeviceTable = {
  /// Every known row, current lineup first.
  rows: [
    r(['iPad 1210x834@2'], 'iPad Pro 11 (M4/M5)', 'iPadPro', 'm4', 'oled', 120, 'long', pro11),
    r(['iPad 1376x1032@2'], 'iPad Pro 13 (M4/M5)', 'iPadPro', 'm4', 'oled', 120, 'long', pro13),
    r(['iPad 1194x834@2'], 'iPad Pro 11 (A12X–M2)', 'iPadPro', 'a12', 'lcd', 120, 'short', pro11Old),
    // 12.9" Pro: LCD on A12X/Z, mini-LED on M1/M2; both get the non-OLED defaults.
    r(['iPad 1366x1024@2'], 'iPad Pro 12.9 (A12X–M2)', 'iPadPro', 'a12', 'miniLED', 120, 'short', pro129),
    r(['iPad 1366x1024@2'], 'iPad Air 13 (M2–M4)', 'iPadAir', 'm2', 'lcd', 60, 'long', air13),
    // Air 4/5 (short edge), Air 11 M2–M4 and iPad 10th/11th gen (long edge) share this screen.
    r(['iPad 1180x820@2'], 'iPad Air 11 / iPad (A14–M4)', 'iPadAir', 'a14', 'lcd', 60, 'unknown', air11, false),
    r(['iPad 1133x744@2'], 'iPad mini (A15/A17 Pro)', 'iPadMini', 'a15', 'lcd', 60, 'short', mini),
    r(['iPad 1080x810@2'], 'iPad (7th–9th gen)', 'iPad', 'a12', 'lcd', 60, 'short', ipad102),
    r(['iPad 1112x834@2'], 'iPad Air (A12)', 'iPadAir', 'a12', 'lcd', 60, 'short', air105),
    r(['iPad 1024x768@2'], 'iPad mini (A12)', 'iPadMini', 'a12', 'lcd', 60, 'short', mini5),
  ] as readonly DeviceRow[],

  /// The row for a screen key; where two rows share it, the one whose refresh rate the probe matches.
  row(machine: string, probedHz?: number | null): DeviceRow | undefined {
    const hits = DeviceTable.rows.filter((x) => x.ids.includes(machine));
    if (hits.length <= 1 || !probedHz) return hits[0];
    return hits.find((x) => (probedHz >= 120) === (x.maxHz >= 120)) ?? hits[0];
  },

  /// Swift guesses an unknown iPad's chip from its `hw.machine` generation; a screen key carries none.
  chipGuess(_machine: string): ChipClass { return 'unknown'; },
};
