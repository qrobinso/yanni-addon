// Port of Tests/FaceVoiceTests/HostTests.swift.
import { describe, test } from 'vitest';

describe('HostTests', () => {
  // AVAudioEngine offline manual rendering of the AVAudioSourceNode block; the web host is playback/ (AudioWorklet).
  test.skip('sourceNodeRendersOfflineFromAThread', () => {});
  // VoiceAudioHost (AVAudioEngine/AVAudioSession) attach at the hardware rate; replaced by playback/ on the web.
  test.skip('hostAttachRunsRendererAtHardwareRateWithoutStarting', () => {});
});
