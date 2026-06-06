# Groovebox: Patterns + Chain (replaces Arrangement / cycle 2/4)

**Date:** 2026-06-06
**Status:** Approved (brainstormed with Matthew; mockups in `.superpowers/brainstorm/40361-1780726697/content/`)
**Code:** `docs/arcade/groovebox/`

## Problem

The groovebox has two competing sequencing models at different altitudes:

1. **Per-lane bar selector** (`edit/▸play 1 2 3 4` + `cycle 2/4`): every custom pattern is silently stored as 4 bars; numbered buttons multi-select which bars receive edits; `cycle` truncates the loop. Only one bar is visible at a time. Hidden state, cryptic legend.
2. **Arrangement module** (`Live`/`Song`, `+ capture scene`, scene chips): global snapshots of per-lane pattern selections, played in order in song mode.

They fight: neither is an honest "pattern bank", and users can't tell which layer owns sequencing.

## Decision

One model: **whole-machine patterns + a chain** (PO/Volca idiom). Decided against per-lane patterns + scenes (Elektron/Circuit) and against offering both as modes — the dedup benefit of per-lane reuse is covered by "duplicate pattern", and an LLM writing song JSON keeps duplicated material in sync for free.

- A **pattern** = the steps for *all* lanes, over **1, 2 or 4 bars** (per-pattern length — the honest version of cycle 2/4).
- The **chain** = an ordered list of pattern refs; loops forever. "Loop one pattern" = chain of length 1 conceptually; see playback rules.
- **No modes anywhere.** Live/Song toggle dies.

## UX

### PATTERNS module (replaces ARRANGEMENT in the same surface slot)

Two rows:

- **Patterns row:** numbered slots `1 2 3 … +` (cap 16), then for the selected pattern: `Length 1|2|4`, `⧉ duplicate`, `✕ delete`.
- **Chain row:** chips `1 1 2 3 +`. `+` appends the currently selected pattern. Hover-✕ removes a chip. Drag to reorder. The chip driving playback glows (hot/pink).

### Playback follows your last click (no mode toggle)

- **Click a pattern slot** → becomes the edit target AND loops, switching at the next bar boundary.
- **Click a chain chip** → the chain plays from that position onward, switching at the next bar boundary.
- The pink playing indicator sits wherever sound is actually coming from (a looping slot or a chain position).
- Transport play with nothing clicked yet: plays the chain from the start; if the chain is empty, loops pattern 1.
- Deleting a pattern removes its chain chips; the last pattern cannot be deleted.

### Editors

- **Drum grid:** all bars of the selected pattern stacked vertically (bar 1..N), every bar directly editable. A "fill" is just what bar 4 says. Playhead highlights the sounding step in the sounding bar.
- **Piano roll / blocks:** show the pattern's true length (the roll already renders multiple bars side-by-side).
- **Removed:** `cycle 2/4` buttons, `edit/▸play` bar multi-select, the always-4-bars hidden storage, `ensureCustom`/`fork4`/`pool._base` forking machinery.

### Lane strips

Per-lane **pattern selector dropdown is removed** — what a lane plays lives in the pattern. Strips keep: drag-reorder, rename, mute/solo, all knobs (MIX/TONE/FX), duplicate/remove (instrument management).

### Fills module

**Untouched in this change.** Queued fills remain a live performance trick (momentary drum override on the next bar). Composed fills are now just bars drawn into a pattern. Folding/removing the fills module is a later decision.

## Data model

```js
song = {
  title, artist, meter, bpm,
  lanes: [ { id, type, name, fx… } ],          // instruments + mixer only; no pool/selection
  patterns: [                                   // 1..16
    {
      bars: 1|2|4,
      lanes: {                                  // keyed by lane id
        [laneId]: /* per-bar explicit data:
          drums:  [ { kick:[steps], snare:[…], hat:[…], crash:[…], tom:[[step,semi]…] }, …perBar ]
          bass/melody/chords: [ [ [step, note, durSteps], … ], …perBar ] */
      }
    }
  ],
  chain: [patternIndex, …],
  fills: { name: drumBar, … }                   // unchanged
}
```

Everything is **explicit note data** — no generators, no pools, no harmony indirection at runtime. The scheduler reads `patterns[chain[i]]` only. KEY/global transpose still shifts notes as today. This schema is deliberately the shape that URL sharing and LLM track-authoring will consume later.

## Preset migration (load-time flattening)

The 7 preset songs stay authored in their current rich format and are **flattened on load** by a converter:

- Each arrangement section → one pattern: resolve every lane's selected pool entry for that section into explicit bars (run bass generators against the harmony progression; render chord lane pad/stab/arp voicings to notes).
- Section order → chain. A section of 8 bars whose content cycles over 4 → one 4-bar pattern + two chain entries.
- Section/pool names are dropped; patterns are numbered.
- Fills dict passes through unchanged.

**Parity test (the verification spine):** for each preset, capture the audible note stream (lane, step-time, note, duration) for the full arrangement pre- and post-migration; they must be identical. Build this test against the current engine *before* changing it.

## Engine API changes

- **Removed:** `setMode`, `getMode`, `captureScene`, `clearArrangement`, per-lane `setLane(id, selection)` as a pattern picker, `cycleLen`.
- **Added:** `selectPattern(i)` (edit target + loop-at-next-bar), `playChain(fromIndex)`, `addPattern()`, `duplicatePattern(i)`, `removePattern(i)`, `setPatternBars(i, n)`, `setChain(list)` / `appendToChain(i)` / `removeChainAt(pos)` / `moveChain(from, to)`, and step-edit setters that write into `patterns[selected]`.
- Scheduler: walks the chain (or the looped pattern), resolves the sounding bar from explicit data; `sectionAt`-style logic moves from arrangement sections to chain positions.

## Testing

- Update existing Vitest suite (lane mutations, scheduler, solo, transpose) for the new shapes.
- New: chain playback order across bar boundaries; click-to-switch quantization (pattern↔chain at next bar); pattern add/duplicate/delete (incl. chain-chip cleanup, last-pattern guard); preset flattening parity (above); length change behavior — decided: **keep stored bars, play first N** (4→2 plays bars 1–2 but bars 3–4 survive a round-trip; matches old cycleLen semantics, nothing destroyed by toggling).

## Out of scope

URL sharing / persistence of user songs, parameter locks, punch-in FX, fills rework, pattern naming, >4-bar patterns, velocity. (These come after — this redesign produces the explicit-JSON substrate they need.)
