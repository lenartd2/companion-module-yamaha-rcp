# Yamaha RCP → Broadcast Studio Module

**A working plan and handoff document.**
Everything here is either measured against the live console or cited to source. Where something is
an assumption, it says so.

---

## Contents

1. [Orientation](#1-orientation) — what this project is, in one page
1.1 [**Scope freeze**](#11-scope-freeze--read-before-proposing-features) — what is and isn't open work
2. [The system as it exists](#2-the-system-as-it-exists) — console, network, **signal flow and the
   rules it imposes**, scenes
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

### 1.1 Scope freeze — read before proposing features

**Decided by the operator, 2026-08-28:**

> *"Let's not focus on changing channel-individual settings via Companion any further. Whatever is
> currently possible, we'll accept."*

The per-channel control surface is **done**. Phases 1–5 P2 shipped a lot of it, and that is the
agreed stopping point. Concretely:

| Still in scope | Out of scope |
|---|---|
| Correctness fixes and regressions | New per-channel parameter features |
| Performance work (§7) | Mix-minus / IFB helpers |
| Live verification of what already shipped | Single-mic (exclusive) mode |
| Upstream PR #76 | Studio presets built on per-channel control (Phase 5 P3) |
| Documentation | Expanding parameter-table coverage |
| | Anything requiring hardware that will never exist here (§5.3) |

This is not a pause — it is an acceptance. **Do not open feature work in the right-hand column
without asking first**, and treat "we could also control X per channel" as answered: we could, and
we are choosing not to.

Deferred ideas — including **single-mic (exclusive) mode**, taken out of scope on 2026-08-28 — are
parked in [§9 Backlog](#backlog--nice-to-have-not-scheduled) with the reasoning attached, so
reviving one starts from what we already learned rather than from scratch. That backlog also
carries the one **unsafe shipped default** we know about; it is dormant while the feature stays
off, and the note travels with the feature so it can't be picked up without being seen.

---

## 2. The system as it exists

### 2.1 Console and network

| | |
|---|---|
| Model | Yamaha **DM3** (the Dante-equipped model, not DM3 STANDARD) |
| Firmware | **V3.00** |
| Device name | `Y001-Yamaha-DM3-006b40` |
| **RCP control** | **`192.168.128.9` : TCP 49280** — permanent DHCP reservation as of 2026-08-28 |
| Dante interface | `192.168.128.12` (advertises `_netaudio-arc._udp` as `BROOKLYN3-006b40.local`) — re-confirmed 2026-08-28 |
| Run mode | `normal` |

**`192.168.128.9` is now a permanent DHCP reservation**, set by the operator on 2026-08-28 and
confirmed live the same day (`devinfo devicename` → `Y001-Yamaha-DM3-006b40`, firmware unchanged).
Treat it as the console's fixed address: it is safe to put in Companion's connection config, in
scripts, and in documentation.

The reservation lives on the studio FortiGate (see the `FortiGate-OnAir` project — `config
reserved-address`, MAC `ac:44:f2:a3:44:33`, description `"Yamaha-DM3"`). That is the one place it
could change, so if the console ever becomes unreachable at `.9`, check the reservation before
assuming a module or Companion fault.

*History, for anyone reading older notes or commits:* the console was at `192.168.128.24` during
the original research and moved to `.9` before the reservation was made permanent. Pre-2026-08-28
material referencing `.24` is stale, not wrong-at-the-time.

**If it ever does go missing**, re-discover rather than debug — and note the two interfaces are
different addresses:

```bash
nmap -p 49280 --open 192.168.128.0/24     # the Network (control) interface — RCP lives here
dns-sd -B _netaudio-arc._udp local        # the Dante interface — a DIFFERENT address
```

**The DM3 has two separate network interfaces.** The *Network* port ("For Mixer Control" in
`SETUP → NETWORK`) carries RCP, StageMix, MonitorMix and OSC. The *Dante* port carries audio and
Dante control. They are different IP addresses even when they sit on the same subnet, as they do
here. **RCP is on the Network port only** — connecting to the Dante address gets you nothing on
49280. This trips people up.

Other Dante devices visible on the network: Shure, Sennheiser (stage / ceiling / wireless), Fohhn
amplifier, `Regie-30-0f`, `ABX-6-2b7364`.

Companion itself is **not** installed on the development Mac — it runs elsewhere in the studio.
Plan for a copy-to-target step when installing dev builds ([§10](#10-build-install-test)).

### 2.2 Signal flow — the authoritative routing

**This is the operator's own documentation of the studio, reproduced as given.** It is the source
of truth for *intent*. §2.3 records what the console actually reports, which is not identical.

#### Input channels

| Ch | Source | Mix routing | Stream / Main L-R | Notes |
|---|---|---|---|---|
| **1** | Ceiling Mic1 – Stage | Mix 1 | **Yes** | Stage ceiling microphone. Sent to Teams and stream. |
| **2** | Ceiling Mic2 – Couch | Mix 1 | **Yes** | Couch ceiling microphone. Sent to Teams and stream. |
| **3** | Ceiling Mic1 – Stage Local | Mix 3, 5, 6 | No | Local reinforcement / lift only. |
| **4** | Ceiling Mic2 / Couch Local | Mix 4 | No | Sent only to Lift All. |
| **5** | Handheld Mic 1 | Mix 1, 5, 6 | **Yes** | Teams, stage speakers and stream. |
| **6** | Handheld Mic 2 | Mix 1, 3, 5, 6 | **Yes** | Teams, centre-stage lift, stage speakers and stream. |
| **7** | Media PC – Left | all Mix outputs | No | Stream receives Media PC audio separately via NDI. |
| **8** | Media PC – Right | all Mix outputs | No | Stream receives Media PC audio separately via NDI. |
| **9** | *Reserved:* USB-C audio via Dante | Mix 2, 5, 6 | No | Reserved, currently unused. |
| **10** | Teams Remote Speaker – Left | Mix 4, 5, 6 | **Yes** | Incoming audio from remote Teams participant. |
| **11** | Teams Remote Speaker – Right | Mix 4, 5, 6 | **Yes** | Incoming audio from remote Teams participant. |
| **12+** | Unused | — | — | Not assigned. |

#### Mix outputs

| Mix | Function | Description |
|---|---|---|
| **Mix 1** | **Teams Send** | Audio to remote Teams participants — what the far end hears. |
| **Mix 2** | **Subwoofer** | Subwoofer feed. |
| **Mix 3** | **Centre Stage Lift** | Selected centre-stage mics to two speakers further from the stage. Limited reinforcement, deliberately not covering the whole audience / back-office area. |
| **Mix 4** | **Lift All** | All lifted / reinforced areas, including the stage. |
| **Mix 5** | **Stage Speaker Left** | Left stage loudspeaker. |
| **Mix 6** | **Stage Speaker Right** | Right stage loudspeaker. |

#### Matrix, main and monitoring

| Output | Function |
|---|---|
| **MTRX 1 / 2** | USB recording |
| **Main L / R** | `STREAM` — stream audio output |
| **Monitoring** | **None configured.** No dedicated monitor bus exists. |

#### Signal-flow rules that constrain anything we build

These are the constraints a Companion layer must not violate. Each one is a way to break a live
show silently.

1. **Mix 1 is a mix-minus. CH10/11 must never feed it.** The Teams return going back into the
   Teams send is an echo for every remote participant. Any bulk "enable sends" helper must exclude
   that pair explicitly — this is the single most dangerous automation mistake available here.
2. **CH7/8 (Media PC) must stay off Main L/R.** The stream already receives Media PC audio via
   **NDI**; routing it to the stream bus too would double the source. Any "send everything to
   stream" helper must skip 7 and 8.
3. **CH1–4 are two ceiling capsules split into four channels serving two unrelated jobs.**
   Explained by the operator, 2026-08-28 — and it is *not* the simple pairing an earlier draft of
   this document assumed.

   | Ch | Job | Destination | Driven by |
   |---|---|---|---|
   | **1** | Stage speaker → **live-stream audience only** | stream | a **sequencing button already in Companion**, pressed when the speaker in front of the camera is ready to talk |
   | **2** | Couch → **live-stream audience only** | stream | same sequencing button flow |
   | **3** | **Voice lift from the stage** to the audience and back office | Mix 3, 5, 6 | operator, per segment |
   | **4** | **Voice lift from the couch/discussion** to the stage and back office, and for audience reaction / Q&A | Mix 4 | operator, per segment |

   Physically CH1 and CH3 are the same ceiling capsule (`Tisch` / `TischV`, *V* =
   *Verstärkung*/reinforcement), as are CH2 and CH4. **But operationally they are independent
   controls with different triggers**, and both halves are legitimately on at once — the speaker
   is heard by the stream (CH1) *and* lifted into the room (CH3) simultaneously.

   > **⚠️ The earlier "logical mic" idea in this document was wrong and has been removed.** It
   > proposed treating 1+3 and 2+4 as single mics to be muted together. Doing that would cut the
   > stream feed whenever reinforcement was switched, or vice versa. Do not resurrect it.

4. **CH3 and CH4 are mutually exclusive — never both on.** Stage lift and couch lift are alternating
   modes, selected by what the segment needs. This is a genuine interlock and the only exclusivity
   relationship in the patch. It does **not** extend to CH1/CH2, or to the handhelds.
5. **There is no monitor bus, so there is nothing to "dim."** See §2.4.

### 2.3 What the console actually reports

Read live via `tools/rcp-probe.js` (`InCh/ToMix/On`, `InCh/ToSt/On`, `InCh/Fader/On`). `Y` = send
on. This is *state*, not level — several of these sends are on but sitting at −∞.

```
CH   M1 M2 M3 M4 M5 M6   ST  ON      (M1=Teams M2=Sub M3=LIFTcntr M4=LIFTall M5/6=Stage L/R)
 1    Y  .  .  .  .  .    Y   off
 2    Y  .  .  .  .  .    Y   off
 3    .  .  Y  .  Y  Y    .   off
 4    .  .  .  Y  .  .    .   off
 5    Y  .  .  .  Y  Y    Y   off
 6    Y  .  .  .  Y  Y    Y   off     <-- M3 OFF, doc says on
 7    Y  Y  Y  Y  Y  Y    .   ON
 8    Y  Y  Y  Y  Y  Y    .   ON
 9    .  Y  .  .  Y  Y    Y   off     <-- ST ON, doc says no
10    .  .  .  Y  Y  Y    Y   off
11    .  .  .  Y  Y  Y    Y   off
12    Y  Y  Y  Y  Y  Y    Y   off  ┐
13    Y  Y  Y  Y  Y  Y    Y   off  │  factory defaults, unassigned
14    Y  Y  .  .  .  .    Y   off  │
15    Y  Y  .  .  .  .    Y   off  │  labelled `Tasche1` / `Tasch2` on the console
16    Y  Y  .  .  .  .    Y   off  ┘
```

**Channels 1–11 match the documented intent except in two places:**

- **CH6 → Mix 3 is OFF.** The documentation says Handheld Mic 2 should feed Centre Stage Lift. It
  currently does not, so Handheld 2 gets no centre-stage reinforcement.
- **CH9 → Stream is ON.** The documentation says the reserved USB-C input should not reach the
  stream. Its fader is off so nothing is audible today, but the path is armed: turning that channel
  on would put a reserved input straight into the stream.

Neither is dangerous right now — every input except the Media PC pair is switched off. Both are
worth a decision before automation starts flipping channels on, because automation will make the
armed path reachable.

**Two further observations from the live read:**

- **CH15/16 are labelled `Tasche1` / `Tasch2` (beltpacks) but carry factory-default routing** —
  Mix 1 + Mix 2 + Stream. The operator's table lists 12+ as unused. If those beltpacks are ever
  patched, they go to Teams and the stream immediately, with no deliberate routing decision.
- **Every source into MTRX 1/2 is switched On but sits at −∞.** All six mixes and the main bus have
  their matrix sends enabled with the level fully down, so **the USB recording bus currently
  receives nothing**. Either recording is fed some other way (a direct out or Dante patch rather
  than the matrix), or it would record silence. Worth confirming — the plan assumes nothing about
  it either way.

Main bus (`St`) is labelled `STREAM`, fader on at **+2.70 dB**. Stereo inputs 1–2 (`Playback`)
route to Mix 1–4 and the stream, both faded off.

### 2.4 The absence of a monitor bus changes Phase 5

An earlier draft of this plan proposed *"auto-dim the control-room monitors when a mic opens,"*
built on `Monitor/Fader/Level` and `Monitor/On`. **There is no monitoring configured on this
console**, so there is nothing for that to act on.

The Monitor parameters do exist and answer over RCP — they are simply unused here. Read live:

```
Monitor/Fader/Level      -32768      (-inf)
Monitor/On                    0      (off)
Monitor/St/SourceCh/St        1      (source = the STREAM bus)
Cue/ActiveCue            "NONE"
```

So the bus is addressable but parked: switched off, fader at −∞, nothing cued. **Anything that
dims it changes nothing anyone can hear.** This is the evidence behind the Phase 5 correction in
§9 — the shipped Monitor Auto-Dim feature is not wrong as code, but its premise does not hold in
this room.

What actually exists, and what actually risks feedback, are the **reinforcement buses**: Mix 3
(`LIFTcntr`), Mix 4 (`LIFTall`), and Mix 5/6 (stage speakers). Those carry open microphones into
loudspeakers in the same room. That is the real acoustic loop.

This makes the feature **more delicate, not less**. Dimming a control-room monitor is invisible to
the audience; pulling a lift or stage-speaker send is immediately audible to everyone present and
degrades the reinforcement the room depends on. So the Phase 5 design has to change:

- **Do not** silently duck reinforcement buses as a background safety behaviour.
- **Do** provide explicit, operator-driven states — for example a "mic live" button that opens the
  logical mic's channels together (§2.2 rule 3) with the correct sends, and a clearly labelled
  "kill lift" action for feedback emergencies.
- **Do** surface tally and metering so the operator can see a building loop before they hear it.
- Any automatic behaviour must be opt-in per button and must show its state, never act invisibly.

Confirm the intended behaviour with the operator before building anything that changes a
reinforcement send on its own.

### 2.5 Scenes

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

`tools/probes/DM3-routing-2026-08-28.txt` — the live send matrix (`InCh/ToMix/On`, `InCh/ToSt/On`,
`InCh/Fader/On` for all 16 inputs, plus stereo inputs, matrix sources and the Monitor bus). This is
what §2.3 and §2.4 are built on. Regenerate it whenever the patch changes — the discrepancies it
surfaced are the kind that appear silently.

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

**Remote head-amp gain (0–64 dB) and phantom power across 16 Dante channels.** Stagebox preamp
control from a Stream Deck — genuine capability in a studio that has a Rio-class device.

> ### This studio will never have one
>
> Confirmed by the operator on 2026-08-28: **no Rio-class device is planned for this studio, ever.**
> These three parameters are therefore **permanently dormant here**, not merely untested.
>
> The console agrees. `HAAvailability` reads `0` on all 16 channels, and gain reads are refused:
>
> ```
> get IO:Current/PortToPort/HAAvailability <0..15> 0  →  OK … 0     (all 16)
> get IO:Current/PortToPort/HAGain 0 0                →  ERROR get AccessDenied
> ```
>
> **Do not remove the code.** It shipped in v3.10.0, it is correct, it is part of upstream PR #76,
> and it is useful to anyone who *does* have a Rio. It simply cannot be exercised here.
>
> **The write path can never be verified on this install.** If it needs proving, that has to happen
> on other hardware — most realistically via feedback on the upstream PR. Treat any future
> "let's finally test Dante HA" idea as already answered: no.

**What preamp control this studio actually has.** Read live across all 16 inputs
(`IO:Current/InCh/HAGain`, `IO:Current/InCh/48VOn`):

| | |
|---|---|
| CH1 | gain **50**, 48 V **on** — the only channel using a local analog head-amp |
| CH2–16 | gain `0`, 48 V off |
| Device | `Dev/SyncStatus` 5, `Dev/SystemStatus` 2, `Dev/48VActiveOn` 1 |

So **console-controllable preamp gain covers CH1 only**. Everything else arrives over Dante from
other manufacturers' devices — Bonjour shows `Shure-Decke`, `Sennh-Decke`, `Sennh-Stage`,
`Sennh-Funk` (*Decke* = ceiling, *Funk* = wireless), which lines up with the ceiling and radio mics
in §2.2.

**Consequence worth knowing before anyone promises "gain control from Companion":** for the
Dante-sourced channels, gain does not live on the DM3 at all. It lives on the Shure and Sennheiser
devices, which have their own Companion modules. That is a different integration, not something
this module can ever reach.

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

**C0–C3, C5, C7, C8 fixed 2026-08-27 (Phase 2); C4 fixed as a side effect of Phase 1; C6 fixed
2026-08-28 (Phase 4); C9 wasn't part of the original research — found and fixed 2026-08-28 while
investigating a crash during Phase 4's own live testing.** Table left as originally written (the
bugs, as found) — see the Phase 2/Phase 4 write-ups in §9 for what changed and how each was
verified.

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
| **C9** | **The TCP receive handler's two line-reassembly branches are swapped, silently corrupting a line whenever a chunk boundary falls mid-line.** [`index.js`](companion-module-yamaha-rcp/index.js)'s `socket.on('data', ...)` splits the accumulated buffer on `\n`; when the chunk does *not* end on a line boundary (meaning the last split element is a genuinely incomplete line, the rest still in flight over the wire) the code clears the buffer and lets that incomplete fragment get parsed as if it were complete — instead of holding it for the next chunk, which is what the *other* branch (chunk *does* end on a boundary, where the trailing element is always just an empty string) does. Not new to this project — inherited from the original code, invisible under light/spaced-out traffic (most chunks happen to land on a line boundary), and only reliably reproducible under a heavy rapid-line stream, e.g. several concurrent `mtrstart` subscriptions. **Found via an intermittent, one-off crash during Phase 4 live testing (`variables.js`'s `setVar`, `msg.Address` undefined) that never reproduced on a quiet connection.** Fixed 2026-08-28: swapped the two branches back to their evidently-intended roles, plus a defensive guard in `setVar`'s `default` case so any other malformed-line edge case degrades to "drop that one line" instead of crashing the connection. | found investigating a background-task-flagged crash; reproduced and fixed without live hardware — a local loopback TCP server standing in for the console, deliberately splitting a response across two writes mid-line, proved the old code silently lost the value entirely (not even a crash, worse: silent data loss) and the fixed code reassembles it correctly |

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

### Phase 2 — Correctness and safety — **DONE (code), pending one live check**

C0 first — it's a one-line parser fix that unlocks the entire `InputChLink` block. Then C1–C5, C7.
C1 (de-globalising) is the largest diff and unblocks running a console and a stagebox side by side.

**Exit:** two instances configured simultaneously without interference; `InputChLink` actions appear
in the UI; no leaked timers; `eslint` clean.

**Closed 2026-08-27:**

- **C0** — the parser silently dropped 23 `InputChLink` rows (missing their leading `OK` token,
  space-indented instead). One guard clause restores it. Verified directly: 161 → 184 parsed
  commands, all 23 confirmed present in the generated action set.
- **C1** — `global.config`/`global.rcpCommands` moved onto the instance
  (`this.config`/`this.rcpCommands`); `findRcpCmd`, `fmtCmd`, and the fade-limit helpers all gained
  an `instance` parameter, threaded through every call site across all 6 files. Verified directly:
  two instances configured back-to-back (DM3, 184 params; RIO, 10 params) produce completely
  independent action/feedback sets with zero crosstalk. One related bug fixed along the way:
  `feedbacks.js` was passing the Companion feedback context into `parseVal()` instead of the real
  instance — harmless before only because the one thing that context was needed for
  (`getFromDataStore`, for relative/Toggle actions) is never reached for feedbacks.
- **C2** — `destroy()` now clears `kaTimer` alongside the other timers. Live-verified 2026-08-27
  directly against the console (see below) rather than through Companion: the built module's own
  `sendCmd`/`initTCP`/`destroy` methods were driven straight over a real TCP connection to
  `192.168.128.9`, `destroy()` called, then no traffic sent for 13s (> the 10s `KA_INTERVAL`) —
  confirmed `kaTimer` itself reports `_destroyed: true` and zero commands fire in that window.
- **C3** — the action callback's bare `JSON.parse()` on X/Y (to support the `[1,2,3]` multi-channel
  syntax) threw on any other typed-in text and silently killed the whole action. Now falls back to
  treating unparseable input as a single literal value instead.
- **C5** — `parseData`'s `'mtr'` case aliased and mutated the shared `RCP_METER_FIELDS` array
  in place instead of copying it. Harmless today only because every call site happens to invoke
  `parseData()` one line at a time; fixed so that stops being load-bearing.
- **C7** — the reconnect half was already free: the Companion 5/API 2.1 `TCPHelper` (Phase 1)
  reconnects automatically by default, we just weren't relying on it being new behaviour. Fixed the
  other half — repeated identical network errors during an outage no longer spam the log, only the
  first occurrence of a given error message logs until it either changes or the connection recovers.
- **C8, promoted from Phase 5 per the 2026-08-25 audit's recommendation** (`YamahaRCP/audit/AUDIT.md`)
  **given this console's real, named, hand-built scenes.** Companion has no native "confirm before
  running" for actions, so Scene Store (index 1001, `ssupdate_ex`) is now gated behind a new
  "Allow Scene Store?" config checkbox that defaults to **off** — an accidental press does nothing
  (logged as a warning) unless the user has deliberately opted in. Verified directly in both states.
- **eslint clean** — `eslint`/`prettier` weren't even installed despite `@companion-module/tools`
  expecting them; added both plus `eslint.config.mjs` calling the shared config the tools package
  exposes for this. `--fix` cleared 93 of 106 problems automatically (feedbacks.js had Windows line
  endings throughout, for reasons predating this project); the other 13 were small pre-existing
  dead-code/safety nits, none behavioural. `yarn lint` now passes clean.

**All Phase 2 fixes are now live-verified, including C2** (closed 2026-08-27 — see the C2 bullet
above). The KeepAlive timer logic lives entirely in `index.js`'s own socket/timer code, not
anything Companion-specific, so this didn't need a real Companion install: the built module class
was driven directly (methods copied by reference off the prototype onto a plain object, since
`InstanceBase` blocks bare `new`/`Object.create` construction) over a real connection to the
console. No regressions found.

**Deliberately still open, unchanged from before this phase:** C4 was already fixed as a side
effect of Phase 1 (the two implicit-globals it names were exactly what strict-mode ESM bundling
turned into load-time `ReferenceError`s). C6 (DM3 metering rebuilt from the console's real flat
enumeration) stays Phase 4 scope, untouched here.

### Phase 3 — Performance — **DONE**

In cost order: §7.2 (shadow-store scene resync) → §7.4 (`findRcpCmd` map) → §7.5 (meter frame
coalescing) → §7.3 (queue rework) → §7.6, §7.7.

**Exit:** every §7.8 target met.

**Closed 2026-08-27, shipped as v3.9.0.** Landed and tested while offsite (no Companion install
available), so verification leaned harder on live-hardware scripting and pure-logic parity tests
than Phase 1/2 did, and deliberately stopped short of one thing: no real scene recall was triggered
against the console, since that changes the live studio's actual state and isn't something to do
without the user present to confirm. Everything else was verified as directly as possible:

- **§7.2** — `pollConsole()` no longer wipes `this.dataStore` before re-requesting. It re-queues a
  `get` for every cached address that's still readable and not a meter (meters already refresh on
  their own timer), and relies on `addToDataStore`'s existing per-address diff to only schedule a
  feedback check when a fresh reply actually differs from the cached value. Live-verified: seeded
  the real cache with 6 genuine DM3 values, corrupted one to simulate an unreported change, called
  `pollConsole()`, and confirmed only that one address triggered a feedback check while the other 5
  stayed silent - the exact anti-storm behaviour this section calls for, same network cost.
- **§7.4** — `getParams()` now builds a `Map` keyed on the address's underscore form once, and
  `findRcpCmd()` tries it before falling back to the original linear scan (still needed for the
  `cmdAction === 'mtr'` path's address-rewriting, which on some models produces a genuine prefix
  rather than an exact address). Verified byte-for-byte identical to the old scan: 888 lookups
  compared across all 8 supported models' real parameter tables (exact-address and mtr-rewritten
  forms), 0 differences.
- **§7.5** — value changes (from `addToDataStore`) are now collected into a set and flushed as one
  `checkFeedbacks(...ids)` call per tick instead of one call per changed address, which is what a
  16-channel meter frame or a multi-address scene resync used to do. Live-verified as part of the
  same §7.2 test above (the 6-address cache-seeding step visibly coalesced into single-digit
  `checkFeedbacks` calls rather than one per address).
- **§7.3** — the command queue no longer paces sends `MSG_DELAY` (5ms) apart on a timer regardless
  of load; `addToCmdQueue` now schedules a drain for the next tick (letting a synchronous burst of
  adds land together), and `processCmdQueue` drains everything it can into one batched
  `socket.send()` call, deferring only a `set` that's still waiting on a live value it doesn't have
  yet (unchanged retry contract). Live-verified: a batch of 6 queued reads, and separately the §7.2
  resync's re-fetch, each went out as exactly one `sendCmd()` call. `sendCmd` itself now logs each
  batched command on its own debug line so this doesn't regress log readability
  ([[feedback_live_host_debugging]] - always paste verbatim logs - depends on that not changing).
- **§7.6** — `fbCreatesVar`'s auto-created-variable path (the upstream #64 "plugin restarts when a
  lot of data comes in" suspect - a burst of DCA/meter auto-created variables each used to trigger
  its own full `setVariableDefinitions()` rebuild and its own `setVariableValues()` call) now goes
  through two new instance methods, `queueNewVariable`/`queueVariableValue`, that coalesce a burst
  into one rebuild and one values call per tick. Deliberately **not** applied to every
  `setVariableValues` call site in the module - `variables.js`'s cued-channels tracking reads a
  variable's current value back synchronously in the same call to update it, and deferring that
  write would risk two same-tick updates reading stale data and clobbering each other. Verified with
  a standalone unit test (two synchronous bursts of 5 variables each collapsed into exactly one
  definitions call and one values call, with the correct final payload).
- **§7.7** — replaced `JSON.parse(JSON.stringify(...))` with a shallow spread at the 3 hot-path
  sites that are both frequently called and verifiably flat (a received message, a queued command,
  a parsed action/feedback option set - all plain string/number/boolean-keyed objects with no nested
  arrays or objects). The other deep-clone sites the original finding's line numbers pointed near
  (preset construction, action-to-feedback conversion, upgrade scripts) clone genuinely nested
  objects and don't run on a hot path - converting those would risk a shared-array mutation bug for
  no measurable benefit, so they're left alone.

**Not independently re-measured against §7.8's specific numeric targets** (latency in ms, CPU %) -
doing that meaningfully needs a real Companion install driving a realistic button/feedback count
under metering load, which needs the user at the console. The mechanism-level fixes above are the
actual content of §7.2-§7.7; §7.8 is the user-facing confirmation that they add up, still open.

### Phase 4 — Metering rebuild and Dante HA — **DONE**

- **P4.1** Rebuild DM3 metering on the console's own 17-row flat enumeration instead of the
  synthesised `Pickoff` table. Fixes C6 and removes the meter special-casing in `fmtCmd`.
- **P4.2** Add the three `IO:Current/PortToPort/*` parameters. Gate the UI on `HAAvailability` and
  read [§5.3](#53-the-dante-remote-ha-caveat) first — `AccessDenied` with no remote HA patched is
  expected behaviour, not a bug. **The operator has since confirmed no Rio-class device will ever
  exist in this studio, so this half of the phase is permanently dormant here** — shipped, correct,
  useful upstream, and unexercisable on this install.

**Exit:** working stereo meters on ST and ST-IN; per-FX-return meters; stagebox gain and phantom
from a button (or a clear "unavailable" state).

**Closed 2026-08-28, shipped as v3.10.0.** Landed and tested while offsite, same constraints as
Phase 3: no live Companion install, no user at the console, deliberately no destructive/state-
changing commands sent. Unlike Phase 3, this phase touches what actual studio buttons will render
on screen, so verification leaned even harder on live ground-truth captures before touching
anything.

- **P4.1.** Before writing any code, re-swept the console directly (`tools/rcp-probe.js
  --sweep=mtrinfo:0-20`) rather than trusting this document's own §4.5 excerpt, which only showed 3
  of the 17 rows as an example. Got the complete, current 17-row enumeration (`InCh`/`StInCh`
  /`FxRtnCh`/`Mix`/`Mtrx`/`St`, each already a specific pickoff — `PreHPF`/`PreFader`/`PostOn` etc.,
  no invented axis), plus a live `mtrstart` capture confirming the wire response's `Address` field
  is the exact same real address, unmodified — the console never sends the collapsed form the
  shipped table invented. Replaced the 6 synthesised rows in `DM3 Parameters-2.txt` with the real
  17. The only `.js` change actually needed was one new DM3-specific branch in `findRcpCmd`'s
  `cmdAction === 'mtr'` handling (skip the invented-segment-insert-and-truncate reconstruction
  entirely — the wire address already matches a row exactly) — `fmtCmd`'s existing Pickoff-optional
  handling and the `Index >= 2000` meter-detection convention needed no changes at all, since
  Pickoff-less rows were already a legitimate (if previously unexercised for DM3) shape the code
  supported for other models.

  Tracing `createPresets()`'s two meter-preset builders (the standalone "Level Meters" category and
  the VU-meter bar embedded in fader-control-knob presets) surfaced a **second, independent,
  pre-existing bug affecting every model, not just DM3**: the preset's predicted auto-created
  variable name (hand-built as `V_Meter_<name>_<x>_<pickoff-name>`) never actually matched what
  `fbCreatesVar` creates (`V_<address>_<x>_<numeric-y>`) — meaning a meter's VU bar could never
  populate even when the underlying feedback fired correctly. Fixed by extracting one shared
  `paramFuncs.getAutoVariableName()` helper that both call, so the prediction can't drift from the
  creation again. Rewrote both preset builders to handle old-style (Pickoff column, every model but
  DM3) and new-style (flat, DM3) rows through the same explicit per-fader-type "which pickoff should
  this meter show" map (input-side channels show their earliest pre-processing point, for
  gain-staging; bus/output channels show the final post-everything level) — a direct, named port of
  the old code's own `Index<2100`-vs-`>=2100` split.

  Verified: (1) pure-logic parity test — all 17 real DM3 rows parse with the right shape, exact
  address lookup resolves via `findRcpCmd`'s new branch, and the other 7 models' old-style
  resolution and Pickoff-bearing tables are provably untouched. (2) Live end-to-end test against the
  real console with metering enabled — all 17 real `mtrstart` subscriptions sent (batched into one
  write per §7.3), real streamed values landed in `dataStore` for all 17 rows, feedback checks fired
  correctly, and firing a real feedback callback with "Auto-Create Variable" on produced a variable
  whose name exactly matched `getMeterInfo`'s prediction — the mismatch bug above, confirmed fixed
  end-to-end, not just by inspection. (3) The existing action/feedback/preset smoke test, confirming
  counts move by exactly the expected amount (+11 commands, +11 feedbacks, +11 presets) with no
  structural breakage.

  One unrelated, unreproduced anomaly surfaced during this testing: a single live run hit an
  uncaught exception in `variables.js`'s `setVar` (`msg.Address` was undefined in its `default:`
  case) that didn't recur across 4 further identical runs. Not caused by this phase's changes
  (that function wasn't touched here) and not chased down given it's out of scope and non-
  reproducing — flagged as a background task for whoever picks it up next rather than silently
  dropped.

- **P4.2.** Added the 3 documented `IO:Current/PortToPort/*` parameters
  (`HAAvailability`/`48VOn`/`HAGain`) to `DM3 Parameters-2.txt`. Cross-checked their index numbers
  against a fresh live `prminfo:0-180` sweep first — the numbers in this document's own §5.3
  excerpt (20/21/23) turned out to collide with two *existing* shipped rows at those same indices
  (`InCh/48VOn`/`InCh/HAGain`) that have since shifted on the real console but not in the shipped
  file. Rather than renumber the whole downstream table to match (`Index` is pure local bookkeeping
  — the module never sends it to the console, only the `Address` string — so realigning it has no
  functional effect and would only add risk), gave the 3 new rows their own unused indices
  (174-176, right after the file's existing highest index) and left everything else alone.
  Live-verified the read side end-to-end through the real module code: `HAAvailability` correctly
  reads back `0` (matches [§5.3](#53-the-dante-remote-ha-caveat)'s documented "nothing patched"
  state), and `get`s against `HAGain`/`48VOn` are refused by the console exactly as documented,
  handled gracefully with no crash. **The actual gain/phantom read-write control path is
  permanently unverifiable on this install** — the operator confirmed on 2026-08-28 that no
  Rio-class device is planned for this studio, ever. This is now a closed question, not a pending
  one: if the write path ever needs proving, it has to happen on someone else's hardware, most
  realistically through upstream PR #76. See [§5.3](#53-the-dante-remote-ha-caveat).

### Phase 5 — Broadcast feature layer — **P1 done, P2 shipped-but-parked, P3 closed**

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
3. ~~**Studio presets** built on both.~~ **Closed unbuilt, 2026-08-28** — falls inside the §1.1
   scope freeze. Do not start it.

**Available but not requested** — recorded so they aren't lost: mix-minus/IFB helper (note the
existing `Tms STR` ↔ `Teams DL/DR` relationship in §2.2), scene-store confirmation (C8).
**Fader ramps are already done** in v3.6.0. **Dante remote HA is *not* on this list any more** —
it shipped in Phase 4 but is permanently dormant here, since no Rio-class device will ever be
installed ([§5.3](#53-the-dante-remote-ha-caveat)). For the Dante-sourced channels, gain lives on
the Shure/Sennheiser devices and their own Companion modules, not on the DM3.

**Exit:** a show can be run from the Stream Deck without touching the console surface.

---

> ### ⚠️ Correction — 2026-08-28: the P2 premise does not hold in this room
>
> The operator's routing documentation (§2.2) states plainly: **"No dedicated monitoring bus or
> monitoring configuration is currently set up."** A live read (§2.4) confirms it — `Monitor/On` is
> `0`, `Monitor/Fader/Level` is `-32768`, nothing is cued.
>
> **The shipped Monitor Auto-Dim would therefore dim a bus that is already off at −∞ and restore it
> to −∞. It would do nothing audible in this studio.** The code is not wrong — it is a reasonable
> generic feature and other rooms do have monitors — but it does not address this room's problem,
> and the plan previously claimed it did. That claim was mine and it was wrong: it was inferred
> from the parameter table's existence rather than from how the console is actually configured.
>
> **What the real risk is.** The buses that carry open microphones into loudspeakers here are
> **Mix 3 (`LIFTcntr`), Mix 4 (`LIFTall`), and Mix 5/6 (stage speakers)** — the voice-lift and
> stage reinforcement paths. That is the acoustic loop worth engineering against.
>
> **What changes:**
>
> - Leave `enableMicMonitorDim` **off** and unverified. Do not spend a live session validating it;
>   there is nothing to hear. Keep the code — it costs nothing and may suit another install.
> - `micExclusiveMode` is **unaffected by this correction** — it acts on input channel On states,
>   not on the monitor bus, and remains worth verifying live.
> - **Redesign the dim behaviour around reinforcement buses before building anything further**, and
>   read §2.4's warning first: pulling a lift send is *audible to the room*, unlike dimming a
>   control-room monitor. It must be operator-driven and visible, not a silent background safety
>   behaviour.
> ### ✅ `micExclusiveMode`'s shipped default was fixed, 2026-08-28
>
> Learned from the operator's CH1–4 explanation (§2.2 rule 3) on 2026-08-28. **The feature itself
> went out of scope the same day** — it now lives in [§9 Backlog](#backlog--nice-to-have-not-scheduled).
> This note stays here because the code is shipped and someone could still tick the box.
>
> `micChannels` originally shipped (v3.12.0) defaulting to `1,2,3,4,5,6,15,16`, and
> `micExclusiveMode` turns off **every other listed channel** the instant one turns on. In this
> studio that was actively wrong:
>
> - **CH1 (stream) and CH3 (stage lift) are legitimately on together** — the speaker is heard by
>   the stream *and* reinforced into the room at the same time. Exclusive mode would kill one the
>   moment the other opened. Same for CH2/CH4.
> - **CH1/CH2 are driven by an existing Companion sequencing button.** Exclusive mode would fight
>   that automation directly.
> - CH15/16 are unpatched beltpacks carrying factory-default routing.
>
> **The only genuine exclusivity in this patch is CH3 ↔ CH4** (§2.2 rule 4), and nothing else. So
> the shipped default was narrowed from `1,2,3,4,5,6,15,16` to `3,4` in v3.12.1, at the operator's
> explicit request during a final pre-ship review — not new feature work, closing a documented
> hazard in something already shipped, so it didn't need to wait for the feature to be revived.
> `micExclusiveMode` itself still defaults to off; this only changes what happens if someone turns
> it on without also reviewing `micChannels`.

**P1 closed 2026-08-28, shipped as v3.11.0**, built and tested while offsite (§7.6's dependency
was satisfied back in Phase 3). Every fader-level channel (`isFaderLevel` + `RW` includes `w` — the
same enumeration `createPresets()` already uses, for consistency) gets a name/level/on-state
variable requested proactively on connect and kept live afterward by hooking `addToDataStore`: when
a tracked address's value changes, it's routed through `fbCreatesVar` exactly as if a real feedback
with "Auto-Create Variable" had fired — this is a deliberate reuse, not a parallel implementation,
so it can't drift into a differently-named variable for a channel someone's already auto-created one
for by hand. That reuse is also why the actual variable names ended up as `V_InCh_Fader_Level_1`
etc. (the existing `getAutoVariableName` convention) rather than this section's own illustrative
`inch_1_level_db` — a deliberate substitution in favour of not inventing a second naming scheme.
Live-verified against the real console: real names (`Tisch`, `STREAM` — matching §2.2's own channel
patch), real dB levels, real on-state, for InCh/Mix/St/Fx, with the ~90-variable definitions burst
correctly coalesced into one `setVariableDefinitions()` call by §7.6. One narrow, documented gap:
`Fx`'s parameter table declares a second value per channel (`Y=2`) that turned out to be
`InvalidArgument` when actually queried live — confirmed via a direct probe, not assumed — so only
`Fx`'s first value is covered; every other fader type is fully covered.

**P2 (mic on-air + monitor dim) is code-complete as of 2026-08-28, shipped as v3.12.0, but
deliberately NOT live-verified** — built at the user's explicit request ("write the code now, off
by default") after they asked to hold all real-console testing until they're back on premise.
**Both new options default to off; existing behaviour is unchanged for anyone who doesn't enable
them.** Two independent, config-gated behaviours in the new `micOnAir.js`, hooked into the same
`addToDataStore` choke point Phase 5 P1 uses: **Monitor Auto-Dim** dims `Monitor/Fader/Level` by a
configurable amount (via the existing fade engine, for a smooth transition) whenever any channel
listed in the new "Mic Channel Numbers" option is on, and restores it to the *exact* pre-dim level
(captured at the moment dimming started, not a fixed target) once they're all off; **Exclusive Mic
Mode** turns off every other listed channel the instant one turns on. Which channels count as
"microphones" is a config option (`micChannels`, comma-separated, defaulting to this studio's own
patch: 1,2,3,4,5,6,15,16) rather than hardcoded — a patch is studio-specific, not a module-wide
constant.

Verified as thoroughly as possible *without* the real console: a local loopback TCP server
scripted to answer exactly what this feature depends on, and to emit simulated
"someone pressed a physical button" NOTIFY events for mic channels turning on/off, confirmed the
dim math (dimmed to exactly the configured amount below the captured starting level, a smooth
26-step fade), the exact restore (back to precisely the pre-dim level, not an approximation), and
exclusive-mode enforcement (a previously-open channel correctly turned off when another opened)
— all with zero crashes. This caught one real bug in the new code before it ever reached hardware:
the `fadeCmd` calls were initially missing `prefix: 'set'`, which every other caller in the
codebase sets and `fmtCmd` requires to pick the wire verb - without it, `fmtCmd` was emitting
`undefined MIXER:Current/Monitor/Fader/Level ...`, a command that would never have done anything on
a real console. Caught and fixed by the same loopback test before this was ever a live risk.

**What this testing genuinely cannot confirm, and what P3 also still needs a live console for:**
whether the dim actually sounds right in the room — a sensible depth, smooth enough, no feedback,
no clipping the room's reinforcement. That needs a human actually listening while it's tested, on
this specific room's voice-lift setup (§2.2) — there's no way to mechanically verify "does this
sound safe" the way §7.2's cache-diffing or C6's address-matching could be verified against logged
data. **Do not enable `enableMicMonitorDim` or `micExclusiveMode` on the live connection until
that's been done with the user present.** P3 is now **closed rather than paused** — it fell inside
the §1.1 scope freeze before it was ever started.

### Phase 6 — Package, document, upstream

Build as a Companion dev module, install on the studio machine, write studio-facing docs. Then offer
upstream: the API 2.1 migration, C0, C6 and the §7 performance work all benefit every user of the
module. The broadcast layer may or may not fit upstream's scope — decide later.

### Backlog — nice to have, not scheduled

Out of scope under the §1.1 freeze. Recorded so the reasoning isn't lost, **not** as a to-do list.
Nothing here should be started without the operator raising it first.

| Item | State | If it is ever revived |
|---|---|---|
| **Single-mic (exclusive) mode** | Shipped in v3.12.0, **off by default, out of scope 2026-08-28**; default channel list narrowed to `3,4` in v3.12.1 | Read the note below before enabling — the narrowed default still needs reviewing against your own routing, it's just no longer a landmine by default. |
| **Monitor auto-dim** | Shipped in v3.12.0, off by default | Premise doesn't hold here — there is no monitor bus (§2.4). Only meaningful if one is ever configured. |
| **Reinforcement-bus feedback mitigation** | Never built | The successor idea to monitor auto-dim, acting on Mix 3/4/5/6. Read §2.4 first: pulling a lift send is *audible to the room*, so it must be operator-driven and visible, never a silent background behaviour. |
| **Mix-minus / IFB helper** | Never built | Mix 1 ↔ CH10/11 is already a correct mix-minus by hand (§2.2 rule 1). A helper would have to preserve that, not rediscover it. |
| **Studio presets** (was Phase 5 P3) | Closed unbuilt | Was to be built on the two features above; inherits their status. |

> #### ✅ Single-mic mode's default hazard was closed, 2026-08-28 — still read before enabling
>
> `micExclusiveMode` originally shipped (v3.12.0) with `micChannels` defaulting to
> `1,2,3,4,5,6,15,16`, turning off every *other* listed channel the instant one opens. In this
> studio that would have:
>
> - **killed CH1 the moment CH3 opened** — the stream feed drops mid-sentence while the speaker is
>   being lifted into the room (§2.2 rule 3);
> - **fought the existing Companion sequencing button** that drives CH1/CH2.
>
> **The only genuine exclusivity in this patch is CH3 ↔ CH4** (§2.2 rule 4), so v3.12.1 narrowed
> the shipped default to exactly that — an *interlock*, not mic exclusivity, though the feature
> keeps its original name since it wasn't otherwise touched (still out of scope per §1.1).
>
> Until it's revived: **leave `micExclusiveMode` off.** It is off by default, so no action is
> required today — but if it's ever turned on for a *different* purpose, `3,4` is still just this
> studio's one real interlock, not a safe assumption for a new use case. Review `micChannels`
> against whatever it's being turned on for, don't assume the default already covers it.

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

**This work was also offered upstream:**
[bitfocus/companion-module-yamaha-rcp#76](https://github.com/bitfocus/companion-module-yamaha-rcp/pull/76),
opened from a *separate* branch, `upstream-api21-migration` (based on `v3.6.0`, not
`broadcast-studio` — deliberately built without ever touching this file in its history, since
this doc has real network/studio detail that has no place in a public PR). Originally Phase 1
only; **updated 2026-08-28 to also carry Phases 2–4, Phase 5 P1, and the C9 fix** — five further
commits, one per phase, each built the same way (checkout the phase's final file states from
`broadcast-studio` onto this branch, strip any `PLAN.md` references the checkout brings back into
`CHANGELOG.md`). **Phase 5 P2 is deliberately excluded** — untested against real hardware and, per
§2.4/§9, built on a premise (a monitor bus) that doesn't hold even here, so it isn't something to
offer other installs yet. If more work goes upstream later, repeat the same per-phase checkout
pattern onto this branch rather than PR'ing `broadcast-studio` directly.

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
2. ✅ `InCh/Fader/On` toggles CH1 and the feedback tracks it. Confirmed 2026-08-27 against the
   console at its new `.9` address: connection log shows a clean `set
   MIXER:Current/InCh/Fader/On 0 0 1` → `OK set ... "ON"` round trip, the system log has nothing
   from this connection at all (no warnings), and the button's own feedback/color was confirmed
   flipping correctly by direct observation.
3. ✅ A fade from −∞ to 0 dB on CH1 is smooth and lands exactly. Confirmed 2026-08-27: with Fade
   off, the fader jumps straight to the target (correct — that's the non-fade path); with a Fade
   duration set, it takes exactly that long to arrive, smoothly. P1.5 (verify the fade engine
   under the new option semantics) is satisfied.
4. ✅ Recall scene A31 from the console surface; confirm Companion resyncs and **no trigger fires
   spuriously** (this is the §7.2 regression test — the "C6" in the original label was a
   mislabel, C6 is item 5's concern, not this one). Confirmed 2026-08-27, recalling scene 32 (not
   literally A31, but the same mechanism): `NOTIFY ssrecall_ex` → `NOTIFY sscurrent_ex ... 32
   unmodified` → `ssinfo_ex` → a burst of individual `get`s for whatever's on the visible page, no
   errors, no failed parses. This **is** the documented §7.2 wipe-and-repoll storm happening
   exactly as PLAN.md describes it (a redundant quadruple `mtrstart` resend was visible in the
   log) — that inefficiency is real but explicitly Phase 3's to fix, not a Phase 1 regression.
   No visible flicker or spurious state on the currently-displayed page, confirmed by direct
   observation.
5. ✅ Enable metering; confirm ST meters show **both** channels (the C6 regression test). Was
   failing as of Phase 1 (only a mono `InCh` meter had been tested, not the `St` stereo pair this
   item is actually about) — **fixed and live-verified in Phase 4** (2026-08-28): the console's own
   17-row flat meter enumeration replaced the synthetic `Pickoff` model, all 17 real `mtrstart`
   subscriptions confirmed sending/batching correctly with real streamed data landing. See Phase
   4's write-up for the full verification detail.
6. ✅ Delete the connection; confirm no timers keep firing (C2). This was never Phase 1's to fix
   (correctly identified as still-open by the 2026-08-25 audit, `YamahaRCP/audit/AUDIT.md`) — it's
   listed here for completeness. Fixed and live-verified as part of Phase 2, 2026-08-27: see
   Phase 2's write-up above.

**Net: Phase 1's own exit bar ("loads and runs... existing pages behave identically") is closed,
within Phase 1's actual scope.** 4 of 6 items confirmed live during Phase 1 itself
(2026-08-25/27); the other 2 were pre-existing bugs Phase 1 never intended to fix, and both have
since closed too — item 6 (C2, KeepAlive leak) via Phase 2, item 5 (C6, stereo metering) via
Phase 4. **All 6 of this checklist's items are now confirmed. Phase 1 can be considered genuinely
done**, and so, as of 2026-08-28, can every phase this checklist was tracking.

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

**Open — for the operator:**

1. **CH6 → Mix 3 is off, but the routing doc says it should be on.** Handheld Mic 2 currently gets
   no centre-stage lift. Intended, or drift? (§2.3)
2. **CH9 → Stream is on, but the routing doc says no.** The reserved USB-C input is armed to reach
   the stream; only its fader being down keeps it silent. Should that send be turned off before
   automation starts flipping channels on? (§2.3)
3. **Every matrix send is On at −∞, so MTRX 1/2 receives nothing.** Is USB recording fed some other
   way — a direct out or Dante patch — or is the recording bus simply not commissioned? (§2.3)
4. ~~**Are CH1/CH3 and CH2/CH4 the same physical microphones?**~~ **Answered 2026-08-28.** Yes
   physically, but they are independent controls doing different jobs — CH1/CH2 feed the stream
   under an existing Companion sequencing button, CH3/CH4 are alternating voice-lift modes. The
   "logical mic" grouping this question was asked in service of has been withdrawn. (§2.2 rule 3)
5. **CH15/16 are labelled as beltpacks but carry factory-default routing** to Teams, Sub and the
   stream. Are they patched? If they get used, they reach air with no deliberate routing decision.
6. **Is any monitoring planned?** If not, the Monitor Auto-Dim feature stays permanently dormant and
   the reinforcement-bus redesign in §9 becomes the only path. (§2.4)
7. **Is `Tms STR` maintained by hand today?** If the Teams mix-minus is a manual routing chore, the
   deferred mix-minus helper deserves promotion.

**Open — engineering:**

8. **Where does Companion run, and how are dev modules loaded there?** Needed to verify end to end
   (§10.3).
9. **What exactly does the existing CH1/CH2 sequencing button do?** There is already Companion
   automation driving the stream mics (§2.2 rule 3). Anything this module does around channel-on
   state can collide with it — most obviously `micExclusiveMode`. Worth reading that button's
   action list before enabling anything that writes `InCh/Fader/On`.
10. ~~**Should `micChannels` default to empty?**~~ **Settled 2026-08-28** — narrowed to `3,4`
    instead (the actual CH3↔CH4 interlock, §2.2 rule 4), done in v3.12.1 as a final pre-ship
    safety pass despite the feature itself staying out of scope. The hazard note travels with the
    feature in the §9 backlog regardless, since `3,4` is still specific to this studio's patch.

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
- **That a parameter existing in the table means it does something in this room.** The Monitor bus
  taught us otherwise (§2.4): fully addressable over RCP, and completely unused. Before building on
  any parameter, read its *current value* and ask whether the studio actually uses that path.
