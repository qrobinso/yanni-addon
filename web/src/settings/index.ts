// Settings on the display: the hub (load, persist, sync with the add-on, subscribe), the appliers that push each
// slice into its subsystem, the style composer, and the kiosk Settings screen. Ports of YanniSettings (SettingsHub,
// SettingsAppliers, SettingsStore, StyleComposer) and the app's Settings views. docs/SETTINGS.md maps every setting.
import type { OwnerAccess } from '../app/OwnerAccess';
import type { SettingsHub } from './SettingsHub';

export { SettingsHub, memoryHub, type SettingsApplier, type SettingsChange, type SettingsLink, type SettingsOrigin,
  type SettingsPatch } from './SettingsHub';
export { SettingsStore, settingsFrom, sparse, timerScheduler, type KeyValue, type LoadOutcome, type Scheduler } from './SettingsStore';
export { StyleComposer, colourVignetteInner, developerStyle, hexToLinear, linearToHex, sameStyle } from './StyleComposer';
export { attachSettings, applyEngine, conversationSettings, edgeAnticSettings, emotionSettings, expressiveBudget,
  filterReport, idleGameSettings, kioskSlice, lifeSettings, listeningGlow, moodBackground, perceptionSettings,
  pupilReactionSettings, turnTunables, voiceServicesEndpoint, voiceSettings, type AttachOptions, type KioskSlice,
  type SettingsAttachment } from './SettingsAppliers';
export { openSettingsPanel, SETTINGS_ACTIVITY_INTERVAL, SETTINGS_IDLE_TIMEOUT, type PanelOptions,
  type SettingsPanel } from './SettingsPanel';

/** Reset all settings (Swift `SettingsHub.resetAll`): every value back to its default (the add-on is told), the PIN
 *  forgotten. The pairing is kept, so the Home Assistant device survives. */
export function resetAllSettings(hub: SettingsHub, access?: OwnerAccess): void {
  access?.clearPIN();
  hub.resetToDefaults();
}
