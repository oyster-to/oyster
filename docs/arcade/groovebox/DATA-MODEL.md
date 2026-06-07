# Groovebox data model — the contract

**Status: CANONICAL as of PR #630.** This is the schema the engine plays and every other surface (UI, sharing, LLM authoring, other work threads) builds against. UI may iterate freely; this contract changes only deliberately, with a version bump here.

## The song (v2)

```js
song = {
  version: 2,                                        // schema version — bump only with this doc
  title: string, artist: string,
  meter: { beatsPerBar, beatUnit, stepsPerBeat, group? },  // 4/4 → 16 steps/bar; 6/8 → 12, group:3 accents
  bpm: number,

  // INSTRUMENT CHANNELS — mixer + voice identity. NO musical content here.
  lanes: [
    { id: 'drums'|'drums-2'|…, type: 'drums'|'bass'|'chords'|'melody',
      name: string, muted: bool, soloed: bool,
      tone?: string }                                // melody lanes: oscillator type
  ],

  // KEY — the song's tonic, for melody snap-to-scale + editor tinting (inert at
  // playback). Optional. The chord PROGRESSION is not global — it lives on each
  // pattern (pattern.chords, below).
  key?: { root: 'A'|'C#'|…, mode: 'major'|'minor' },

  // GROOVES — named musical content, per lane. Pure data, shareable.
  grooves: {
    [laneId]: {
      // A groove is EITHER a literal bars[] array OR a chord-relative wrapper.
      [grooveName]: bars[] | { relative: true, bars: relBars[] }   // 1..8 bars
      // LITERAL bars[] — each bar:
      // drums lane:   { kick:[steps], snare:[steps], hat:[steps], crash:[steps],
      //                 tom:[[step, semitoneOffset], …] }
      //               a drum step is a number, OR a tuple carrying a lock:
      //               [step, lock] (noise slot) | [step, semitoneOffset, lock] (tom)
      // other lanes:  [ [step, note|notes[], durSteps|'bar', lock?], … ]
      //               note = 'C4' style; notes[] = simultaneous (chords)
      // LOCK (per-step parameter lock) — optional trailing object, the ONE
      //   extensible per-step slot: { v }. v multiplies the voice's base
      //   velocity (0 < v <= 2; product clamped to 0..1). Absent → base
      //   velocity unchanged. On drum voices that carry a tone filter (e.g.
      //   hat/crash) v ALSO shifts the cutoff (accents fuller, ghosts thinner) —
      //   an engine rendering of v, not a separate field. Strict-keyed, so a
      //   typo'd/unknown key is rejected
      //   at publish (validate.js) rather than silently ignored. Future per-step
      //   params (e.g. micro-timing 't') join this same object — no new tuple
      //   position. Drum 2-element tuple is type-discriminated: a number is a
      //   semitone, an object is a lock.
      // RELATIVE relBars[] — each bar: [ [step, REF, durSteps|'bar', lock?], … ]
      //   REFs resolve against the PATTERN's chord for that bar
      //   (pattern.chords[barInPattern % chords.length]):
      //     'R'        → chord.root
      //     'R±N'      → root ±N semitones      (e.g. 'R+12')
      //     'V<i>'     → chord.voicing[i % len] (degree; index clamped)
      //     'V<i>±N'   → that degree ±N semitones (e.g. 'V2-24')
      //     'V*'       → the whole voicing (a chords-style pad event)
      //     'V*±N'     → the whole voicing, each note shifted
      //   Pattern has no chords → a relative groove is silent.
      //   Relative grooves are read-only today (no editor yet); drums never relative.
    }
  },

  // PATTERNS — a combo: one groove pick per lane, plus an optional chord loop
  // that BELONGS to the pattern (one chord per bar, cycling on barInPattern).
  // Chord-relative grooves resolve against these chords — deterministic and
  // loop-stable (no global "fourth clock"). NO length of its own: a pattern lasts
  // as long as its longest picked groove AND its chord count; shorter grooves
  // (and the chord loop) cycle underneath (bar % length). A 1-bar bass figure
  // over 4 chords is a 4-bar pattern.
  patterns: [ {
    lanes: { [laneId]: grooveName },
    chords?: [ { name, root, voicing: [note, …] }, … ],   // optional, one per bar
  } ],  // max 16

  // CHAIN — the song order. INVARIANT: length >= 1, every entry a valid pattern index.
  chain: [patternIndex, …],

  // FILLS — one-bar drum overrides, queued live (performance feature).
  fills: { [fillName]: drumBar },

  transpose?: number   // runtime KEY offset in semitones (applied at schedule time)
}
```

## Invariants (the engine enforces these; everyone may rely on them)

1. `chain.length >= 1`; every chain entry indexes an existing pattern.
2. **Valid-song invariant:** every pattern pick resolves to an existing groove for that lane. **Engine robustness (separate guarantee):** if a pick ever dangles anyway, the engine plays silence for that lane — never a crash.
3. Pattern duration is **derived**: `max(groove.length over picks, chords?.length ?? 0)`, floor 1. Patterns store no length.
4. Groove lengths are 1–8 bars. **The schema permits any length 1–8** (`bar % groove.length` cycling is length-agnostic; non-dividing lengths truncate their cycle at each pattern repeat) — but **the UI stays opinionated at 1/2/4/8**: powers of two always nest evenly, so nothing drifts. Arbitrary 3/5/7-bar grooves are musically surprising and stay a deliberate future decision, not a default.
5. The whole song is **pure JSON** — no functions, no hidden state. This is the property that makes grooves/patterns/songs shareable and LLM-authorable. Never add a non-serializable field.
6. Playback state (the chain-position/pattern-loop target, edit selection, fill queue) is **engine runtime, never part of the song**.
7. **Per-step locks are additive and inert by default:** a lock-less step plays exactly as before (byte-identical legacy songs). The lock object never adds, removes, or retimes a note — it only modulates the voice at trigger time. A song with no locks is indistinguishable from a pre-lock song; the parity suite (legacy note stream, no velocity) therefore stays valid unchanged.

## The legacy bridge (read-only, temporary)

The 7 preset songs in `songs/*.js` are authored in the OLD rich format (per-lane pools, bass generator *functions*, harmony progression, arrangement sections). `engine/flatten.js` converts them to this schema at load. Nothing else reads or writes the rich format; when presets are re-authored as v2 JSON, flatten.js is deleted. Faithfulness is proven by the frozen parity suite (`tests/legacy/` + `tests/flatten-parity.test.js`: the flattened song must reproduce the old engine's note stream exactly, all 7 presets).

## Reserved extensions (direction agreed; NOT yet in the schema)

Other threads should leave room for these, not invent competing shapes:

- **`pattern.chords` + chord-relative grooves** — *LIVE.* Chords live on each pattern (one per bar, cycling), and the relative-groove syntax resolves against them (documented above). The chord line in the PATTERNS module edits the selected pattern's chords (parser-backed); melody snap/tint read `song.key`. The flattener translates known bass figures (`octave`, `eighths`, `16ths`, `arp`, …) and the chord modes (`pad`/`stab`/`arp`) into single chord-relative grooves and attaches each pattern's chords from the source progression's bar offsets; array/MIDI bass, melody, and drums stay baked literal. Parity with the legacy note stream is proven for all 7 presets. **Still future:** editable chord-relative grooves (groove writes are no-ops today).
- **`instruments`** *(direction only — design after #630 lands)*: a definitions layer (`instruments: { [id]: synth params | sample ref }`) that lanes reference, replacing the hardcoded `type → voices.js` synthesis. A drum kit becomes an *ensemble* of instrument refs; samples (wav/mp3) enter here. This is the unlock for the social/composable vision. **Until then: `lane.type` stays a broad routing identity — do not extend its semantics or let it become an instrument-definition dumping ground.**
- **Sharing** — *LIVE (share registry v1).* Songs and grooves are **registry items**: a kind-generic Worker+D1 store behind `groovebox.oyster.to/api/registry`, pretty links `/s/<id>` (`@rev` reserved, ignored in v1). Per-kind schema versions: `song=2` (this doc), `groove=1` (bundle: `{ laneType, meter, bars, relative?, bpm?, extensions? }`). The enforcement point is `registry/validate.js` — shared verbatim by the Worker and the app, strict keys with `extensions: {}` as the only hatch; change it only with this doc and the spec (`project-notes po20/2026-06-06-share-registry-spec.md`). Future kinds (`instrument`, `sample`, `module`) are new enum values, not new systems.
- **`sampleRef`** *(reserved, NOT in any schema yet)*: when samples arrive they are **metadata-only** first — `sampleRef: { type: 'built-in', id: 'kick-808' }`, later `{ type: 'r2', assetId }`. Audio bytes never ride in registry JSON (the validator's 1KB string cap enforces this); R2 hosting is the instruments-layer slice.
- **Groove input modes (hum / beatbox / keys)** — *IN FLIGHT on branch `hum-melody`, NOT merged.* Mic-recorded melody (`engine/hum.js`: YIN → key-snap → grid) and beatbox drums (`engine/beats.js`: onsets → classify → consensus fold) with a debug harness (`hum-lab.html`). No schema changes — takes land as ordinary grooves via `addGroove`; merge is gated on transcription passing the ear test. Direction, queue (key mode, training mode, pYIN, AI riff seeds) and research: `project-notes oyster/po20/2026-06-08-groovebox-feature-roadmap.md` entry 8.

## API surface (engine — `engine/index.js`)

Read: `getSong getLanes getGrooves getPatterns getChain getEditPatternIndex getEditGroove(laneId) getPlaybackTarget getKey getPatternChords(i)`.
Mutate: `selectPattern playChain addPattern duplicatePattern removePattern appendToChain removeChainAt moveChain setLaneGroove(laneId, name) addGroove(laneId, name, value) setGrooveBars(laneId, n) setDrumStep toggleNote setPatternChords(chords)` + lanes (`addLane duplicateLane removeLane renameLane moveLane`), mixer/FX, fills queue, transport.
Gone (do not reintroduce): `setMode getMode captureScene clearArrangement setLane` per-lane selection, `cycleLen`, pattern `bars`/`setPatternBars`, `getHarmony`/`setProgression` (chords are pattern-owned now).
