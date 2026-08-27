# Changelog

All notable changes to this module are documented here. See [PLAN.md](PLAN.md) for the full
research and rationale behind each change.

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
