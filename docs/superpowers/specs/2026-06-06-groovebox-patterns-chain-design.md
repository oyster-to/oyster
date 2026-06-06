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
- The **chain** = an ordered list of pattern refs; loops forever. **Invariant: `chain.length >= 1`, always.**
- **No modes anywhere.** Live/Song toggle dies.
- **This is the only model going forward.** The legacy rich format (pools/generators/arrangement sections) is a read-only bridge for the 7 presets. Every new song, every UI edit, and every future authoring surface (LLM, URL sharing) reads and writes the explicit patterns + chain schema exclusively.

## UX

### PATTERNS module (replaces ARRANGEMENT in the same surface slot)

Two rows:

- **Patterns row:** numbered slots `1 2 3 … +` (cap 16), then for the selected pattern: `Length 1|2|4`, `⧉ duplicate`, `✕ delete`.
- **Chain row:** chips `1 1 2 3 +`. `+` appends the currently selected pattern. Hover-✕ removes a chip. Drag to reorder. The chip driving playback glows (hot/pink).
- **Playback label:** small status text in the module header that always names the sound source — `Playing: Pattern 2 (loop)` or `Playing: Chain · 1 1 ▸2 3`. The glow alone is not the answer to "what is driving sound?".

### Playback: the chain always plays; a pattern click temporarily loops (no mode toggle)

- **The playback target follows your last click, even while stopped.** Transport play starts the *current target* from its top bar — the chain from the start by default, or the pattern/chain position you last clicked. Stop keeps the target (and discards any pending switch). The playback label always names the target, so there is no hidden pre-play state. The chain is never empty, so there is no fallback case.
- **Click a pattern slot** → becomes the edit target AND the playback target: while playing it loops from the next bar boundary; while stopped it's what play will start. The chain is untouched — it resumes when you click a chain chip.
- **Click a chain chip** → the chain plays from that position onward — at the next bar boundary while playing, or on the next play while stopped.
- **Disambiguation is brutal, not subtle:** besides the playback label, the row *not* driving sound drops opacity, and edit-selection (green fill on a pattern slot) is visually distinct from playing (pink glow). A pattern loop = patterns row lit, chain row dimmed; chain playing = the reverse.
- **Deletion rules preserving the invariant:** the last pattern cannot be deleted; removing the last chain chip is blocked; deleting a pattern removes its chain chips, and if that would empty the chain, the chain becomes `[first remaining pattern]`.

### Editors

- **Drum grid:** one bar tall (5 voice rows). A **bar stepper** above it shows exactly `pattern.bars` buttons — the honest count (no phantom bars, no cycle buttons; pattern length lives in the PATTERNS module). One bar means no stepper. Stepper buttons **multi-select** the bars an edit applies to (minimum one): the grid shows the primary (lowest-index) selected bar, and a cell click computes on/off from that bar then *sets* it across every selected bar. The button for the currently sounding bar carries a ▸ indicator (only when the sounding pattern is the one being edited); the playhead column appears only when the sounding bar is the shown bar. *(Amended 2026-06-06 after hands-on review: stacked bars replaced by the bar stepper — the stacked grid was overwhelming.)*
- **Piano roll / blocks:** show the pattern's true length (the roll already renders multiple bars side-by-side). Unchanged by the amendment.
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
      bars: 1|2|4,                              // ACTIVE length — what plays and what editors render
      lanes: {                                  // keyed by lane id
        [laneId]: /* per-bar explicit data:
          drums:  [ { kick:[steps], snare:[…], hat:[…], crash:[…], tom:[[step,semi]…] }, …perBar ]
          bass/melody/chords: [ [ [step, note, durSteps], … ], …perBar ] */
      }
    }
  ],
  chain: [patternIndex, …],                     // INVARIANT: length >= 1
  fills: { name: drumBar, … }                   // unchanged
}
```

**Inactive bars (named concept, not hidden state):** a pattern's per-lane arrays may hold more bars than `bars` — these are *inactive bars*. They never play and editors never render them; they exist solely so toggling length 4→2→4 round-trips without destroying bars 3–4. This differs from the old problem (always-4-bars storage with only one bar *visible* of the bars that *played*): here, everything that plays is on screen.

Everything is **explicit note data** — no generators, no pools, no harmony indirection at runtime. The scheduler reads `patterns[chain[i]]` only. KEY/global transpose still shifts notes as today. This schema is deliberately the shape that URL sharing and LLM track-authoring will consume later.

## Preset migration (load-time flattening)

The 7 preset songs stay authored in their current rich format and are **flattened on load** by a converter. **The rich format is a read-only bridge** — nothing else in the app reads or writes it, no new songs are authored in it, and the engine/UI only ever see the explicit schema:

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
- New: chain playback order across bar boundaries; click-to-switch quantization (pattern↔chain at next bar); chain invariant (never empty: last-chip removal blocked, pattern deletion falls back to `[first remaining pattern]`); pattern add/duplicate/delete (incl. chain-chip cleanup, last-pattern guard); preset flattening parity (above); inactive-bars round-trip (4→2→4 restores bars 3–4; only active bars play).

## Out of scope

URL sharing / persistence of user songs, parameter locks, punch-in FX, fills rework, pattern naming, >4-bar patterns, velocity. (These come after — this redesign produces the explicit-JSON substrate they need.)

---

## Amendment 2 (2026-06-06, after second hands-on review): grooves return — patterns become combos

Hands-on use showed the whole-machine-pattern model lost the most playable part of the old groovebox: **switching an instrument's groove from the strip dropdown**. Matthew's verdict, agreed: restore the old surface; patterns become *remembered dropdown combos*.

**The contract (the whole design in three sentences):**
1. The groovebox goes back to how it was — groove dropdowns on the strips, knobs, fills, the one-bar grid with the bar stepper.
2. The only new thing is one row: `PATTERNS [1][2][3][+] · CHAIN [1][2][3]`. A pattern slot remembers where the dropdowns are; click a slot and they snap back; the chain is the order they play.
3. `cycle 2/4`, `capture scene`, and `Live/Song` are simply gone — pattern slots quietly do their jobs.

**Data model (supersedes the inline-pattern shape):**

```js
song = {
  lanes:   [ { id, type, name, muted, soloed, tone? } ],      // unchanged
  grooves: { [laneId]: { [grooveName]: perBarData[] } },      // named, explicit, shared
  patterns:[ { bars: 1|2|4, lanes: { [laneId]: grooveName } } ], // a combo of picks
  chain:   [patternIndex, …],                                  // unchanged, never empty
  fills:   { … }                                               // unchanged
}
```

- A **groove** owns its own length (its data array, 1–4 bars); at pattern bar `b` it plays bar `b % groove.length`. `pattern.bars` is the loop length (the honest cycle). The *inactive bars* concept dissolves — grooves keep their full data; pattern length just cycles them.
- **Editing a groove edits it everywhere it's used** — that is the point (tweak the kick once). The editor is labelled with the groove name it's editing; the bar stepper shows `groove.length` buttons.
- **Dropdowns show the EDIT pattern's picks** and never auto-follow chain playback (the old song-mode dropdown-sync was part of the confusion). An `Editing: Pattern N` indicator sits in the PATTERNS header next to the playback label.
- **`+` (add pattern) clones the selected pattern's picks** (an empty combo is silence — useless); `⧉ duplicate` is therefore the same thing and the two collapse into one affordance if that reads better.
- **Flattener:** bake per-bar per-lane exactly as today, group into patterns as today, then per pattern/lane extract the lane's bars as a groove — **deduped by content across the song**, named from the source pool selection where known (`four`, `four +tom roll` for fill-affected variants, else numbered). Patterns store groove names. **The existing 7-preset parity tests must keep passing unchanged** — same streams, new indirection.
- **Engine API:** `setLaneGroove(laneId, grooveName)` (writes the EDIT pattern's pick), `getGrooves()`; step-edit setters now write into the groove referenced by the edit pattern's pick for that lane. Everything else (target playback, chain ops, length, fills queue) unchanged.

**Out of scope for this amendment:** creating/renaming/deleting grooves from the UI (the dropdown lists what migration produced; editing mutates in place), per-pattern fills, recipe labels on pattern slots. All natural follow-ups.
