# Changelog

All notable changes to this module are documented here.

## [3.5.14] - 2026-08-31

Migrates the module from Companion module API 1.12 (Companion 4.0-era) to API 2.1 (Companion
5.0+), fixes a set of correctness and performance bugs found while doing that migration and
verifying it against a real Yamaha DM3 console, and adds two small features. Based on `3.5.13`
(the commit before #67's fader-fade work was merged) rather than `v3.6.0`/current `master`, so
this can be reviewed independently of that in-progress work.

### Changed

- `@companion-module/base` `^1.12.0` → `^2.1.3`; `@companion-module/tools` `^2.0.0` → `^3.0.2`.
- Manifest `runtime.type` `node18` → `node22`; added the now-required top-level `"type":
  "connection"` field.
- Removed all use of `context.parseVariablesInString()` (deleted from the API); option fields
  that need variable substitution now declare `useVariables: true` and Companion resolves them
  before the module ever sees the value.
- Module bootstrap no longer calls `runEntrypoint()` (removed from the API); `index.js` now
  exports the instance class as a default export, with upgrade scripts as a separate named
  `UpgradeScripts` export.
- `setVariableDefinitions()` now takes an object keyed by variable id instead of an array.
- `setPresetDefinitions()` now takes a `(structure, presets)` pair instead of a flat array,
  grouped into named sections instead of a per-preset `category` string. Preset action/feedback
  options are filtered to only the keys the target parameter actually declares (previously every
  preset unconditionally set every option key, which Companion 5 validates and warns about).
- `checkFeedbacks()` calls are now batched: value changes are collected and flushed as one
  `checkFeedbacks(...ids)` call per tick instead of one call per changed address, and a scene
  recall no longer wipes the whole cache before resyncing (it re-requests everything but only
  re-checks feedbacks whose value actually changed) - see "Fixed" below for the bug this closes.
- The command queue drains everything it can into one batched TCP write per tick instead of
  pacing one send per fixed 5ms timer regardless of load.
- `findRcpCmd()` is backed by a lookup table built once when the parameter file loads, instead of
  a linear scan doing a fresh string allocation per candidate on every send/receive.
- Every fader-level channel (input channels, stereo inputs, FX returns, mixes, matrices, ST) now
  gets a name/level/on-state variable automatically on connect, instead of only existing once a
  feedback with "Auto-Create Variable" happens to be placed on a button.
- Advanced feedbacks (`VUMeter`, per-parameter colour feedbacks) now declare
  `affectedProperties`, as Companion 5 uses this to avoid presenting a wall of irrelevant style
  overrides to the user.
- Feedback `isVisible` function callbacks replaced with the string-based `isVisibleExpression`
  (the function form still runs today but is deprecated and logged as such by Companion).

### Added

- **DM3 remote head-amp gain and 48V phantom power** for a Dante-connected Rio-class stagebox (16
  channels), as actions/feedbacks on the three `IO:Current/PortToPort/*` parameters. Gate any UI
  on `HAAvailability` - it reads `0` (and gain/phantom reads and writes get refused) until a
  remote head-amp is actually patched; that's expected behaviour on a system with no Rio-class
  device on the Dante network, not a fault.
- **New config option: "Allow Scene Store?"** (default off). Companion has no native "confirm
  before running" for actions, so storing a scene - which overwrites it on the console with no
  confirmation and no undo - is now gated behind this checkbox. An accidental Scene Store press
  does nothing (logged as a warning) unless deliberately enabled.

### Fixed

- **23 `InputChLink` parameters on the DM3 were silently dropped.** The shipped parameter table
  has them missing their leading `OK` token (space-indented to the same width instead) - a data
  typo, not anything the console itself ever sends. The parser now restores the implicit token;
  all 23 actions/feedbacks now appear.
- **A second configured instance could silently corrupt the first's state.** `global.config` and
  `global.rcpCommands` were shared mutable slots read throughout the module; a DM3 plus a Rio
  stagebox (or any two instances) would clobber each other's config and parameter table on every
  `init()`/`newConsole()`. Both now live on the instance itself.
- **The KeepAlive timer leaked on `destroy()`** - a deleted connection with KeepAlive enabled kept
  sending `devstatus runmode` indefinitely. Now cleared alongside the other timers.
- **A malformed X/Y option silently killed the whole action.** The multi-channel `[1,2,3]` array
  syntax was implemented as a bare `JSON.parse()`; anything else typed into that field threw
  inside the callback with no visible error. Now falls back to treating unparseable input as a
  single literal value.
- **Recalling a scene could cause a multi-second freeze on busy pages.** The recall handler wiped
  the entire local value cache before re-requesting everything; since the console doesn't report
  what changed, every value that came back looked like a change, storming a feedback
  re-evaluation for every address on the page even when the recall only touched a few of them
  (this is also the cause of upstream #44, feedbacks re-firing on scene recall with no actual
  value change). The cache is no longer wiped - see "Changed" above.
- **DM3 metering was broken for anything beyond a single mono channel** (stereo meters only
  showing the left channel, some meter types showing nothing at all, FX return meters always
  showing channel 1). The shipped DM3 parameter table synthesises a collapsed 6-row meter table
  with an invented address segment and an invented multi-value axis; the console's own real
  enumeration is 17 flat, one-address-per-pickoff rows. Rebuilt the DM3 meter table from a live
  probe of the real enumeration, which needed one new DM3-specific branch in `findRcpCmd` (the
  real addresses need no reconstruction, unlike the synthesised form) - `fmtCmd` needed no
  changes, since its already-existing Pickoff-optional handling already supported this shape.
- **A TCP receive-handler bug could silently corrupt a response split across two packets.** The
  two branches handling "did this chunk end on a line boundary" were swapped, so a chunk that
  split a line mid-way had its incomplete tail processed as if complete instead of held for the
  rest to arrive. Normally invisible (most chunks land on a boundary by luck), far more likely
  under a heavy rapid-line stream (e.g. several concurrent meter subscriptions).
- Repeated identical network errors during an outage no longer spam the log - the reconnect
  itself was already automatic via `TCPHelper`, this only dedupes the logging.
- `parseData()`'s `'mtr'` case mutated a shared field-name array in place instead of copying it.
  Harmless under every current call site, but no longer relies on that staying true.
- A handful of flat, non-nested objects on hot paths (a received message, a queued command, a
  parsed action/feedback option set) were being deep-cloned with `JSON.parse(JSON.stringify(...))`
  on every use; replaced with an equivalent, much cheaper shallow copy.
- Two `static-text` config fields (the layout spacer and the KeepAlive warning) had no `id` at
  all and silently collided; both now have unique ids.
- Fade dropdown-adjacent option fields, and a couple of other spots, now tolerate an
  already-saved value that doesn't match a declared choice by type (`allowCustom: true`) instead
  of failing "value is not in the list of choices" - pre-2.x Companion always saved dropdown
  selections as strings regardless of the declared choice type, so older buttons could otherwise
  fail to load.

### Known limitations

- **A feedback's `Val` option can no longer write a custom variable via `@(custom:...)`.** This
  was a documented feature; Companion's module API removed `setCustomVariableValue` from feedback
  callback contexts entirely as of API 2.0 (it remains available, deprecated, for actions only).
  There is no replacement - using this syntax inside a feedback's Val option now logs a one-time
  warning and does nothing.

All of the above was verified against a real Companion 5.0.4 install and a live DM3 console
(action/feedback toggling, the metering rebuild, the KeepAlive fix, the scene-recall resync, and
the auto-populated channel variables were each independently confirmed live). No user-facing
behaviour changes are intended beyond what's listed above - existing pages and buttons should
otherwise behave identically.
