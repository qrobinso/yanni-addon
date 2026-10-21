// Port of FaceVoice/Generate/ReactionTables.swift (the `VoiceReaction` extension).
import type { AgentState, OneShotKind } from '../../engine';
import type { VoiceReaction } from '../model/VoiceModel';
import { ReactionTemplates } from './ReactionTemplates';

export const VoiceReactionTables = {
  /// The vocal reaction that accompanies a face one-shot, or null for silent ones.
  forOneShot(kind: OneShotKind): VoiceReaction | null {
    switch (kind) {
      case 'laugh': return 'giggle';
      case 'crossEyed': return 'giggle';                // silliness gets a little giggle
      case 'dance': return 'danceBeat';
      case 'mockOffense': return 'hmph';
      case 'doubleTake': return 'doubleTake';
      case 'confusedShake': return 'confused';
      case 'bigSurprise': return 'startled';
      case 'perkUp': return 'engaged';
      case 'delightedSquint': return 'delighted';
      case 'curiousTilt': return 'curious';
      case 'yawn': case 'nodOff': case 'wake': return 'sleepy';     // wake: higher arousal → the short end of sleepy
      case 'sorryBlink': return 'sheepish';             // a "sorry" reads as "uh-oh"
      case 'lookAway': return 'embarrassed';
      case 'sideEye': case 'stretch': return null;      // silent judgement / silent stretch
      case 'catchSelf': return null;                    // catching yourself dozing is a silent "whoops"
      case 'popUp': return 'delighted';                 // "ta-da" on the spring up
      case 'shyPeek': return 'curious';                 // a curious chirp as the first eye peeks back
      case 'curiousLean': case 'pretendExit': return null;    // silent: the moves speak for themselves
      case 'sleepySink': return 'sleepy';               // a sleepy murmur at the catch
      case 'starEyes': return 'delighted';              // delight at the star pop
      case 'heartEyes': return 'curious';               // a soft rising "aww" as the hearts grow in
      case 'noteEyes': return 'giggle';                 // a little melodic giggle at the flip
      case 'questionEyes': return 'curious';            // "hm?" as the leading eye flips
      case 'exclaimEyes': return 'engaged';             // a bright "oh!" at the upright pop (one chirp; the squint is silent)
      case 'nodYes': return 'mmHm';                     // "mm-hm!" on the two bobs
      case 'nodYesBig': return 'mmHmBig';               // a bigger rising "mm-HM!" on the first two bobs
      case 'shakeNo': return 'uhUh';                    // a falling "uh-uh" on the first two swings
      case 'shakeNoBig': return 'nuhUh';                // a firm, low "nuh-uh" on the first two swings
      // Idle games: one chirp per game on its first accent (the serve, the first bounce); it counts as one ambient
      // chirp (the idle 90 s rule applies). Pending games stay silent until their curves exist.
      case 'pingPong': return 'giggle';                 // a playful giggle as the serve goes
      case 'basketball': return 'delighted';            // "ooh" on the first bounce
      case 'juggling': return 'giggle';                 // a giggle on the first catch
      case 'yoYo': return 'delighted';                  // "ooh" as the first drop hits the bottom
      case 'leapfrog': return 'delighted';              // a bouncy run as the first hop takes off
      case 'staringContest': return 'mmHm';             // a smug "mm-hm!" at the winner's squint (not hmph: that skips the 90 s rule)
      case 'danceBreak': return 'danceBeat';            // four chirps on the first four beats (0.5 s, the dance's beat)
      case 'hulaHoop': return 'confused';               // a woozy "hm?" as the dizziness sets in
      case 'hideAndSeek': return 'curious';             // a curious "hm-hm" on the first count
      case 'catchTheFly': return 'startled';            // a startled "!" at the clap
    }
    return null;
  },

  /// The vocal reaction played on entering an agent state, or null.
  forAgentStateEntry(s: AgentState): VoiceReaction | null {
    switch (s) {
      case 'engaged': return 'engaged';
      case 'notForMe': return 'embarrassed';
      case 'sheepish': return 'sheepish';
      case 'confused': return 'confused';
      case 'waking': return 'sleepy';
      default: return null;
    }
  },

  /// Laugh one-shot bounce times at rate 1 (s from the one-shot start). Giggle notes start at
  /// `bounce − bounces[0]`; the director aligns note 0 with `bounces[0] / rate` and may scale onsets by 1/rate.
  giggleBounceTimes: ReactionTemplates.giggleBounces,
  /// Beat period of `.danceBeat` chirps at rate 1 (s).
  danceBeatPeriod: ReactionTemplates.danceBeatPeriod,
};
