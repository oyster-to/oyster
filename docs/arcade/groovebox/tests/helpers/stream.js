import { stepsPerBar } from '../../engine/meter.js';
import { totalChainBars, chainBarAt, eventsForStepV2 } from '../../engine/patterns.js';
import { eventKey } from '../legacy/legacy-engine.js';

/** Mirror of renderLegacyStream for v2 songs: walk the chain, emit steady-state keys. */
export function renderChainStream(song, { cycles = 3, skipCycles = 1 } = {}) {
  const spb = stepsPerBar(song.meter);
  const total = totalChainBars(song);
  const out = new Set();
  for (let bar = total * skipCycles; bar < total * cycles; bar++) {
    const { patternIdx, barInPattern } = chainBarAt(song, bar);
    const outBar = bar - total * skipCycles;
    for (let step = 0; step < spb; step++) {
      // Chord-relative grooves resolve against the pattern's own chords (folded in
      // by the flattener), so the absolute bar is no longer passed.
      for (const e of eventsForStepV2(song, patternIdx, barInPattern, step, null, 0)) {
        out.add(eventKey(outBar, step, e));
      }
    }
  }
  return [...out].sort();
}
