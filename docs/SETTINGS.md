# Settings inventory

Every setting of the Swift app (`YanniSettings`, `Packages/YanniHome/Sources/YanniSettings/YanniSettings.swift`) and
where it lives on the web: its schema key in `server/src/settingsSchema.ts`, where the display applies it
(`web/src/settings`, `attachSettings`), and its Home Assistant entity (MQTT component, `server/src/entities.ts`).
`server/test/settingsSchema.test.ts` fails if a key in the table below is missing from the schema, or a schema key is
missing from the table.

**Counts.** Swift `YanniSettings` has 168 persisted fields (`pupilReactions.reduceMotion` is runtime only and not
counted). 145 are ported as schema keys, 1 (`access.pinEnabled`) is ported as display-local state, and 22 are not
applicable on the web (below). One more persisted Swift value outside `YanniSettings`, the Listening panel's turn
tunables, is a schema key too: 146 schema keys in all, 25 of them Home Assistant entities (the iPad's list, unchanged).

**Where things show.** The kiosk Settings screen (`openSettingsPanel`) and the add-on's owner pages list every key, in
the groups of `SETTING_GROUPS`, with the schema default on a fresh install. Keys marked `advanced` in the schema
(the ones the Swift app keeps in its Tuning panels) fold under “Advanced”. Rows that only apply while another switch
is on are shown disabled, never hidden.

Units follow Home Assistant: percentages are 0–100 (Swift 0…1), times are minutes after midnight, chances are percent.

## Ported

| Swift path | UI section | TS key | Applied in TS | HA entity |
|---|---|---|---|---|
| `device.roomName` | Yanni | `room` | add-on: device name “Yanni ‹room›” (`applySettings` in server.ts) (max 40 here, 32 on the iPad: pairing allows 40) | — |
| `life.manualBedtime` | Sleep | `bedtime` | `lifeSettings` → `LifeCycleController.settings` | `bedtime` |
| `life.bedtimeEnabled` | Sleep | `bedtime_schedule` | `lifeSettings` → `LifeCycleController.settings` | `bedtime_schedule` |
| `life.bedtimeStart` | Sleep | `bedtime_start` | `lifeSettings` → `LifeCycleController.settings` | `bedtime_start` |
| `life.bedtimeEnd` | Sleep | `bedtime_end` | `lifeSettings` → `LifeCycleController.settings` | `bedtime_end` |
| `life.minutesToDrowsy` | Sleep | `minutes_to_drowsy` | `lifeSettings` → `LifeCycleController.settings` | `minutes_to_drowsy` |
| `life.minutesToAsleep` | Sleep | `minutes_to_asleep` | `lifeSettings` → `LifeCycleController.settings` | `minutes_to_asleep` |
| `life.bedtimeAwakeMinutes` | Sleep | `bedtime_awake_minutes` | `lifeSettings` → `LifeCycleController.settings` | `bedtime_awake_minutes` |
| `life.tapsToWake` | Sleep | `taps_to_wake` | `lifeSettings` → `LifeCycleController.settings` | `taps_to_wake` |
| `life.wakeOnMotionAtBedtime` | Sleep | `wake_on_motion_at_bedtime` | `lifeSettings` → `LifeCycleController.settings` | `wake_on_motion_at_bedtime` |
| `life.idleMoodDrift` | Playfulness | `idle_mood_drift` | `lifeSettings` → `LifeCycleController.settings` | — |
| `life.aloneTakeoverMinutes` | Sleep › Advanced (Swift: Tuning › Life) | `alone_takeover_minutes` | `lifeSettings` → `LifeCycleController.settings` | — |
| `voice.volume` | Sound | `chirp_volume` | `voiceSettings` → `VoiceDirector.settings` | `chirp_volume` |
| `voice.muted` | Sound (inverted) | `sounds` | `voiceSettings` → `VoiceDirector.settings`; `soundsOff` → `ConversationController.settings` | `sounds` |
| `voice.quietMode` | Sound | `quiet_mode` | `voiceSettings` → `VoiceDirector.settings`; `quietMode` → `ConversationController.settings` | `quiet_mode` |
| `voice.bedtimeSounds` | Sound | `bedtime_sounds` | `voiceSettings` → `VoiceDirector.settings` | — |
| `voice.autoVocalize` | Sound › Advanced (Swift: Tuning › Sound) | `auto_vocalize` | `voiceSettings` → `VoiceDirector.settings` | — |
| `voice.avOffset` | Sound › Advanced (Swift: Tuning › Sound) | `av_offset` | `voiceSettings` → `VoiceDirector.settings` | — |
| `speech.voiceVolume` | Sound | `voice_volume` | `conversationSettings` → `ConversationController.settings` | `voice_volume` |
| `speech.replyVoice` | Voice services | `reply_voice` | `voiceServicesEndpoint` → `ConversationController.endpoint`; `EmotionLayer.stanceNeedsClaim`; `replyClock` | `reply_voice` |
| `speech.showCaptions` | Voice services | `show_captions` | `conversationSettings` → `ConversationController.settings` | — |
| `speech.listeningSound` | Sound | `listening_sound` | `ConversationController.listenCue` | — |
| `speech.listenOnEyeContact` | Voice services | `listen_on_eye_contact` | `conversationSettings` → `ConversationController.settings` | `listen_on_eye_contact` |
| `look.themePreset` | Look | `theme_preset` | `StyleComposer.compose` → `ctx.setStyle` | — |
| `look.browsEnabled` | Look | `eyebrows` | `StyleComposer.compose` → `ctx.setStyle` | `eyebrows` |
| `look.browInk` | Look | `ink_brows` | `StyleComposer.compose` → `ctx.setStyle` (Swift: Tuning › Brows) | — |
| `look.browIntensity` | Look | `brow_intensity` | `applyEngine` → `FaceEngine.browIntensity` | — |
| `look.moodColorEnabled` | Look | `mood_colour` | `StyleComposer.compose` → `ctx.setStyle` | `mood_colour` |
| `look.moodColorStrength` | Look | `mood_colour_strength` | `StyleComposer.compose` → `ctx.setStyle` | `mood_colour_strength` |
| `look.listeningGlow` | Look | `listening_glow` | `listeningGlow` → `FaceEngine.listeningGlow` | `listening_glow` |
| `look.customScleraColor` | Look (Custom colours) | `custom_sclera_colour` | `StyleComposer.compose` → `ctx.setStyle` ('' = preset) | — |
| `look.customCrescentColor` | Look (Custom colours) | `custom_crescent_colour` | `StyleComposer.compose` → `ctx.setStyle` ('' = preset) | — |
| `look.moodBackground.mode` | Look | `mood_background` | `moodBackground` → `FaceEngine.moodBackground` | `mood_background` |
| `look.moodBackground.strength` | Look | `mood_background_strength` | `moodBackground` → `FaceEngine.moodBackground` | — |
| `look.moodBackground.fixedColor` | Look | `mood_background_colour` | `moodBackground` → `FaceEngine.moodBackground` | — |
| `look.moodBackground.speed` | Look | `mood_background_speed` | `moodBackground` → `FaceEngine.moodBackground` | — |
| `look.moodBackground.colourAtBedtime` | Look | `mood_background_at_bedtime` | `moodBackground` → `FaceEngine.moodBackground` | `mood_background_at_bedtime` |
| `look.moodBackground.colourBursts` | Look | `colour_bursts` | `moodBackground` → `FaceEngine.moodBackground` | — |
| `look.moodBackground.burstStrength` | Look | `burst_strength` | `moodBackground` → `FaceEngine.moodBackground` | — |
| `look.moodBackground.vignette` | Look | `mood_background_vignette` | `StyleComposer.compose` → `ctx.setStyle` | — |
| `playfulness.personality` | Playfulness | `personality` | `EmotionLayer.personality` | — |
| `playfulness.expressiveReactions` | Playfulness | `expressive_reactions` | `expressiveBudget` → `ExpressiveDecisions.budget` | `expressive_reactions` |
| `playfulness.reactionBudgetPerHour` | Playfulness | `reaction_budget_per_hour` | `expressiveBudget` → `ExpressiveDecisions.budget` | — |
| `playfulness.edgeAntics.enabled` | Playfulness | `screen_antics` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | `screen_antics` |
| `playfulness.edgeAntics.frequency` | Playfulness | `antics_frequency` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.travel` | Screen-edge antics (Swift: Tuning) | `antics_travel` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.intensity` | Screen-edge antics (Swift: Tuning) | `antics_intensity` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.timingScale` | Screen-edge antics (Swift: Tuning) | `antics_timing` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.maxHiddenSeconds` | Screen-edge antics (Swift: Tuning) | `antics_max_hidden` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.greetingChance` | Screen-edge antics (Swift: Tuning) | `antics_greeting_chance` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.postConversationChance` | Screen-edge antics (Swift: Tuning) | `antics_post_conversation_chance` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.sleepySinkChance` | Screen-edge antics (Swift: Tuning) | `antics_sleepy_sink_chance` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.quietAtBedtime` | Screen-edge antics (Swift: Tuning) | `antics_quiet_at_bedtime` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.shyPeek.enabled` | Screen-edge antics (Swift: Tuning) | `antic_shy_peek` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.shyPeek.weight` | Screen-edge antics (Swift: Tuning) | `antic_shy_peek_weight` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.shyPeek.cooldown` | Screen-edge antics (Swift: Tuning) | `antic_shy_peek_cooldown` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.popUp.enabled` | Screen-edge antics (Swift: Tuning) | `antic_pop_up` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.popUp.weight` | Screen-edge antics (Swift: Tuning) | `antic_pop_up_weight` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.popUp.cooldown` | Screen-edge antics (Swift: Tuning) | `antic_pop_up_cooldown` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.curiousLean.enabled` | Screen-edge antics (Swift: Tuning) | `antic_curious_lean` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.curiousLean.weight` | Screen-edge antics (Swift: Tuning) | `antic_curious_lean_weight` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.curiousLean.cooldown` | Screen-edge antics (Swift: Tuning) | `antic_curious_lean_cooldown` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.pretendExit.enabled` | Screen-edge antics (Swift: Tuning) | `antic_pretend_exit` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.pretendExit.weight` | Screen-edge antics (Swift: Tuning) | `antic_pretend_exit_weight` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.pretendExit.cooldown` | Screen-edge antics (Swift: Tuning) | `antic_pretend_exit_cooldown` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.sleepySink.enabled` | Screen-edge antics (Swift: Tuning) | `antic_sleepy_sink` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.sleepySink.weight` | Screen-edge antics (Swift: Tuning) | `antic_sleepy_sink_weight` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.edgeAntics.sleepySink.cooldown` | Screen-edge antics (Swift: Tuning) | `antic_sleepy_sink_cooldown` | `edgeAnticSettings` → `FaceEngine.edgeAnticSettings` | — |
| `playfulness.pupilReactions.enabled` | Playfulness | `pupil_reactions` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | `pupil_reactions` |
| `playfulness.pupilReactions.intensity` | Pupil reactions | `pupil_intensity` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.minConfidence` | Pupil reactions | `pupil_min_confidence` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.globalCooldown` | Pupil reactions | `pupil_pause` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.repeatWindow` | Pupil reactions | `pupil_repeat_window` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.moodAccent` | Pupil reactions | `pupil_mood_accent` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings`; `StyleComposer` → `shapeMoodAccent` | — |
| `playfulness.pupilReactions.star.enabled` | Pupil reactions | `pupil_star` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.star.hold` | Pupil reactions | `pupil_star_hold` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.star.cooldown` | Pupil reactions | `pupil_star_cooldown` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.heart.enabled` | Pupil reactions | `pupil_heart` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.heart.hold` | Pupil reactions | `pupil_heart_hold` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.heart.cooldown` | Pupil reactions | `pupil_heart_cooldown` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.note.enabled` | Pupil reactions | `pupil_note` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.note.hold` | Pupil reactions | `pupil_note_hold` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.note.cooldown` | Pupil reactions | `pupil_note_cooldown` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.question.enabled` | Pupil reactions | `pupil_question` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.question.hold` | Pupil reactions | `pupil_question_hold` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.question.cooldown` | Pupil reactions | `pupil_question_cooldown` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.exclaim.enabled` | Pupil reactions | `pupil_exclaim` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.exclaim.hold` | Pupil reactions | `pupil_exclaim_hold` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.pupilReactions.exclaim.cooldown` | Pupil reactions | `pupil_exclaim_cooldown` | `pupilReactionSettings` → `FaceEngine.pupilReactionSettings` | — |
| `playfulness.idleGames.enabled` | Idle games (Swift: Tuning) | `idle_games` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.frequency` | Idle games (Swift: Tuning) | `idle_games_frequency` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.intensity` | Idle games (Swift: Tuning) | `idle_games_intensity` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.timingScale` | Idle games (Swift: Tuning) | `idle_games_timing` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.pingPong.enabled` | Idle games (Swift: Tuning) | `game_ping_pong` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.pingPong.weight` | Idle games (Swift: Tuning) | `game_ping_pong_weight` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.pingPong.cooldown` | Idle games (Swift: Tuning) | `game_ping_pong_cooldown` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.basketball.enabled` | Idle games (Swift: Tuning) | `game_basketball` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.basketball.weight` | Idle games (Swift: Tuning) | `game_basketball_weight` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.basketball.cooldown` | Idle games (Swift: Tuning) | `game_basketball_cooldown` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.juggling.enabled` | Idle games (Swift: Tuning) | `game_juggling` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.juggling.weight` | Idle games (Swift: Tuning) | `game_juggling_weight` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.juggling.cooldown` | Idle games (Swift: Tuning) | `game_juggling_cooldown` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.yoYo.enabled` | Idle games (Swift: Tuning) | `game_yo_yo` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.yoYo.weight` | Idle games (Swift: Tuning) | `game_yo_yo_weight` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.yoYo.cooldown` | Idle games (Swift: Tuning) | `game_yo_yo_cooldown` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.leapfrog.enabled` | Idle games (Swift: Tuning) | `game_leapfrog` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.leapfrog.weight` | Idle games (Swift: Tuning) | `game_leapfrog_weight` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.leapfrog.cooldown` | Idle games (Swift: Tuning) | `game_leapfrog_cooldown` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.staringContest.enabled` | Idle games (Swift: Tuning) | `game_staring_contest` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.staringContest.weight` | Idle games (Swift: Tuning) | `game_staring_contest_weight` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.staringContest.cooldown` | Idle games (Swift: Tuning) | `game_staring_contest_cooldown` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.hideAndSeek.enabled` | Idle games (Swift: Tuning) | `game_hide_and_seek` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.hideAndSeek.weight` | Idle games (Swift: Tuning) | `game_hide_and_seek_weight` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.hideAndSeek.cooldown` | Idle games (Swift: Tuning) | `game_hide_and_seek_cooldown` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.catchTheFly.enabled` | Idle games (Swift: Tuning) | `game_catch_the_fly` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.catchTheFly.weight` | Idle games (Swift: Tuning) | `game_catch_the_fly_weight` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.catchTheFly.cooldown` | Idle games (Swift: Tuning) | `game_catch_the_fly_cooldown` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.danceBreak.enabled` | Idle games (Swift: Tuning) | `game_dance_break` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.danceBreak.weight` | Idle games (Swift: Tuning) | `game_dance_break_weight` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.danceBreak.cooldown` | Idle games (Swift: Tuning) | `game_dance_break_cooldown` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.hulaHoop.enabled` | Idle games (Swift: Tuning) | `game_hula_hoop` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.hulaHoop.weight` | Idle games (Swift: Tuning) | `game_hula_hoop_weight` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `playfulness.idleGames.hulaHoop.cooldown` | Idle games (Swift: Tuning) | `game_hula_hoop_cooldown` | `idleGameSettings` → `FaceEngine.idleGameSettings` | — |
| `voiceServices.conversationAgentID` | Voice services | `conversation_agent_id` | `voiceServicesEndpoint` → `ConversationController.endpoint` | — |
| `voiceServices.pipelineID` | Voice services | `pipeline_id` | `voiceServicesEndpoint` → `ConversationController.endpoint` (agent, ASR and TTS pipeline) | — |
| `voiceServices.aiTaskEntityID` | Voice services | `ai_task_entity_id` | `voiceServicesEndpoint` → `ConversationController.endpoint` | — |
| `voiceServices.jevConfigEntryID` | Voice services | `jev_config_entry_id` | `voiceServicesEndpoint` → `ConversationController.endpoint` | — |
| `voiceServices.asrLanguage` | Voice services | `asr_language` | `voiceServicesEndpoint` → `ConversationController.endpoint` (ASR and agent language) | — |
| `voiceServices.sendMoodNote` | Voice services › Advanced | `send_mood_note` | `filterReport` (conversation_context “none” while off) | — |
| `voiceServices.thinkingTimeoutSeconds` | Voice services › Advanced | `thinking_timeout_seconds` | `conversationSettings` → `ConversationController.settings` | — |
| `homeAssistant.defaultAnnouncementExpiryMinutes` | Home Assistant | `announcement_expiry_minutes` | add-on: notify expiry (mqtt.ts, server.ts) | — |
| `privacy.snapshotsEnabled` | Privacy | `room_understanding` | hub: always off (no encrypted vision path; Swift `SceneModel`) | `room_understanding` |
| `privacy.snapshotIndicator` | Privacy › Advanced | `snapshot_indicator` | stored only (room understanding can’t turn on yet) | — |
| `privacy.sharePresence` | Privacy | `share_presence` | `filterReport`; add-on: presence entities (entities.ts) | — |
| `access.developerTools` | Access | `developer_tools` | read by the owner menu (Tuning entry) | — |
| `access.pinPromptShown` | Access › Advanced | `pin_prompt_shown` | `openSettingsPanel` (first-open “Set a PIN?”) | — |
| `kiosk.restartVerified` | Kiosk | `restart_verified` | `kioskSlice` → `onKiosk` | — |
| `kiosk.selfRestartOnHang` | Kiosk | `self_restart_on_hang` | `kioskSlice` → `onKiosk` (`hangRestartArmed`) | — |
| `kiosk.maintenanceRestart` | Kiosk | `maintenance_restart` | `kioskSlice` → `onKiosk` (`maintenanceRestartArmed`) | — |
| `kiosk.oledBackgroundBudget` | Kiosk | `oled_background_budget` | `kioskSlice` → `onKiosk` / `styleTransform` (KioskApply.style) | — |
| `kiosk.displayOverride` | Kiosk › Advanced | `display_kind` | `kioskSlice` → `onKiosk` | — |
| `tuning.pinStyle` | Developer | `pin_style` | hub: persists / syncs `tuning_style` only while on | — |
| `tuning.style` | Developer | `tuning_style` | `StyleComposer.compose` → `ctx.setStyle` (the developer style under the owner fields) | — |
| `emotion (DeveloperSection)` | Developer | `emotion_tunables` | `emotionSettings` → `EmotionLayer.settings` | — |
| `perception (DeveloperSection)` | Developer | `perception_tunables` | `perceptionSettings` → `PerceptionHandle.setSettings` | — |
| `UserDefaults yanni.turnTunables (Tuning › Listening)` | Developer | `turn_tunables` | `turnTunables` → `ConversationTurnDetection.setTunables` (outside YanniSettings in Swift; synced here) | — |

## Display-local

Not synced, and never set from Home Assistant or the owner pages:

| Swift path | UI section | Where | Why |
|---|---|---|---|
| `access.pinEnabled` | Access | `OwnerAccess` (web/src/app/OwnerAccess.ts): the salted hash in the display's local storage; “PIN required” = a hash is stored | A forgotten PIN can only be cleared by Reset all settings on the display, never from Home Assistant (spec); a synced flag would let the add-on turn the gate off. |

## Not applicable on the web

| Swift path | Why | Instead |
|---|---|---|
| `voiceServices.homeAssistantURL`, `voiceServices.allowInsecureLocalHTTP` | The browser never holds an HA address or token: the add-on relays a whitelisted set of HA calls with its Supervisor token (server/src/relay.ts). | Settings › Voice services shows the add-on's Home Assistant status (read-only). |
| `voiceServices.asrEngine`, `asrHost`, `asrPort`, `ttsRoute`, `ttsHost`, `ttsPort`, `ttsVoice`, `ttsSpeaker` | A browser has no on-device recogniser and no raw TCP, and the relay has no Wyoming path: speech recognition and the speech voice are the Assist pipeline's. | `pipeline_id` picks the pipeline (its STT and TTS); `asr_language` is kept. |
| `homeAssistant.enabled`, `host`, `port`, `tls`, `pinnedCA`, `leafPinSHA256`, `username`, `discoveryPrefix` | The iPad's own MQTT broker connection: the add-on connects to the broker (Supervisor MQTT service or its options) for every display. | Owner pages › header shows the add-on's MQTT status. |
| `privacy.snapshotConsentVersion`, `snapshotConsentAt`, `snapshotsLastOffByHomeAssistant` | Consent bookkeeping for room understanding, which can't be turned on anywhere yet (no encrypted vision path; the Swift switch is disabled too). | `room_understanding` stays off; Home Assistant and the owner pages may only send off. |
| `kiosk.backlightFollowsSleep` | A web page can't set the panel backlight. | The face dims itself (Brightness / power care). |

## Home Assistant entities

The setting entities are exactly the iPad's (`HomeEntities.all`), with the same components, names, options and
unique_ids (`yanni_<id>_<component>`); no setting entity was added or renamed. The full discovery payload is pinned by
`server/test/__snapshots__/mqtt.test.ts.snap`.
