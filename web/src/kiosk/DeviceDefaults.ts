// Port of YanniDevice/DeviceDefaults.swift. Per-device defaults (hardening design §4.3), derived from a profile: the
// frame clock's ceiling, the style's luminance cap and background APL budget, the engine's power care and the LCD
// "backlight" (here a CSS dim, see Backlight.ts).
//
// **Target frame rate (the single definition): awake 60 fps, asleep 30 fps.** 120 Hz is a bonus burst on fast
// displays; nothing here ever lowers the targets.
import { treatAsOLED, DeviceProfile, type TierHint } from './DeviceProfile';

export interface DeviceDefaults {
  /// Highest frame rate the burst may use (120 on a 120 Hz display, else 60).
  burstCeilingFPS: number;
  tierHint: TierHint;
  /// Cap on the eye colours' luminance (`RenderStyle.maxLuminance`); null keeps the style's own value.
  maxLuminanceCap: number | null;
  idleDimLevel: number;
  idleDimDelay: number;
  asleepBrightness: number;
  /// OLED power cap for the mood background; 0 = uncapped.
  backgroundAPLBudget: number;
  /// LCD: dim the screen while asleep (§7.3). Never on OLED.
  backlightFollowsSleep: boolean;
  burnInDrift: [number, number];
}

export const DeviceDefaults = {
  awakeTargetFPS: 60,
  asleepTargetFPS: 30,
  oledBackgroundAPLBudget: 0.15,
  maxBackgroundAPLBudget: 0.30,

  /// The defaults for a profile. Unknown displays get the OLED values.
  for(p: DeviceProfile): DeviceDefaults {
    const oled = treatAsOLED(p.display) && p.family !== 'desktop';
    const tabletLCD = (p.display === 'lcd' || p.display === 'miniLED') && p.family !== 'desktop' && p.family !== 'unknown';
    return {
      burstCeilingFPS: p.maxFramesPerSecond >= 120 ? 120 : 60,
      tierHint: p.family === 'desktop' ? 'full' : DeviceProfile.tierHint(p),
      maxLuminanceCap: oled ? 0.80 : null,
      idleDimLevel: oled ? 0.55 : 0.70,
      idleDimDelay: 20,
      asleepBrightness: 0.12,
      backgroundAPLBudget: oled ? DeviceDefaults.oledBackgroundAPLBudget : 0,
      backlightFollowsSleep: tabletLCD,
      burnInDrift: [8, 10],
    };
  },
};
