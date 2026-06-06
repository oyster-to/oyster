# Groovebox data model — the contract

**Status: CANONICAL as of PR #630.** This is the schema the engine plays and every other surface (UI, sharing, LLM authoring, other work threads) builds against. UI may iterate freely; this contract changes only deliberately, with a version bump here.

## The song (v2)

```js
song = {
  title: string, artist: string,
  meter: { beatsPerBar, beatUnit, stepsPerBeat },   // 4/4 → 16 steps/bar; 6/8 → 12
  bpm: number,

  // INSTRUMENT CHANNELS — mixer + voice identity. NO musical content here.
  lanes: [
    { id: 'drums'|'drums-2'|…, type: 'drums'|'bass'|'chords'|'melody',
      name: string, muted: bool, soloed: bool,
      tone?: string }                                // melody lanes: oscillator type
  ],

  // GROOVES — named musical content, per lane. Pure data, shareable.
  grooves: {
    [laneId]: {
      [grooveName]: bars[]                           // 1..8 bars, each:
      // drums lane:   { kick:[steps], snare:[steps], hat:[steps], crash:[steps],
      //                 tom:[[step, semitoneOffset], …] }
      // other lanes:  [ [step, note|notes[], durSteps|'bar'], … ]
      //               note = 'C4' style; notes[] = simultaneous (chords)
    }
  },

  // PATTERNS — a combo: one groove pick per lane. NO length of its own:
  // a pattern lasts as long as its longest picked groove; shorter grooves
  // cycle underneath (bar % groove.length).
  patterns: [ { lanes: { [laneId]: grooveName } } ],  // max 16

  // CHAIN — the song order. INVARIANT: length >= 1, every entry a valid pattern index.
  chain: [patternIndex, …],

  // FILLS — one-bar drum overrides, queued live (performance feature).
  fills: { [fillName]: drumBar },

  transpose?: number   // runtime KEY offset in semitones (applied at schedule time)
}
```

## Invariants (the engine enforces these; everyone may rely on them)

1. `chain.length >= 1`; every chain entry indexes an existing pattern.
2. Every pattern pick resolves to an existing groove for that lane (dangling picks are silent, never a crash).
3. Pattern duration is **derived**: `max(groove.length over picks)`, floor 1. Patterns store no length.
4. Groove lengths are 1–8 bars. The UI currently offers 1/2/4/8 (powers of two always nest evenly — no drift). **The model itself permits any length 1–8**: `bar % groove.length` cycling is length-agnostic; non-dividing lengths simply truncate their cycle at each pattern repeat. Arbitrary lengths are a UI/alignment policy decision, not a schema change.
5. The whole song is **pure JSON** — no functions, no hidden state. This is the property that makes grooves/patterns/songs shareable and LLM-authorable. Never add a non-serializable field.
6. Playback state (the chain-position/pattern-loop target, edit selection, fill queue) is **engine runtime, never part of the song**.

## The legacy bridge (read-only, temporary)

The 7 preset songs in `songs/*.js` are authored in the OLD rich format (per-lane pools, bass generator *functions*, harmony progression, arrangement sections). `engine/flatten.js` converts them to this schema at load. Nothing else reads or writes the rich format; when presets are re-authored as v2 JSON, flatten.js is deleted. Faithfulness is proven by the frozen parity suite (`tests/legacy/` + `tests/flatten-parity.test.js`: the flattened song must reproduce the old engine's note stream exactly, all 7 presets).

## Reserved extensions (direction agreed; NOT yet in the schema)

Other threads should leave room for these, not invent competing shapes:

- **`harmony`** *(next slice, plan approved)*: `{ progression: [{name, root, voicing}, …] }` — one chord per bar, cycling on the absolute bar counter. With it, grooves may be **chord-relative**: `{ relative: true, bars: [[[step, REF, dur], …]] }`, REF ∈ `'R' | 'R±12' | 'V<i>' | 'V<i>±12|24' | 'V*'` (root / voicing-degree / whole voicing). Bass/chords become reusable figures over any progression; drums + melody stay literal.
- **`instruments`** *(direction only — design after #630 lands)*: a definitions layer (`instruments: { [id]: synth params | sample ref }`) that lanes reference, replacing the hardcoded `type → voices.js` synthesis. A drum kit becomes an *ensemble* of instrument refs; samples (wav/mp3) enter here. This is the unlock for the social/composable vision — do **not** extend `lane.type` semantics in the meantime.
- **Sharing**: grooves, patterns, and songs are already self-contained named JSON. Sample assets are the one future exception (need hosting/IDs, can't ride in JSON).

## API surface (engine — `engine/index.js`)

Read: `getSong getLanes getGrooves getPatterns getChain getEditPatternIndex getEditGroove(laneId) getPlaybackTarget`.
Mutate: `selectPattern playChain addPattern duplicatePattern removePattern appendToChain removeChainAt moveChain setLaneGroove(laneId, name) setGrooveBars(laneId, n) setDrumStep toggleNote` + lanes (`addLane duplicateLane removeLane renameLane moveLane`), mixer/FX, fills queue, transport.
Gone (do not reintroduce): `setMode getMode captureScene clearArrangement setLane` per-lane selection, `cycleLen`, pattern `bars`/`setPatternBars`.
