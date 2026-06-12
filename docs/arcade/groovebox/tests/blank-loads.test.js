import { describe, it, expect } from 'vitest';
import { createEngine } from '../engine/index.js';
import { blank, blankWaltz } from '../songs/blank.js';

for (const [label, tpl, beats] of [['blank (4/4)', blank, 4], ['blankWaltz (3/4)', blankWaltz, 3]]) {
  describe(`${label} "New" template`, () => {
    it('loads without throwing and exposes the skeleton', () => {
      const eng = createEngine();
      expect(() => eng.load(structuredClone(tpl))).not.toThrow();
      expect(eng.getLanes().map(l => l.type)).toEqual(['drums', 'bass', 'chords']);
      expect(eng.getPatterns().length).toBe(1);
      expect(eng.getChain()).toEqual([0]);
      expect(eng.getSong().meter.beatsPerBar).toBe(beats);
    });

    it('every pattern pick resolves to an existing groove (valid-song invariant)', () => {
      const eng = createEngine();
      eng.load(structuredClone(tpl));
      const grooves = eng.getGrooves();
      for (const [laneId, name] of Object.entries(eng.getPatterns()[0].lanes)) {
        expect(grooves[laneId]?.[name], `${laneId}:${name}`).toBeDefined();
      }
    });

    it('relative bass/chords resolve against the pattern chords (4-bar pattern)', () => {
      const eng = createEngine();
      eng.load(structuredClone(tpl));
      expect(eng.getPatternChords(0)?.length).toBe(4);   // I–V–vi–IV
      expect(eng.getKey()).toMatchObject({ root: 'C', mode: 'major' });
    });
  });
}
