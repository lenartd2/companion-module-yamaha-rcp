# Yamaha RCP → Broadcast Studio Module

**A working plan and handoff document.**
Everything here is either measured against the live console or cited to source. Where something is
an assumption, it says so.

---

## Contents

1. [Orientation](#1-orientation) — what this project is, in one page
2. [The system as it exists](#2-the-system-as-it-exists) — console, patch, scenes, network
3. [How we know what we know](#3-how-we-know-what-we-know) — research method, reproducible
4. [The RCP protocol, as observed](#4-the-rcp-protocol-as-observed) — wire reference
5. [What the DM3 exposes — and what it doesn't](#5-what-the-dm3-exposes--and-what-it-doesnt)
6. [The module: architecture walkthrough](#6-the-module-architecture-walkthrough)
7. [Findings: performance](#7-findings-performance)
8. [Findings: correctness](#8-findings-correctness)
9. [Plan of work](#9-plan-of-work)
10. [Build, install, test](#10-build-install-test)
11. [Paths and reference material](#11-paths-and-reference-material)
12. [Open questions and assumptions](#12-open-questions-and-assumptions)

---

## 1. Orientation

We are improving the Bitfocus Companion module
[`companion-module-yamaha-rcp`](https://github.com/bitfocus/companion-module-yamaha-rcp) so it can
drive a Yamaha DM3 in a broadcast studio. Two complaints started this: **it's laggy**, and **it
doesn't do enough**. Both turned out to be real, and both are diagnosable in the source.

**Three things a newcomer should absorb before touching code:**

1. **Work is based on the `v3.6.0` tag, not `master`.** `master` is v3.5.13; `v3.6.0` is 34 commits
   ahead and was pulled from the Bitfocus store before release. It contains a fader fade engine,
   fader-level variables and fader/scene presets — roughly 800 added lines in `index.js`. Don't
   rebuild any of that. See [§6.1](#61-which-version-were-on).
2. **The module is three module-API generations behind the host.** It pins
   `@companion-module/base` to `^1.12.0`; Companion 5.0.4 wants `^2.1.3`. The API function the
   module leans on hardest for every feedback evaluation *was deleted* in API 2.0. Migrating is
   Phase 1 and it deletes the largest performance problem rather than optimising it. See
   [§7.1](#71-every-feedback-evaluation-does-three-async-ipc-round-trips).
3. **The DM3's remote-control surface is much smaller than it looks.** We enumerated it exhaustively.
   There is no Automixer, no input EQ/dynamics, no recorder transport over RCP — those aren't
   module gaps, they're protocol limits. See [§5](#5-what-the-dm3-exposes--and-what-it-doesnt).
   This kills several plausible-sounding feature ideas; read it before promising anything.

---

## 2. The system as it exists

### 2.1 Console and network

| | |
|---|---|
| Model | Yamaha **DM3** (the Dante-equipped model, not DM3 STANDARD) |
| Firmware | **V3.00** |
| Device name | `Y001-Yamaha-DM3-006b40` |
| **RCP control** | **`192.168.128.9` : TCP 49280** — see note below |
| Dante interface | `192.168.128.12` (advertises `_netaudio-arc._udp` as `BROOKLYN3-006b40.local`) — unconfirmed since the address change, worth re-checking |
| Run mode | `normal` |

**The RCP control address changed from `192.168.128.24` (original research) to `192.168.128.9`**,
noticed 2026-08-25 and re-confirmed live (`devinfo devicename` still answers
`Y001-Yamaha-DM3-006b40`, same physical console, firmware unchanged). Whether the Network port is
on a static IP or DHCP isn't recorded anywhere — if it's DHCP, this can drift again and **every
`192.168.128.24` reference anywhere in Companion's connection config, or in a script, needs
checking**, not just this document. Worth asking whoever manages the studio network which it is.

**The DM3 has two separate network interfaces.** The *Network* port ("For Mixer Control" in
`SETUP → NETWORK`) carries RCP, StageMix, MonitorMix and OSC. The *Dante* port carries audio and
Dante control. They are different IP addresses even when they sit on the same subnet, as they do
here. **RCP is on the Network port only** — connecting to the Dante address gets you nothing on
49280. This trips people up.

Other Dante devices visible on the network: Shure, Sennheiser (stage / ceiling / wireless), Fohhn
amplifier, `Regie-30-0f`, `ABX-6-2b7364`.

Companion itself is **not** installed on the development Mac — it runs elsewhere in the studio.
Plan for a copy-to-target step when installing dev builds ([§10](#10-build-install-test)).

### 2.2 The studio patch

Read live from the console. This matters because the on-air logic in Phase 5 needs to know which
channels are microphones.

| Ch | Label | Notes |
|---|---|---|
| 1 | `Tisch` | table mic |
| 2 | `Couch` | couch mic |
| 3 | `TischV` | table, second position |
| 4 | `CouchV` | couch, second position |
| 5 | `Hand1` | handheld |
| 6 | `Hand2` | handheld |
| 7–8 | `Med PC L` / `Med PC R` | media PC, stereo pair |
| 9 | `usbC` | USB-C input |
| 10–11 | `Teams DL` / `Teams DR` | **Teams return over Dante**, stereo pair |
| 12–14 | `ch12`–`ch14` | unused, factory defaults |
| 15–16 | `Tasche1` / `Tasch2` | beltpack ("pocket") radio mics |

All 16 inputs are `Role = Mono`.

| Bus | Label | Type |
|---|---|---|
| Mix 1 | `Tms STR` | VARI — **Teams send** |
| Mix 2 | `Sub` | VARI |
| Mix 3 | `LIFTcntr` | VARI — voice lift, centre |
| Mix 4 | `LIFTall` | VARI — voice lift, all |
| Mix 5–6 | `Stage L` / `Stage R` | VARI |
| Mtrx 1–2 | `Rec L` / `Rec R` | recording feed |
| ST IN 1–2 | `Playback` | |
| Mute groups 1–6 | `MUTE 1`–`MUTE 6` | factory default names |

**Two things follow directly from this patch:**

- **Mix 1 `Tms STR` + CH10/11 `Teams DL/DR` is already a mix-minus.** The Teams return must not be
  sent back to Teams. Whoever touches send routing needs to know that relationship exists.
- **`LIFTcntr` / `LIFTall` means voice lift** — open mics feeding room speakers. Acoustic feedback
  is a live risk in this room, which is exactly why the "dim monitors when a mic opens" work in
  Phase 5 is worth doing and worth doing carefully.

### 2.3 Scenes

Scene bank A is in use; **bank B is empty** (`sscurrent_ex scene_b` → `InvalidArgument`).

- **1–13** — Yamaha factory presets (`Podcasting`, `Recording`, `Rock Band`, `Video Meeting`, …)
- **20–31** — the studio's own, named `ITT`…`ITT V10`, evolving over time
- **Current: A31 `ITT V10 Teams DT` — "voicelift + handsfree stage"**, reported as `modified`

The `modified` flag on `sscurrent_ex` means the console state has drifted from the stored scene.
Useful for a "scene dirty" indicator on a button.

---

## 3. How we know what we know

Everything in §4 and §5 came from `tools/rcp-probe.js`, which we wrote for this project. Read this
section before extending the research — the method is more valuable than any one result.

### 3.1 The probe tool

`companion-module-yamaha-rcp/tools/rcp-probe.js` — standalone Node, no Companion needed, no
dependencies. It opens TCP 49280, sends read commands, collects newline-delimited replies until the
console goes quiet, and prints or saves them.

**It is read-only by construction.** A `WRITE_VERBS` list (`set`, `ssrecall*`, `ssupdate*`, `event`)
is checked before anything is sent; a `--raw` or `--sweep` argument naming one of those exits with
an error rather than transmitting. Keep that guard if you extend the tool. Sending `ssupdate_ex` to
a live console overwrites a scene with no confirmation and no undo.

```bash
# identify only
node tools/rcp-probe.js 192.168.128.9

# full enumeration, saved
node tools/rcp-probe.js 192.168.128.9 \
    --sweep=prminfo:0-400 --sweep=mtrinfo:0-80 --out=dump.txt

# ad-hoc reads
node tools/rcp-probe.js 192.168.128.9 \
    --raw='get MIXER:Current/InCh/Label/Name 0 0;sscurrent_ex scene_a'
```

`--timeout=ms` sets how long the console must be silent before we disconnect (default 2500). Raise
it for large sweeps.

### 3.2 The key discovery that made enumeration possible

The module ships static parameter tables (`DM3 Parameters-2.txt` and friends) in a format nobody
documented. We found that **the console will emit those rows itself**:

```
$ prminfo 0
OK prminfo 0 "MIXER:Current/InCh/Fader/Level" 16 1 -32768 1000 -32768 "dB" integer any rw 100
```

That's byte-identical to the file format. So the tables were originally built by probing a console,
not from documentation — and we can regenerate and extend them the same way. `prminfo` and
`mtrinfo` each take a **single integer index**; walking the index space until it errors gives you
the complete surface.

Bare `prminfo` returns `ERROR prminfo WrongFormat`, not `UnknownCommand` — that difference is what
told us the command existed and just needed an argument. Worth remembering when probing an unknown
verb: **`WrongFormat` means keep trying, `UnknownCommand` means give up.**

### 3.3 Captured artefacts

`tools/probes/DM3-V3.00-live.txt` — the full live dump (177 `prminfo` rows + 17 `mtrinfo` rows +
device identification), committed. This is the reference the shipped tables are diffed against.
Regenerate it after any console firmware update.

### 3.4 What we have not probed

- Bank B scenes beyond confirming it's empty.
- `NOTIFY` behaviour under load — we never held a connection open through console operation. Worth
  doing before the Phase 7 queue rework.
- Any write path. Every claim about `set` semantics below is read from the parameter table's
  `RW` / `Min` / `Max` / `Scale` columns, not tested.

---

## 4. The RCP protocol, as observed

Supplements [BrenekH/yamaha-rcp-docs](yamaha-rcp-docs/), which is TF-focused. Everything here was
verified against the DM3 on V3.00.

### 4.1 Transport

TCP, port **49280**, plain text, messages delimited by `\n`. No handshake, no authentication, no
framing beyond the newline. The console may split a message across TCP segments — the module
handles this by buffering the trailing partial line, and so does the probe tool. Multiple commands
may be written in one packet.

### 4.2 Command verbs

| Direction | Verb | Meaning |
|---|---|---|
| → console | `get <address> <X> <Y>` | read a parameter |
| → console | `set <address> <X> <Y> <value>` | write a parameter |
| → console | `devinfo <field>` | device identification |
| → console | `devstatus <field>` | device state |
| → console | `prminfo <index>` | **enumerate parameter definition** |
| → console | `mtrinfo <index>` | **enumerate meter definition** |
| → console | `mtrstart <address> <interval_ms>` | begin meter streaming |
| → console | `sscurrent_ex <bank>` | current scene number |
| → console | `ssinfo_ex <bank> <n>` | scene name / comment / type |
| → console | `ssrecall_ex <bank> <n>` | **recall scene (write)** |
| → console | `ssupdate_ex <bank> <n>` | **store scene (write, destructive)** |
| → console | `scpmode keepalive <ms>` / `scpmode sstype text` | session options |
| ← console | `OK …` | success, echoes the request plus result |
| ← console | `OKm …` | success, value was modified/clamped |
| ← console | `NOTIFY …` | unsolicited — something changed elsewhere |
| ← console | `ERROR <verb> <reason>` | failure |

Rivage and DM7 use `t_ex` variants (`sscurrentt_ex`, `ssinfot_ex`) because scene numbers are text
rather than integers there. DM3 uses the plain `_ex` forms.

### 4.3 Error vocabulary

All observed on the DM3:

| Reason | Meaning |
|---|---|
| `WrongFormat` | verb exists, arguments are wrong — keep trying |
| `UnknownCommand` | verb does not exist — give up |
| `UnknownAddress` | verb and format fine, that address isn't valid |
| `InvalidArgument` | argument out of range or not applicable |
| `AccessDenied` | parameter exists but is not currently reachable — see [§5.3](#53-the-dante-remote-ha-caveat) |

### 4.4 Parameter definition row format

```
OK prminfo 0 "MIXER:Current/InCh/Fader/Level" 16 1 -32768 1000 -32768 "dB" integer any rw 100
   └─verb  └idx └─address                      X  Y  Min    Max  Default Unit Type  UI  RW Scale
```

- **X** — count on the first axis (channels/strips). **Y** — count on the second axis (sends,
  bands, banks). A value of `1` means the axis is not used.
- **Type** — `integer`, `binary`, `string`, `none`. The module converts `integer` with `Max == 1`
  into a synthetic `bool` type at load time.
- **RW** — `r`, `w`, or `rw`. Feedbacks are only generated for readable parameters, actions only
  for writable ones.
- **Scale** — divide the wire value to get the display value. Levels use `100`, so `-75` on the
  wire is **−0.75 dB**.
- **`-32768` is −∞**, universally.

Wire addresses use `:` (`MIXER:Current/...`); Companion action and feedback IDs replace it with `_`
because Companion disallows colons in identifiers. Conversions between the two happen constantly
throughout the module — it's a frequent source of confusion.

### 4.5 Meter definition row format — and why it differs from the shipped table

The console emits **flat, one-address-per-pickoff** rows:

```
OK mtrinfo 0 "MIXER:Current/InCh/PreHPF"  16 level
OK mtrinfo 1 "MIXER:Current/InCh/PreFader" 16 level
OK mtrinfo 2 "MIXER:Current/InCh/PostOn"   16 level
```

Five fields: verb, index, address, channel count, type. The module's shipped table instead
**synthesises** a collapsed form with a trailing `Pickoff` column:

```
OK mtrinfo 2000 "MIXER:Current/Meter/InCh" 16 3 0 127 0 "dB" mtr any r 1 "PreHPF|PreFader|PostOn"
```

Note the invented `Meter/` path segment, the invented `Y=3` axis, and the invented index range. The
module reconstructs a real address at send time by appending the pickoff. **This transposition is
the root cause of the DM3 metering bug** — see [C6](#8-findings-correctness).

Meter values arrive as hex, `0`–`127`, in `mtr` frames containing all channels for one address.
The module maps them to dB as `value - 126` for most consoles, and through a lookup table
(`wtMtrTable.json`) for DM7.

### 4.6 Scene semantics

```
$ sscurrent_ex scene_a
OK sscurrent_ex scene_a 31 modified

$ ssinfo_ex scene_a 1
OK ssinfo_ex scene_a 1 "01" "Podcasting" "Podcast Host & Panelists" user
                       └display └name      └comment                   └type (user|empty)
```

DM3 (like TF) has two scene banks, `scene_a` and `scene_b`, and **there is no command that reports
which bank is active**. The module's workaround is to query both and infer from which one errors —
that's why `getVars()` fires `sscurrent_ex` at both banks on connect. Here, bank B is empty, so
`scene_b` returns `InvalidArgument`.

**On scene recall the console does not tell you what changed.** It emits a single
`NOTIFY sscurrent_ex`, and every parameter you care about may now hold a different value. This is
the constraint that forces the module to re-poll, and the naive way it does that is
[§7.2](#72-scene-recall-triggers-a-feedback-storm) — the single worst behaviour in the module.

There is **no way to read a parameter's Recall Safe status** over RCP. The maintainer confirmed
this in upstream [#44](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/44). It means
a client can never fully predict which values survive a recall.

---

## 5. What the DM3 exposes — and what it doesn't

### 5.1 The complete surface

Swept live on firmware V3.00:

- **177 parameters**, indices **0–176**. Indices 177–400 all error.
- **17 meter rows**, indices **0–16**.
- Probed and empty: `prminfo` 1000–1060, 2000–2060, 3000–3060. There is no second namespace.
- `scninfo` is **not a command** on DM3 (`UnknownCommand`) — the four `scninfo` rows in the shipped
  table are hand-authored by the module author to give scene recall/store an actions entry. They're
  a module convention, not protocol.

Diffed against the shipped `DM3 Parameters-2.txt`:

| | Count |
|---|---|
| On console, module has it and uses it | 151 |
| On console, module ships it but **silently drops it** | **23** — see [C0](#8-findings-correctness) |
| On console, module **lacks entirely** | **3** — see [§5.3](#53-the-dante-remote-ha-caveat) |
| In module, not on console | 0 |

### 5.2 What is genuinely not available — do not promise these

This is the most important negative result of the research. Each of the following is **absent from
all 177 rows**, meaning it cannot be controlled from Companion at any effort level:

| Not available | Note |
|---|---|
| **Automixer** | Firmware V3.00 has the 8-channel automixer on the surface and Yamaha markets it for *"multi-participant speech and broadcast applications"* — but it is not in the parameter table at any index. **Not remotely controllable.** |
| **Input channel EQ, HPF, gate, comp, delay, digital gain** | Only `Mix` and `Mtrx` have `HPF/On` and `PEQ/*`. What exists for inputs is `InputChLink/LinkParams/*` — *link toggles* saying which parameters follow a channel link, not the processors. |
| **Recorder transport (USB/SD)** | Upstream [#29](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/29), [#30](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/30) |
| **Oscillator** | |
| **Custom fader bank / user-defined keys** | Upstream [#47](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/47) |

Those upstream feature requests were never implementable. They weren't neglected — the protocol
doesn't carry them. If someone asks again, this section is the answer.

**Alternative worth evaluating if any of these become critical:** the DM3 also speaks **OSC** on
UDP 49900 (see [`reference/DM3_osc_specs_v100_en.pdf`](reference/DM3_osc_specs_v100_en.pdf)). Our
comparison shows the published OSC surface is *narrower* than RCP, not wider — it's a v1-firmware
document listing fewer parameters than the console now exposes over RCP — so this is unlikely to
help. But it has not been enumerated live the way RCP has, and that's an untested assumption.

### 5.3 The Dante remote-HA caveat

Three parameters the module has never had, new in this firmware line alongside Rio3224-D3 /
Rio1608-D3 support:

```
prminfo 20 "IO:Current/PortToPort/HAAvailability" 16 1 0  1 1 ""    integer any r  1
prminfo 21 "IO:Current/PortToPort/48VOn"          16 1 0  1 0 ""    integer any rw 1
prminfo 23 "IO:Current/PortToPort/HAGain"         16 1 0 64 0 "dB"  integer any rw 1
```

**Remote head-amp gain (0–64 dB) and phantom power across 16 Dante channels.** In a Dante studio
that's real capability — stagebox preamp control from a Stream Deck.

**But:** on this console right now,

```
get IO:Current/PortToPort/HAAvailability 0 0  →  OK … 0
get IO:Current/PortToPort/HAGain 0 0          →  ERROR get AccessDenied
```

`HAAvailability = 0` means no remote-HA device is currently patched, and reads of the gain are
refused. Local analog HA works normally (`IO:Current/InCh/HAGain 0 0` → `50`).

**Implication for whoever builds this:** `AccessDenied` here is normal, not a bug. Gate the UI on
`HAAvailability` and expect the feature to be untestable until a Rio-class device is on the Dante
network. Don't debug it against an empty patch.

---

## 6. The module: architecture walkthrough

### 6.1 Which version we're on

`master` is v3.5.13. **We are based on the `v3.6.0` tag** (`a2fe58c`), 34 commits ahead, which the
maintainer pushed and then pulled from the Bitfocus store — *"I had to pull it. It needs some
changes before it's pushed to BF"* (upstream [#65](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/65)).

What v3.6.0 adds that we therefore do **not** need to build:

- **Fader fades over time** (PR [#67](https://github.com/bitfocus/companion-module-yamaha-rcp/pull/67)
  by `themusicnerd`) — ramp engine, concurrency cap, cancel-on-scene-recall, configurable step
  interval, queue/cancel/rate-limit overflow policy.
- **Fader level variables** — `getBaseVariableName()` / `getIndexedVariableName()` in `paramFuncs`,
  plus scene-name variables.
- **Fader and scene presets** with meters, channel labels and cue wired in.
- **Fader queue priority** — level changes jump ahead of background polling.
- Metering default retuned 100 ms → 80 ms; Rivage DSP-engine IP tooltip.

The two commits on `master` that v3.6.0 lacks are a `nanoid` dependabot bump and the v3.5.13
version stamp. Neither matters.

There is also a stale `test` branch, 113 commits behind. Ignore it.

### 6.2 File map (v3.6.0)

| File | Lines | Role |
|---|---|---|
| `index.js` | 1231 | Instance lifecycle, TCP, command queue, dataStore, fade engine, presets |
| `paramFuncs.js` | 589 | Parameter table loading/parsing, command formatting, value scaling, lookups |
| `actions.js` | 492 | Generates one action per writable parameter; VU-meter feedback renderer |
| `variables.js` | 307 | Variable definitions, device/scene variables, auto-created variables |
| `feedbacks.js` | 84 | Generates one feedback per readable parameter, by cloning its action |
| `upgrade.js` | 179 | Config migration from older module versions |
| `<Model> Parameters-N.txt` | — | The static parameter tables. **These are the API surface.** |
| `rcpNames.json` | 1233 | Human-readable choice lists (colours, icons, channel names) |

### 6.3 The central idea

**The parameter table is the module.** On init, `paramFuncs.getParams()` reads the `.txt` file for
the selected console and every row becomes:

- an **action**, if `RW` contains `w` — via `actions.createAction()`
- a **feedback**, if `RW` contains `r` — via `feedbacks.createFeedbackFromAction()`, which literally
  deep-clones the action and swaps the callback

So adding a parameter means adding a table row, not writing code. That's why C0 (23 rows silently
dropped by the parser) costs 23 whole features for a one-line bug, and why [§5](#5-what-the-dm3-exposes--and-what-it-doesnt)
matters so much — the table can only contain what the console admits to.

### 6.4 Data flow

```
Button press
  └─> action callback (actions.js:222)
        └─> paramFuncs.parseOptions()      ← 3× async IPC, see §7.1
              └─> instance.addToCmdQueue({prefix:'set', …})
                    └─> processCmdQueue() ── 5 ms timer ──> socket.send("set …")

Console reply / NOTIFY
  └─> socket 'data' handler (index.js:255)
        └─> paramFuncs.parseData()       — split lines, map fields by verb
              └─> paramFuncs.findRcpCmd() ← linear scan, see §7.4
                    └─> instance.addToDataStore()
                          └─> checkFeedbacks(address)   ← per value, see §7.5
                                └─> feedback callback
                                      └─> parseOptions() again ← 3× async IPC again
                                            └─> getFromDataStore()
                                                  └─> miss? queue a 'get' …
```

The recursion in that last step — a feedback evaluation queueing a `get` whose reply triggers more
feedback evaluations — is what makes [§7.2](#72-scene-recall-triggers-a-feedback-storm) explosive.

### 6.5 `dataStore` and `cmdQueue`

`this.dataStore[address][X][Y] = value` is the module's cache of console state. `getFromDataStore()`
returns a hit, or on a miss queues a `get` and returns `undefined` — so feedbacks self-populate the
cache over time.

`this.cmdQueue` is a flat array of pending commands. `addToCmdQueue()` **coalesces**: a queued
command with the same prefix/address/X/Y is replaced rather than appended, so spinning a fader
doesn't queue a hundred sets. That part is well designed; the drain rate is not
([§7.3](#73-serialised-command-queue-with-a-fixed-5-ms-gap)).

---

## 7. Findings: performance

Line references are against **v3.6.0**. Ordered by cost — §7.1 and §7.2 are what the user feels.

### 7.1 Every feedback evaluation does three async IPC round-trips

[`paramFuncs.js:371-381`](companion-module-yamaha-rcp/paramFuncs.js:371) — `parseOptions()` deep-clones
its input and then makes **three `await context.parseVariablesInString()` calls**:

```js
let parsedOptions = JSON.parse(JSON.stringify(optionsToParse))       // deep clone
parsedOptions.X = … parseInt(await context.parseVariablesInString(String(optionsToParse.X))) - 1
parsedOptions.Y = … parseInt(await context.parseVariablesInString(String(optionsToParse.Y))) - 1
parsedOptions.Val = await context.parseVariablesInString(String(optionsToParse.Val ?? ''))
```

This runs on the hot path of **every** feedback callback ([`feedbacks.js:48`](companion-module-yamaha-rcp/feedbacks.js:48))
and every action. `parseVariablesInString` is not a local function — it's an IPC call into the
Companion main process. **150 feedbacks on a page = 450 IPC round-trips per `checkFeedbacks()`.**

Three further calls sit in the VU-meter renderer at
[`actions.js:368, 385, 443`](companion-module-yamaha-rcp/actions.js:368), which run per meter
repaint.

**Why the fix is a migration, not an optimisation.** Companion module API 2.0 **removed
`parseVariablesInString`** and replaced it with automatic expression parsing in option fields. On
Companion 5 the host does this natively and synchronously against its own variable store. The
module is doing by hand, over IPC, what the host would do for free.

| | v3.6.0 ships | Companion 5.0.4 wants |
|---|---|---|
| Module API | 1.12 (Companion 4.0 era) | **2.1** |
| `@companion-module/base` | `^1.12.0` | **`^2.1.3`** (latest stable) |
| Runtime | `node18` | **`node22`** — node18 dropped in API 2.0 |

API versions map to hosts as: 1.12 → Companion 4.0, 1.13 → 4.1, 1.14 → 4.2, 2.0 → 4.3, **2.1 →
5.0+** ([changelog](https://companion.free/for-developers/module-development/api-changes/)).

Note the direction of travel: master had already moved to `^1.14.1`, and v3.6.0 **pinned back to
`^1.12.0`** to escape a breaking change (API 2.0 stopped coercing option values to strings, which
broke DM7 entirely — upstream [#65](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/65)).
The `String(...)` wrappers now visible around every `parseVariablesInString` argument are the
band-aid from that retreat. On Companion 5 the retreat isn't available and the coercion change has
to be faced properly.

### 7.2 Scene recall triggers a feedback storm

[`index.js:1169`](companion-module-yamaha-rcp/index.js:1169) — unchanged since v3.5:

```js
pollConsole() {
    this.dataStore = {}      // wipe EVERYTHING
    this.subscribeActions()  // re-request every action's value
    this.checkFeedbacks()    // re-evaluate every feedback
}
```

Called whenever a `NOTIFY sscurrent_ex` arrives. Wiping the cache means every subsequent `get`
reply looks like a *change*, so [`addToDataStore`](companion-module-yamaha-rcp/index.js:1177) fires
`checkFeedbacks()` for it, which re-evaluates all feedbacks of that type, which mostly miss the
(now empty) store and queue *more* gets — each carrying §7.1's IPC cost. Quadratic-ish. On a
200-button layout this is the multi-second freeze after a scene recall.

It is also the cause of upstream [#44](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/44):
triggers re-fire on scene recall even when the value didn't change. That was closed as "working as
designed" — the *re-poll* is necessary (§4.6: the console doesn't say what changed), but the *wipe*
is not.

**Fix:** re-poll into a shadow store, diff against the live store, emit `checkFeedbacks` only for
addresses whose value actually changed. Identical network cost, no storm, no spurious triggers.

### 7.3 Serialised command queue with a fixed 5 ms gap

`MSG_DELAY = 5` ([`index.js:13`](companion-module-yamaha-rcp/index.js:13)), drained one message per
timer tick ([`index.js:343`](companion-module-yamaha-rcp/index.js:343)). Hard ceiling ~200 msg/s
regardless of what the console can absorb. v3.6.0 added *priority* for fader levels but not
*throughput*.

**Fix:** send immediately when the socket is idle; batch several commands into one TCP write (RCP is
newline-delimited and the console accepts multiple per packet); use an adaptive in-flight window
rather than a fixed sleep. Keep v3.6.0's `set`-over-`get` prioritisation.

### 7.4 `findRcpCmd` is a linear scan with a string allocation per candidate

[`paramFuncs.js`](companion-module-yamaha-rcp/paramFuncs.js) —

```js
rcpCmd = rcpCommands.find((cmd) => cmd.Address.replace(/:/g, '_').startsWith(cmdToFind))
```

Called from the receive handler, `fmtCmd`, `parseVal`, `addToCmdQueue`, every feedback callback and
`fbCreatesVar`. A fresh `.replace()` per array element per call — up to 177 string allocations per
lookup on DM3, thousands of times a second under metering. Worse on Rivage (1000+ rows).

**Fix:** build a `Map` keyed on the underscore form once in `getParams()`. O(1), zero allocation.

### 7.5 Metering re-renders far more than necessary

[`index.js:1177`](companion-module-yamaha-rcp/index.js:1177) calls `checkFeedbacks(address)` on
**every individual channel value change**. A meter frame for 16 inputs at the 80 ms default is
~200 full feedback sweeps per second, each re-running §7.1.

**Fix:** apply a whole meter frame to the store, then fire *one* `checkFeedbacks` per frame on the
next tick.

### 7.6 Variable churn rebuilds all definitions

`variables.js` calls `setVariableDefinitions(instance.variables)` — a full rebuild of the entire
definition list — each time a new auto-created variable appears, and `setVariableValues` is called
one variable at a time rather than batched. Almost certainly the cause of upstream
[#64](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/64), *"plugin restarts when a
lot of data comes in"*, reported with auto-created DCA level variables on a QL5.

**v3.6.0 makes this worse, not better:** its new presets set `createVariable: true`, so this path
is hit far more often than before.

**Fix:** batch value updates per tick; debounce definition rebuilds.

### 7.7 Deep clones on hot paths

`JSON.parse(JSON.stringify(x))` at [`index.js:269`](companion-module-yamaha-rcp/index.js:269)
(per received message), [`index.js:321`](companion-module-yamaha-rcp/index.js:321) (per queued
command), [`paramFuncs.js:371`](companion-module-yamaha-rcp/paramFuncs.js:371) (per option parse),
[`actions.js:190`](companion-module-yamaha-rcp/actions.js:190), and
[`feedbacks.js:7`](companion-module-yamaha-rcp/feedbacks.js:7). The objects are flat — a shallow
spread is equivalent and far cheaper.

### 7.8 Performance targets

Measure against the real console at `192.168.128.9`. Re-measure **after Phase 1** before doing any
of §7.2–§7.7 — some may already be under target once the IPC storm is gone.

| Metric | Now (est.) | Target |
|---|---|---|
| Button press → wire, idle | 5–10 ms | < 2 ms |
| Button press → wire, under metering load | 50–200 ms | < 10 ms |
| Full resync after scene recall, 200 buttons | seconds | < 300 ms |
| Spurious trigger fires on scene recall | yes | none |
| Module CPU, 16 ch metering @ 20 fps | — | < 5 % |

---

## 8. Findings: correctness

| # | Issue | Location / evidence |
|---|---|---|
| **C0** | **23 shipped DM3 parameters are silently dead.** Lines 123–145 of `DM3 Parameters-2.txt` (indices 122–144 — the entire `InputChLink` block) are missing their leading `OK ` and are space-indented. `parseData`'s guard is `['OK','OKM','NOTIFY'].indexOf(line[0].toUpperCase()) !== -1`, so the first token is `prminfo` and every one of those rows is dropped. They exist in the file, they exist on the console, the module cannot see them. **One-line parser fix unlocks 23 parameters.** | confirmed by diffing the live dump against the shipped table |
| **C1** | **Module state is global, not per-instance.** `global.config` and `global.rcpCommands` ([`index.js:28-29`](companion-module-yamaha-rcp/index.js:28)) are read throughout `paramFuncs`, `actions`, `variables`. A second instance — DM3 plus a Rio stagebox, or a redundant console — silently clobbers the first. | `index.js:28`, and ~15 further `global.rcpCommands` reads |
| **C2** | **KeepAlive timer leaks on destroy.** [`destroy()`](companion-module-yamaha-rcp/index.js:53) clears `queueTimer`, the fade timers and `meterTimer` — but never `kaTimer`, which is created at [`index.js:243`](companion-module-yamaha-rcp/index.js:243). It keeps firing `devstatus runmode` after the instance is deleted. | `index.js:53-62` |
| **C3** | **User input goes straight into `JSON.parse`.** [`actions.js:223,227`](companion-module-yamaha-rcp/actions.js:223) parse the X and Y option values as JSON to support array syntax. Any non-JSON value throws inside the action callback and the action silently does nothing. Riskier on API 2.1, where option values are no longer coerced to strings. | `actions.js:223` |
| **C4** | **Implicit globals.** `for (k = 3; …)` in `paramFuncs.parseData` and `for (i = 0; …)` in `actions.createAction` declare no binding, leaking to global scope. | `paramFuncs.js`, `actions.js` |
| **C5** | **`parseData` mutates its own field-name table.** `params = RCP_METER_FIELDS` then `params.push(...)` mutates the shared array; across multiple meter lines in one call it accumulates duplicate entries. Currently harmless because indices still align, but latent. | `paramFuncs.js` |
| **C6** | **DM3 metering is broken, and the cause is now known.** The console enumerates 17 flat per-pickoff meter addresses; the module ships 6 synthesised rows with a `Pickoff` column and reconstructs addresses by appending the pickoff — transposing the X/Y axes against reality (§4.5). That produces exactly the reported symptoms: `Meter/St` returns left only, `Meter/StInCh` returns nothing, `Meter/FxRtnCh` always returns channel 1. **Fix: drive metering from the console's own enumeration.** | upstream [#45](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/45); live `mtrinfo` sweep vs shipped table |
| **C7** | **No reconnect/backoff of its own**, and connection errors flood the Companion log. | upstream [#57](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/57) |
| **C8** | **Scene Store has no confirmation** and silently overwrites. The README says so outright: *"use with caution! — There's NO confirmation when storing or overwriting a scene"*. With 12 hand-built studio scenes on this console (§2.3) that's a real hazard. | `README.md` |

---

## 9. Plan of work

### Phase 1 — Migrate to Companion 5 / module API 2.1 — **DONE**

Prerequisite for everything else; deletes most of §7.1 outright rather than optimising it.

- **P1.1** `@companion-module/base` `^1.12.0` → `^2.1.3`; manifest `runtime.type` `node18` →
  `node22`; bump `apiVersion`.
- **P1.2** Remove `parseVariablesInString` usage in favour of native expression parsing. Bulk of the
  diff — `paramFuncs.parseOptions`, every action callback, every feedback callback, the VU renderer.
- **P1.3** Audit every place an option value is assumed to be a string (C3). This is precisely what
  v3.6.0 retreated from; on Companion 5 there's nowhere to retreat to. Strip the `String(...)`
  band-aids as the real typing lands.
- **P1.4** `required` was removed from some option field types — sweep `actions.js`.
- **P1.5** Verify v3.6.0's fade engine still behaves under the new option semantics.

**Exit:** loads and runs on Companion 5.0.4 with no compatibility shim; existing pages behave
identically; fades still smooth. **Re-measure §7.8 before starting Phase 3.**

#### Phase 1 addendum — what P1.1–P1.5 undersold, found by installing the real package

This section was written from a changelog webpage, not the installed package. The actual npm
`@companion-module/base@2.1.3` (published 2026-08-12, confirmed compatible with the studio's
Companion **v5.0.4**, released 2026-08-23, by reading `shared-lib/lib/ModuleApiVersionCheck.ts` in
the `bitfocus/companion` repo directly — Companion accepts base versions `2 - 2.1.x`) carries several
further breaking changes P1.1–P1.5 didn't anticipate. All were found by extracting the real package
and, where that was ambiguous, by reading Companion's own host-loader source
(`companion/lib/Instance/Connection/Thread/Entrypoint.ts`) and by running the actual
`yarn package:dev` build end-to-end. Fixed as part of Phase 1, not deferred:

- **No `runEntrypoint`.** Removed in base 2.0.0-alpha.0 ("expect default export instead"). The host
  loader does `moduleImport.default` for the constructor and reads `moduleImport.UpgradeScripts` off
  the top-level import namespace — **not** off the default export. Because the build tool
  (`@companion-module/tools` 3.x) bundles the module with **esbuild in `format: 'esm'`**, and esbuild
  only synthesises a plain `export default` for a CommonJS entry point (verified empirically — see
  below), `index.js` had to become the one file in the codebase using real `export default
  instance; export { upgrade as UpgradeScripts }` at the bottom, while every other file (and
  `index.js`'s own `require()`s) stays exactly as it was. `module.exports.UpgradeScripts = upgrade`
  was tried first and silently produces an empty upgrade-script list — worth remembering if this
  pattern comes up again.
- **`checkFeedbacks()` now needs at least one feedback type.** No-arg calls (just the one, in
  `pollConsole()`) become `checkAllFeedbacks()`.
- **`setVariableDefinitions()` takes an object keyed by `variableId`, not an array.** Added
  `paramFuncs.setVariableDefinitions(instance)` as the one conversion point; `instance.variables`
  stays an array internally since it's built with `push()`/`find()` throughout.
- **Presets were overhauled.** `setPresetDefinitions()` now takes `(structure, presets)` —
  `structure` is an array of named sections each listing preset ids, `presets` is an object keyed by
  id, and each preset is `type: 'simple'` (not `'button'`) with no `category` field. `createPresets()`
  now builds the flat array exactly as before and transforms it into that shape in one place at the
  end, grouping by the same category strings that used to be per-preset fields. The dead
  `options: { rotaryActions: true }` on the fader-knob preset was dropped — rotary capability is
  inferred from having `rotate_left`/`rotate_right` steps now, there's no separate flag.
- **`useVariables` on an option field is a plain boolean, not `{ local: true }`.** The `{ local: true
  }` shape in the shipped v3.6.0 code never matched any real API version; fixed on the X/Y/Val option
  fields in `actions.js`.
- **Advanced feedbacks (`Meter`, `LevelMeter`, and the per-parameter colour feedbacks) need
  `affectedProperties`**, and **`imageBuffer` must now be a base64 string** (`Buffer.toString('base64')`)
  **with an explicit `imageBufferEncoding: { pixelFormat: 'RGBA' }`** — it used to accept the raw
  Buffer that `companion-module-utils`' `graphics.bar()`/`stackImage()` already returns.
- **Feedback callback contexts lost `setCustomVariableValue` entirely** (it's action-context-only now,
  and deprecated even there). The `@(custom:...)` escape hatch in a feedback's `Val` option
  (`variables.js: fbCreatesVar`) can no longer write a custom variable — there is no replacement.
  It now logs a one-time warning instead of throwing. **This is a real, unavoidable behaviour loss for
  anyone using that syntax in a feedback** — worth a targeted check of the studio's actual pages
  before calling Phase 1 fully closed, since nothing in this repo can see what's configured on the
  live Companion install.
- **Strict-mode ESM broke three pre-existing implicit-globals** that sloppy-mode CommonJS had always
  tolerated silently: `upgrade.js`'s `(upg111to112 = () => (...))`-style assignments (undeclared
  variable, threw `ReferenceError` immediately on module load — this is what first caught the whole
  class of bug), plus `for (k = 3; …)` in `paramFuncs.parseData` and `for (i = 0; …)` in
  `actions.createAction` (C4). Also tightened the two genuine cross-file globals, `global.config` and
  `global.rcpCommands`, so every *write* site uses the `global.` prefix explicitly rather than relying
  on an already-established binding falling through the scope chain — same de-facto architecture C1
  describes (still global, still Phase 2's to fix properly), just no longer one accidental unprefixed
  write away from breaking under `--experimental-*` strict-mode bundling.
- **`manifest.json` needs a top-level `"type": "connection"` field**, required since base 2.0.0 and
  absent from the shipped manifest.

**Verified, not just written:** `yarn install --ignore-engines` (the installed Node here is 26.7,
newer than `@companion-module/tools`' `^22.18` ceiling — a dev-machine-only mismatch, harmless) then
`yarn package:dev` builds clean. The built `main.js` was dynamically imported directly and confirmed
to export a working `default` constructor and a 5-entry `UpgradeScripts` array. Beyond that,
`paramFuncs.getParams()`, `actions.updateActions()`, `variables.initVars()` and `index.js`'s new
`createPresets()` were all exercised directly against the real `DM3 Parameters-2.txt` (via a throwaway
harness, not committed) with no exceptions: 161 parsed commands → 141 actions, 160 feedbacks, 351
presets across 6 structure sections, every structure-referenced preset id resolving to a real
definition. This is as far as it can be verified without the actual Companion 5.0.4 host and a live
DM3 — §10.4's manual test list is still the real gate.

**Not done, still open for whoever picks this up:**
- `yarn lint` doesn't run — `eslint` isn't an installed dependency despite `@companion-module/tools`
  expecting it as a peer (`eslint-config-prettier`/`eslint-plugin-prettier`/`eslint-plugin-n` all warn
  about it on install). Pre-existing gap, not introduced by this migration.
- The three preset feedback entries that carry `createVariable: true` with no `style` (the bare fader
  level feedback on the main fader-control and fader-knob presets) were left exactly as they were.
  The new preset-feedback schema marks `style` as required for boolean-type feedbacks in the type
  definitions; whether Companion's runtime actually enforces that or just treats a missing `style` as
  "no override" (which is what the original author clearly intended) couldn't be confirmed without a
  live host. Watch for it specifically in §10.4 step 1–2.

### Phase 2 — Correctness and safety

C0 first — it's a one-line parser fix that unlocks the entire `InputChLink` block. Then C1–C5, C7.
C1 (de-globalising) is the largest diff and unblocks running a console and a stagebox side by side.

**Exit:** two instances configured simultaneously without interference; `InputChLink` actions appear
in the UI; no leaked timers; `eslint` clean.

### Phase 3 — Performance

In cost order: §7.2 (shadow-store scene resync) → §7.4 (`findRcpCmd` map) → §7.5 (meter frame
coalescing) → §7.3 (queue rework) → §7.6, §7.7.

**Exit:** every §7.8 target met.

### Phase 4 — Metering rebuild and Dante HA

- **P4.1** Rebuild DM3 metering on the console's own 17-row flat enumeration instead of the
  synthesised `Pickoff` table. Fixes C6 and removes the meter special-casing in `fmtCmd`.
- **P4.2** Add the three `IO:Current/PortToPort/*` parameters. Gate the UI on `HAAvailability` and
  read [§5.3](#53-the-dante-remote-ha-caveat) first — `AccessDenied` with no remote HA patched is
  expected behaviour, not a bug, and the feature is untestable until a Rio-class device is present.

**Exit:** working stereo meters on ST and ST-IN; per-FX-return meters; stagebox gain and phantom
from a button (or a clear "unavailable" state).

### Phase 5 — Broadcast feature layer

Chosen priorities, in build order:

1. **Auto-populated channel variables.** v3.6.0 has the naming infrastructure
   (`getIndexedVariableName`), but variables only exist when a feedback with "Auto-Create Variable"
   ticked happens to sit on a button. Populate `$(dm3:inch_1_name)`, `inch_1_level_db`,
   `inch_1_on`, `mix_1_name` etc. for every strip on connect, with no wiring. Easier of the two and
   immediately useful for labels. Depends on §7.6 being fixed first or it will make the churn worse.
2. **Mic on-air + monitor dim.** Channel-on with tally feedback, optional exclusive-mic mode, and
   auto-dim of control-room monitors when any mic opens. Built on `InCh/Fader/On`,
   `Monitor/Fader/Level`, `Monitor/On`, `Monitor/CueInterruption` — all present. v3.6.0's fade
   engine gives a smooth dim rather than a jump. **Read §2.2: this room runs voice lift, so the
   feedback risk being mitigated is real.** Mics are CH1–6 and CH15–16.
3. **Studio presets** built on both.

**Available but not requested** — recorded so they aren't lost: mix-minus/IFB helper (note the
existing `Tms STR` ↔ `Teams DL/DR` relationship in §2.2), scene-store confirmation (C8), Dante
remote HA (Phase 4). **Fader ramps are already done** in v3.6.0.

**Exit:** a show can be run from the Stream Deck without touching the console surface.

### Phase 6 — Package, document, upstream

Build as a Companion dev module, install on the studio machine, write studio-facing docs. Then offer
upstream: the API 2.1 migration, C0, C6 and the §7 performance work all benefit every user of the
module. The broadcast layer may or may not fit upstream's scope — decide later.

---

## 10. Build, install, test

### 10.1 Repo state

```bash
cd YamahaRCP/companion-module-yamaha-rcp
git log --oneline -3     # broadcast-studio, based on tag v3.6.0
```

Branch `broadcast-studio` = `v3.6.0` + our probe tooling commit + the Phase 1 API 2.1 migration
(v3.7.0). Upstream `origin` is intact, so `git fetch origin` picks up any further maintainer
work — worth checking periodically, since v3.6.0 was never released and may still change.

As of Phase 1, `broadcast-studio` is also pushed to a personal fork,
[lenartd2/companion-module-yamaha-rcp](https://github.com/lenartd2/companion-module-yamaha-rcp),
added as remote `fork` (`origin` deliberately left pointing at `bitfocus/…` so `git fetch origin`
keeps meaning "check upstream", not "check my fork"). Push there with `git push fork
broadcast-studio`.

**The Phase 1 migration was also offered upstream:**
[bitfocus/companion-module-yamaha-rcp#76](https://github.com/bitfocus/companion-module-yamaha-rcp/pull/76),
opened from a *separate* branch, `upstream-api21-migration` (based on `v3.6.0`, not
`broadcast-studio` — deliberately built without ever touching this file in its history, since
this doc has real network/studio detail that has no place in a public PR). That branch carries
only the module source, `CHANGELOG.md` and `HELP.md`; if Phase 2+ work is also offered upstream
later, repeat that pattern — cherry-pick or re-checkout the relevant source files onto a clean
branch off whatever the PR's base should be, don't PR `broadcast-studio` directly.

### 10.2 Build

```bash
yarn install
yarn lint
yarn package:dev        # -> dev build; `yarn package` for a release build
```

`build-config.cjs` declares `extraFiles: ['*.txt']` — **the parameter tables must be bundled**. If
you add a new table file, confirm it matches that glob or the module will load with no actions.

### 10.3 Install into Companion

Companion is **not** on the development Mac; it runs elsewhere in the studio. Copy the dev build to
the target machine's developer-modules path and point Companion's Developer Modules setting at it,
then restart the connection. Confirm the target's Companion version is still 5.0.4 before relying
on the API 2.1 work.

### 10.4 Test

There is **no test suite** — upstream has none. Testing is manual against hardware. Suggested
minimum before calling any phase done:

1. ✅ Module loads; actions and feedbacks populate for `DM3`. Confirmed on the studio's real
   Companion 5.0.4 — 141 actions, 160 feedbacks, 351 presets, no warnings once the isVisible/Fade
   /preset-option-key/config-field-id bugs were fixed (see Phase 1 addendum).
2. ⬜ `InCh/Fader/On` toggles CH1 and the feedback tracks it. Not explicitly run — testing so far
   covered a meter feedback (CH7 `InCh/PreHPF`, confirmed working end-to-end including the
   render fix) and a fader-level button showing as "on" with a sane variable value, not the
   specific on/off-toggle-plus-feedback round trip.
3. ⬜ A fade from −∞ to 0 dB on CH1 is smooth and lands exactly. Not tested.
4. ⬜ Recall scene A31 from the console surface; confirm Companion resyncs and **no trigger fires
   spuriously** (this is the C6/§7.2 regression test). Not tested.
5. ⬜ Enable metering; confirm ST meters show **both** channels (the C6 regression test). Only a
   mono `InCh` meter was tested (and confirmed rendering correctly after the ARGB fix) — **not**
   the `St` stereo pair this item is actually about. Expect this to still fail: C6 (metering
   reconstructed from a synthetic `Pickoff` model instead of the console's real flat enumeration)
   is unchanged, deliberately deferred to Phase 4.
6. ⬜ Delete the connection; confirm no timers keep firing (C2). Not tested — and expect this one
   to actually fail: C2 (KeepAlive timer not cleared on `destroy()`) was correctly identified as
   still-open by the 2026-08-25 audit (`YamahaRCP/audit/AUDIT.md`) and was never in Phase 1's
   scope to fix.

**Net: Phase 1's own exit bar ("loads and runs... existing pages behave identically") is not
fully closed yet** — 1 of 6 items confirmed, 2 more expected to still fail by design (deferred to
Phase 4/2). Finish 2–4 next time at the mixer before calling Phase 1 fully done.

Use `tools/rcp-probe.js` to read ground truth from the console at any point — it's read-only and
safe to run alongside Companion, since the DM3 accepts multiple simultaneous control connections.

---

## 11. Paths and reference material

| What | Where |
|---|---|
| **Project root** | `/Users/LENARTD/Claude-Projects/Studio-Vai/YamahaRCP/` |
| This document | `YamahaRCP/PLAN.md` |
| Module working copy | `YamahaRCP/companion-module-yamaha-rcp/` — branch `broadcast-studio`, based on tag `v3.6.0` |
| Probe tool | `…/companion-module-yamaha-rcp/tools/rcp-probe.js` |
| **Live DM3 dump** | `…/companion-module-yamaha-rcp/tools/probes/DM3-V3.00-live.txt` |
| DM3 parameter table | `…/companion-module-yamaha-rcp/DM3 Parameters-2.txt` |
| Third-party protocol notes | `YamahaRCP/yamaha-rcp-docs/` (clone of [BrenekH/yamaha-rcp-docs](https://github.com/BrenekH/yamaha-rcp-docs), TF-focused) |
| Yamaha PDFs | `YamahaRCP/reference/` |

### Documents

- [DM3 Reference Manual (PDF)](reference/DM3_Reference_Manual_en.pdf) — local copy
- [DM3 OSC Specifications v1.0.0 (PDF)](reference/DM3_osc_specs_v100_en.pdf) — local copy. Note it
  is *narrower* than what the console actually exposes over RCP; it documents firmware v1.
- [DM3 Reference Manual (HTML)](https://manual.yamaha.com/pa/mixers/dm3/rm/en-US/), incl.
  [Dante setup](https://manual.yamaha.com/pa/mixers/dm3/rm/en-US/6296293259.html) and
  [NETWORK / device control](https://manual.yamaha.com/pa/mixers/dm3/rm/en-US/6603469963.html)
- [Companion module API changelog](https://companion.free/for-developers/module-development/api-changes/)
  — the authority on which API version each Companion release wants
- [Companion module manifest reference](https://companion.free/for-developers/module-development/module-setup/manifest.json/)

### Upstream issues worth knowing

| Issue | Why it matters here |
|---|---|
| [#65](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/65) | The API-compat retreat that pinned base to 1.12; also where the maintainer says v3.6.0 was pulled |
| [#64](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/64) | "Plugin restarts when a lot of data comes in" — almost certainly §7.6 |
| [#45](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/45) | DM3 metering broken — root cause now known, see C6 |
| [#44](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/44) | Scene-recall retrigger, closed as by-design — see §7.2 |
| [#67](https://github.com/bitfocus/companion-module-yamaha-rcp/pull/67) | The fader-fade PR merged into v3.6.0 |
| [#21](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/21), [#29](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/29), [#30](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/30), [#47](https://github.com/bitfocus/companion-module-yamaha-rcp/issues/47) | Dynamics, USB playback, transport, custom fader bank — all **not possible** over RCP, see §5.2 |

Community support for the module is at `discourse.checkcheckonetwo.com`, run by the maintainer
(Andrew Broughton, `MeestorX`), not on GitHub.

---

## 12. Open questions and assumptions

**Open:**

1. **What is actually driven from Companion today?** Phase 5's ordering should follow the real show,
   not inference from channel labels. The patch in §2.2 is our best current read.
2. **Where does Companion run, and how are dev modules loaded there?** Needed before Phase 1 can be
   verified end to end (§10.3).
3. **Is `Tms STR` maintained by hand today?** If the Teams mix-minus is currently a manual routing
   chore, the deferred mix-minus helper may deserve promotion.

**Assumptions a successor should challenge:**

- That OSC offers nothing RCP doesn't (§5.2). Based on comparing the published v1 OSC spec against a
  live V3.00 RCP enumeration — not a like-for-like test. If Automixer control ever becomes critical,
  enumerate OSC live before concluding it's impossible.
- That `prminfo` index sweeping is exhaustive. We probed 0–400 plus the 1000/2000/3000 bands. A
  namespace at some far-off index would have been missed.
- That every `set` behaves as the table's `Min`/`Max`/`Scale` columns describe. We never wrote to the
  console; all write semantics are read off the table (§3.4).
- That the console's behaviour under sustained `NOTIFY` load matches the single-shot reads we did.
  Not tested (§3.4).
