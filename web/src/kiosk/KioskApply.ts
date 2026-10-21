// Port of YanniKiosk/KioskApply.swift. Applies the device defaults and the governor's budget to the face (hardening
// design §4.3, §6.4). Everything it touches is a ceiling or a smoothed target: the frame-rate ceiling (burst only), the
// render scale, the background fade (through its spring), the listening glow's motion, the thinking beats' rate, and
// the engine's power care (through `Brightness`'s smoothing). It never disables a modifier and never lowers the
// awake 60 / asleep 30 targets.
import type { FaceEngine } from '../engine/FaceEngine';
import { PowerCare } from '../engine/PowerCare';
import { ThinkingBeats } from '../engine/modifiers/ThinkingBeats';
import type { FrameClock } from '../render/FrameClock';
import { FrameRateTier } from '../render/FrameRatePolicy';
import type { RenderStyle } from '../render/RenderStyle';
import { DeviceDefaults } from './DeviceDefaults';
import { treatAsOLED, type DeviceProfile } from './DeviceProfile';
import type { Budget } from './ResourceGovernor';

/// The renderer's drawable-scale lever (Swift FaceRenderControl.renderScale). port-note: FaceRenderer has no render
/// scale yet, so the kiosk passes one only when the shell provides it.
export interface RenderScaleControl { renderScale: number }

interface RateModifier { rate: number }

export const KioskApply = {
  /// The frame-rate ceiling for a device and a budget: the lower of the two, never below 60.
  rateCeiling(d: DeviceDefaults, b: Budget): FrameRateTier {
    return Math.min(d.burstCeilingFPS, b.rateCeilingFPS) >= 120 ? FrameRateTier.high : FrameRateTier.normal;
  },

  /// The engine's power care for a device and a budget (OLED brightness step-down only on OLED-like panels).
  powerCare(d: DeviceDefaults, p: DeviceProfile, b: Budget): PowerCare {
    const oled = treatAsOLED(p.display) && p.family !== 'desktop';
    return new PowerCare(d.idleDimLevel, d.idleDimDelay / Math.max(b.idleDimSooner, 1), oled ? b.oledBrightnessScale : 1).validated();
  },

  /// Pushes a budget to the face. Cheap; called on level changes (not per frame).
  apply(d: DeviceDefaults, p: DeviceProfile, b: Budget, clock: FrameClock, control: RenderScaleControl | null,
    engine: FaceEngine): void {
    clock.rateCeiling = KioskApply.rateCeiling(d, b);
    if (control) control.renderScale = b.renderScale;
    engine.setBackgroundSuppressed(b.backgroundSuppressed);
    const glow = engine.listeningGlow;
    if (glow.motion !== b.glowMotion) { glow.motion = b.glowMotion; engine.listeningGlow = glow; }
    const rate = ThinkingBeats.governorRate(b.level);
    const beats = engine.director.modifier('ThinkingBeats') as unknown as RateModifier | undefined;
    if (beats) beats.rate = rate;
    const noticing = engine.director.modifier('NoticingAttention') as unknown as RateModifier | undefined;
    if (noticing) noticing.rate = rate;
    const care = KioskApply.powerCare(d, p, b);
    if (!engine.powerCare.equals(care)) engine.powerCare = care;
  },

  /// The renderer's style under the device caps: the OLED luminance cap and the mood background's APL budget
  /// (`ownerBudget` raises it up to `DeviceDefaults.maxBackgroundAPLBudget`). Static per launch.
  style(s: RenderStyle, d: DeviceDefaults, ownerBudget: number | null = null): RenderStyle {
    const out = { ...s };
    if (d.maxLuminanceCap !== null) out.maxLuminance = Math.min(out.maxLuminance, d.maxLuminanceCap);
    if (d.backgroundAPLBudget > 0 && out.backgroundAPLBudget <= 0) {
      const owner = ownerBudget === null ? null
        : Math.min(Math.max(ownerBudget, d.backgroundAPLBudget), DeviceDefaults.maxBackgroundAPLBudget);
      out.backgroundAPLBudget = owner ?? d.backgroundAPLBudget;
    }
    return out;
  },
};
