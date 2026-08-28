## Yamaha Remote Control Protocol - v3.12.0

Please visit https://discourse.checkcheckonetwo.com for help, discussions, suggestions, etc.

This module is not developed by Yamaha and as such Yamaha accepts no liability for the usage of this module. Yamaha also has no responsibility to support this module.

_Andrew Broughton, 2025_

---

**Instructions**

Note that this module only works to connected hardware. It does not work with the Editor.

**MACROS** ("Learn" Function)

> _Macro Preset is not available in this version, so please download the Macro Button page from https://discourse.checkcheckonetwo.com/t/macro-page-for-yamaha-rcp-and-midi-module_

> Macros utilize the new Action Recorder feature in v3, and will only work while connected to a console.

> Using one of the buttons you imported from the link above, press and hold the **REC Macro** button for 3 seconds to reset it. It will turn green and show **Ready to Record**. Press and hold it again to start recording. When it shows **REC Step: 0**, start doing stuff on the console. The Steps will increase as you add operations. Press it again to stop recording. All the actions you performed are now stored to that button. The button's name will change to **New Macro**. To reset the button and start again, simply press and hold the button for 3 seconds again until it turns green.

> Don't forget that you can create a macro by pressing a SD button (while recording) that already has actions on it while a console is connected.The new Macro will have those commands in it as well as any you added before you pressed the button or after!

**FADES**

> Recalling a scene from the console surface while Companion fades are running can cause unexpected fader movement, because the console recall and Companion fade updates may both write fader values at the same time.

> Scene recalls triggered from Companion actions or Companion scene recall presets are handled correctly and will cancel active fades before the recall is sent.

> Keep **Cancel fades on scene recall?** enabled unless you have a specific reason not to. The conservative defaults are 6 maximum concurrent fades, a 40 ms fade step interval, and an 80 ms metering interval for CL/QL consoles.

**SCENE STORE**

> Storing a scene overwrites it on the console with the current state - there is no confirmation
> and no undo. **v3.8.0:** any Scene Store action is now ignored (and logged as a warning) unless
> **Allow Scene Store?** is checked in the connection's config. It defaults to off - turn it on
> deliberately if you actually need a Scene Store button.

**VARIABLES**

> Select "Auto-Create Variable" to create a variable in the form **CommandName_Ch#** or **CommandName_Ch#\_Mix#**

> Use **@(custom:MyCustomVar)** in the value field to update a custom variable from an **action**. Custom variable must already exist.
>
> **v3.7.0:** Companion's module API no longer allows a *feedback* to write a custom variable this way (only actions can). If you were relying on `@(custom:...)` inside a feedback's Val option, that write no longer happens — use "Auto-Create Variable" and the module's own variable instead.

**METERING (DM3)**

> **v3.10.0:** DM3 metering is now driven from the console's own real meter addresses instead of a
> hand-built table, fixing several long-standing bugs (stereo meters only showing the left channel,
> some meter types showing nothing at all, FX return meters always showing channel 1). If you built
> meter feedbacks/presets on an older version, they'll still work - the underlying data changed, not
> the action/feedback names.

**DANTE REMOTE HEAD-AMP CONTROL (DM3)**

> **v3.10.0:** remote head-amp gain and 48V phantom power for a Dante-connected Rio-class stagebox
> (16 channels) are now available as actions/feedbacks. **`HAAvailability`** tells you whether a
> remote head-amp is actually patched right now - it reads `0` (and gain/phantom reads and writes
> get refused by the console) until one is. This is normal on a system with no Rio-class device on
> the Dante network, not a fault - check `HAAvailability` before building a button around gain/48V.

**MIC ON-AIR / MONITOR DIM (EXPERIMENTAL)**

> **v3.12.0:** two new, independent, off-by-default connection options: **Enable Monitor
> Auto-Dim?** dims the Monitor bus by a configurable amount whenever any channel listed in **Mic
> Channel Numbers** is on, and restores it to the exact level it was at before dimming once they're
> all off again. **Exclusive Mic Mode?** turns off every other listed channel the instant one of
> them turns on. Either can be used alone. **This has been built and tested against a local
> simulation only, never against a real console** - verify carefully (with someone actually
> listening in the room) before relying on it for a live show, especially if your room has any kind
> of open-mic reinforcement (voice lift, IFB, etc.) where a dimming mistake could cause feedback.

**AUTO-POPULATED CHANNEL VARIABLES**

> **v3.11.0:** every fader-level channel (input channels, stereo inputs, FX returns, mixes,
> matrices, ST, monitor) now gets a name/level/on-state variable automatically on connect - you no
> longer need to place an "Auto-Create Variable" feedback on a button first just to get a channel's
> name or level as a variable. These use the same naming as a manually auto-created variable (e.g.
> `V_InCh_Fader_Level_1`), so anything already relying on that naming keeps working unchanged.

**DYNAMIC CHANNEL PARAMETERS**

> If you add color feedback for a button, (e.g. InCh/Label/Color or DCA/Label/Color), the module will pull the color from the matching channel and change the button color accordingly.

> On larger systems, the Presets page can feel slow while it is open because Companion actively requests the dynamic information needed by the preset buttons currently displayed on screen, such as channel names, fader values, meters, cue state, and other feedback data.
