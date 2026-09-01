# Changelog

All notable changes to this module are documented here. See [PLAN.md](PLAN.md) for the full
research and rationale behind each change.

## [3.12.2] - 2026-09-01

### Fixed

- **Preset option-filtering was a silent no-op since it shipped in Phase 1.**
  `createPresets()`'s `getDeclaredOptionIds()` called `findRcpCmd(id)` instead of
  `findRcpCmd(this, id)` — since C1 added the required `instance` argument, this always returned
  `undefined` without ever throwing, so every preset kept shipping every option key regardless of
  what its target actually declares. This is exactly the "unknown option key" warning the feature
  was built to suppress. Found while reconstructing the upstream contribution onto 3.5.13; fixed
  here too. Verified via `yarn lint`, a clean build, and the existing smoke test (identical preset/
  action/feedback counts — the fix changes what happens inside the filter, not whether presets
  generate). Not separately re-confirmed against a live Companion install; low-risk since it only
  affects which option keys Companion logs warnings about, not control behavior.

## [3.12.1] - 2026-08-28

Narrows Exclusive Mic Mode's default channel list from v3.12.0's `1,2,3,4,5,6,15,16` to `3,4`.
Exclusive Mic Mode itself still defaults to off, so this closes a footgun rather than fixing a live
bug: the old default assumed every listed channel was mutually exclusive, but on install it's
common for two channels to be legitimate simultaneous copies of the same physical mic (one to a
stream/send mix, one to local reinforcement) - enabling the feature with that default would turn
one off the instant the other opened. `3,4` is a safer, clearly-a-placeholder starting point;
review it against your own routing regardless before enabling the feature.

## [3.12.0] - 2026-08-28

Phase 5 P2: mic on-air monitor dim + exclusive mic mode (PLAN.md §9). **Built and logic-tested
against a local simulation only, at the user's explicit request to hold all real-console testing
until they're back on premise - never verified against real hardware or in the room.** Both new
options default to off; nothing changes for anyone who doesn't turn them on.

### Added

- **Monitor Auto-Dim** (off by default): dims the Monitor fader by a configurable amount, using the
  existing fade engine for a smooth transition, whenever any channel listed in the new "Mic Channel
  Numbers" option is on - and restores it to the exact level it was at before dimming once they're
  all off again, not a fixed target.
- **Exclusive Mic Mode** (off by default, independent of Monitor Auto-Dim): the instant one listed
  mic channel turns on, every other listed mic channel is immediately turned off.
- Which channels count as "microphones" is entirely configurable (new "Mic Channel Numbers" option,
  comma-separated, defaults to this studio's own patch: 1,2,3,4,5,6,15,16) - not hardcoded, since
  that's a studio-specific patch decision other installs would need to set differently.

### Known limitations

- **Not verified against a real console or in a real room.** Confirmed correct against a scripted
  local simulation (dim math, exact restore, exclusive-mode enforcement, no crashes) but that
  cannot confirm the feature sounds right or is safe in an actual room with live microphones and
  reinforcement. Test carefully, with someone listening, before relying on this for a live show.

## [3.11.1] - 2026-08-28

Bug fix (C9, PLAN.md §8) found while investigating a crash noticed during Phase 4's own testing -
not part of any planned phase.

### Fixed

- **A TCP response split across two network packets in the middle of a line could be silently
  corrupted or crash the connection.** The receive handler's two line-reassembly branches were
  swapped: a chunk that ends exactly on a line boundary was (correctly, if accidentally) handled the
  same as one that doesn't, but a chunk that cuts a line in half had its still-incomplete tail
  treated as a complete line instead of being held for the rest to arrive. Invisible under normal,
  lightly-loaded traffic - most chunks happen to land on a line boundary - but far more likely to
  actually happen under a heavy stream of rapid lines, e.g. several concurrent meter subscriptions.
  Confirmed both the bug and the fix without touching the real console: a local loopback server
  deliberately splitting a response mid-line showed the old code silently losing the value
  entirely (not even a crash, worse - silent data loss) and the fixed code reassembling it
  correctly. Also added a defensive guard in the variable-update code so any other malformed-line
  edge case drops that one line instead of crashing the connection.

## [3.11.0] - 2026-08-28

Phase 5 P1: auto-populated channel variables (PLAN.md §9). Everything else in Phase 5 (mic on-air +
monitor dim, studio presets) needs live audio verification with the user present and was not
attempted - see PLAN.md's Phase 5 writeup.

### Added

- **Every fader-level channel (input channels, stereo inputs, FX returns, mixes, matrices, ST,
  monitor) now gets a name/level/on-state variable automatically as soon as the module connects** -
  no need to place a feedback with "Auto-Create Variable" on some button first just to get a
  channel's name or level available as a variable. Reuses the exact same naming and value-formatting
  a manually auto-created variable already used (`getAutoVariableName`, added in v3.10.0 for the
  metering fix), so this can't drift out of sync and doesn't create a second, differently-named
  variable for a channel someone already has a manual one for.

### Known limitations

- One fader type, `Fx`, declares a second value per channel in its parameter table that turned out
  to be invalid on this console when actually queried (`InvalidArgument`) - only its first value is
  covered by this feature. Every other fader type is fully covered.

## [3.10.0] - 2026-08-28

Phase 4: DM3 metering rebuild (fixes C6) and new Dante remote head-amp parameters (PLAN.md §4.5,
§5.3, §9).

### Fixed

- **DM3 metering was fundamentally broken** - stereo meters (`St`) only showed the left channel,
  some meter types (`StInCh`) showed nothing at all, and FX return meters always showed channel 1
  regardless of which channel was selected. Root cause: the shipped parameter table invented a
  collapsed address shape (e.g. a single `Meter/InCh` row covering three real pickoffs via a
  fabricated "Pickoff" axis) that doesn't match what the console actually sends - the real console
  exposes 17 flat, one-address-per-pickoff meter rows (confirmed via a live sweep), and the
  invented reconstruction was transposing them. DM3's meter table now uses the console's own real
  addresses directly; the shared lookup/formatting code already handled this shape correctly for
  other cases (it needed one new DM3-specific branch, not the wider rewrite originally expected).
  Every other model's meter handling is untouched and was verified byte-for-byte identical for
  their address-resolution logic.
- **A meter/VU bar's displayed value could never actually populate**, on every model, not just
  DM3 - a preset's predicted auto-created-variable name and the name the variable actually gets
  created under were computed by two independently hand-maintained formulas that had drifted out of
  sync (found while fixing the DM3 issue above). Both now go through one shared helper
  (`getAutoVariableName`), so this can't silently drift again.

### Added

- **Dante remote head-amp gain and 48V phantom power** (`IO:Current/PortToPort/HAGain`,
  `IO:Current/PortToPort/48VOn`) for a Rio-class stagebox on the Dante network, plus
  `IO:Current/PortToPort/HAAvailability` to detect whether one is actually patched. These 3
  parameters exist on this firmware line but were never in the module before.

### Known limitations

- **The Dante remote-HA gain/phantom read-write path is implemented per the documented protocol
  but not live-verified** - this console has no Rio-class device on its Dante network right now, so
  `HAAvailability` correctly reads `0` and any attempt to read or write gain/phantom is correctly
  refused by the console (`AccessDenied`), which is exactly the documented behaviour with nothing
  patched - but the actual working gain/phantom control path has no way to be exercised without one.

## [3.9.0] - 2026-08-27

Phase 3: performance (PLAN.md §7, §9). No user-facing behaviour changes are intended - buttons and
feedbacks should look and respond the same, just faster, especially right after a scene recall and
under metering load.

### Fixed

- **Recalling a scene no longer causes a multi-second freeze on busy pages.** `pollConsole()` used
  to wipe the entire local value cache and re-request everything; since the console doesn't report
  what changed, every value that came back looked like a *change*, storming a feedback re-evaluation
  for every address on the page even when the recall only touched a few of them (this was also the
  cause of upstream #44, feedbacks re-firing on scene recall with no actual value change). The cache
  is no longer wiped - everything is still re-requested fresh, but a feedback is only re-evaluated
  for addresses whose new value actually differs from what was cached. Same network traffic, no
  storm, no spurious re-fires. Verified live: seeded real cached values, corrupted one to simulate a
  changed parameter, and confirmed the resync restored it while re-checking only that one feedback.
- **The command queue no longer paces every send 5ms apart regardless of load.** A queued command
  used to wait for a fixed timer tick even when the socket was completely idle and the console ready
  for more - a hard ceiling of ~200 commands/second. The queue now drains everything it has into one
  batched TCP write as soon as it's non-empty, verified live (a burst of queued reads went out as a
  single write instead of one per command). A `set` waiting on a live value it doesn't have yet
  (Toggle/relative actions) no longer blocks unrelated commands queued behind it.
- **Looking up a parameter's definition is no longer a linear scan.** `findRcpCmd()` did a fresh
  string allocation per candidate on every received message, every action, and every feedback check
  - up to 177 allocations per lookup on DM3, far more on Rivage. Now backed by a lookup table built
  once when the parameter file loads. Verified byte-for-byte identical to the old scan across all 8
  supported models (888 lookups compared, 0 differences), including the meter-address rewriting path
  that still needs the old scan as a fallback.
- **A meter frame no longer re-evaluates feedbacks once per channel.** Metering updates (and any
  other burst of near-simultaneous value changes) are now collected and applied to feedbacks in one
  batch per tick instead of one re-evaluation per individual value change.
- **A burst of newly auto-created variables no longer rebuilds the variable list once per
  variable.** This is very likely what upstream #64 ("plugin restarts when a lot of data comes in")
  was actually hitting - a channel strip full of auto-created DCA level variables appearing at once
  each triggered its own full variable-definitions rebuild and its own value-update call. Both are
  now batched to at most one of each per tick.
- A few flat, non-nested objects on hot paths (a received message, a queued command, a parsed
  action/feedback option set) were being deep-cloned with `JSON.parse(JSON.stringify(...))`;
  replaced with an equivalent, much cheaper shallow copy. Left alone: a handful of other deep clones
  elsewhere in the module clone genuinely nested objects (preset definitions, action-to-feedback
  conversion, upgrade scripts) where a shallow copy would share arrays that get mutated independently
  - none of those run on a hot path, so there was nothing to gain by touching them.

## [3.8.0] - 2026-08-27

Phase 2: correctness and safety fixes (C0–C3, C5, C7, C8 from PLAN.md §8; C4 was already fixed as
a side effect of Phase 1; C6 stays deferred to Phase 4).

### Added

- **New config option: "Allow Scene Store?"** (default **off**). Companion has no native
  "confirm before running" for actions, so storing a scene - which overwrites it on the console
  with no confirmation and no undo - is now gated behind this checkbox. An accidental Scene Store
  press does nothing (logged as a warning) unless deliberately enabled.

### Fixed

- **23 `InputChLink` parameters were silently dropped.** The shipped DM3 parameter table has them
  missing their leading `OK` token (space-indented to the same width instead) - a data typo, not
  anything the console itself ever sends. The parser now restores the implicit token; all 23
  actions/feedbacks now appear.
- **A second configured instance could silently corrupt the first's state.** `global.config` and
  `global.rcpCommands` were shared mutable slots read throughout the module; a DM3 plus a Rio
  stagebox (or any two instances) would clobber each other's config and parameter table on every
  `init()`/`newConsole()`. Both now live on the instance itself. Verified directly: two
  simultaneously-configured instances produce completely independent action/feedback sets.
- **The KeepAlive timer leaked on `destroy()`** - a deleted connection with KeepAlive enabled kept
  sending `devstatus runmode` indefinitely. Now cleared alongside the other timers. Verified live
  against a real console: after `destroy()`, no further commands are sent even after waiting past
  the keepalive interval.
- **A malformed X/Y option silently killed the whole action.** The multi-channel `[1,2,3]` array
  syntax was implemented as a bare `JSON.parse()`; anything else typed into that field threw
  inside the callback with no visible error. Now falls back to treating unparseable input as a
  single literal value.
- **Repeated network errors during an outage could flood the log.** The reconnect itself was
  already automatic as of the Phase 1 `TCPHelper` upgrade; this only dedupes the logging - a
  repeated identical error message is now logged once, not once per retry.
- `parseData()`'s `'mtr'` case mutated a shared field-name array in place instead of copying it.
  Harmless under every current call site (each only ever processes one line at a time), but no
  longer relies on that being true.
- **`yarn lint` now actually runs and passes.** `eslint`/`prettier` weren't installed despite
  being expected as peer dependencies; added both plus a project `eslint.config.mjs`. Also cleaned
  up the ~13 real (all pre-existing, all non-behavioural) issues this surfaced once it could run.

## [3.7.0] - 2026-08-25

Phase 1 of the broadcast-studio rework: migrates the module from Companion module API 1.12
(Companion 4.0-era) to API 2.1 (Companion 5.0+). Verified end-to-end against a real Companion
5.0.4 install and a live DM3 console. No user-facing feature changes are intended — existing
pages and buttons should behave identically, aside from the one unavoidable exception noted
under Known limitations below.

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
- `setPresetDefinitions()` now takes a `(structure, presets)` pair instead of a flat array;
  presets are grouped into named sections instead of carrying a per-preset `category` string.
  Preset action/feedback options are now filtered to only the keys the target parameter actually
  declares (previously every preset unconditionally set `X`/`Y`/`Fade`/`Rel`, which Companion 5
  now validates and warns about).
- `checkFeedbacks()` with no arguments (only used on scene-recall resync) replaced with
  `checkAllFeedbacks()`.
- Advanced feedbacks (`VUMeter`, `LevelMeter`, per-parameter colour feedbacks) now declare
  `affectedProperties`, as Companion 5 uses this to avoid presenting a wall of irrelevant style
  overrides to the user.
- Feedback `isVisible` function callbacks replaced with the string-based `isVisibleExpression`
  (the function form still runs today but is deprecated and logged as such by Companion).

### Fixed

- **VU/Level meter bars now actually render.** Two independent bugs, both silent (no error,
  just nothing drawn): the API now wants `imageBuffer` as a base64 string, not the raw `Buffer`
  the module was still returning; and `companion-module-utils` writes pixels as **ARGB**, not
  **RGBA** as declared — since every meter colour (green/orange/red) has a zero blue channel,
  the true blue byte was being read as alpha, making every bar pixel fully transparent.
- Fade dropdown (`Fade` option on fader-level actions) now tolerates whatever type is already
  saved on a button (`allowCustom: true`), rather than requiring an exact match against the
  choice list — pre-2.x Companion always saved dropdown selections as strings regardless of the
  declared choice type, so older buttons would otherwise fail to load with "value is not in the
  list of choices".
- Two `static-text` config fields (the layout spacer and the KeepAlive warning) had no `id` at
  all and silently collided; both now have unique ids.
- Three pre-existing implicit-global bugs (C4), invisible under old-style CommonJS but hard
  `ReferenceError`s once bundled into strict-mode ESM (which is how the module is now built and
  loaded): the upgrade-script definitions in `upgrade.js`, and a bare loop counter each in
  `paramFuncs.parseData` and `actions.createAction`.
- `imageBuffer`-returning feedbacks now also supply `imageBufferEncoding: { pixelFormat: 'ARGB'
  }` and an explicit `imageBufferPosition` covering the full button.

### Known limitations

- **A feedback's `Val` option can no longer write a custom variable via `@(custom:...)`.** This
  was a documented feature (see `companion/HELP.md`); Companion's module API removed
  `setCustomVariableValue` from feedback callback contexts entirely as of API 2.0 (it remains
  available, deprecated, for actions only). There is no replacement — using this syntax inside a
  feedback's Val option now logs a one-time warning and does nothing. If any existing page relies
  on this, it needs to be rebuilt using "Auto-Create Variable" instead.
- `yarn lint` does not currently run — `eslint` is expected as a peer dependency by
  `@companion-module/tools` but isn't installed. Pre-existing gap, not introduced here.

See [PLAN.md §9 Phase 1 addendum](PLAN.md#phase-1-addendum--what-p11p15-undersold-found-by-installing-the-real-package)
for the full detail behind each of these, including how each was verified.
