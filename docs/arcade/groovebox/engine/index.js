import * as Tone from 'tone';
import { stepsPerBar } from './meter.js';
import { eventsForStep } from './scheduler.js';
import { createVoices, trigger } from './voices.js';

export function createEngine() {
  let song = null, voices = null, master = null, step = 0, started = false, repeatId = null, tempo = 120, playing = false;
  function ensure() {
    if (started) return;
    master = new Tone.Limiter(-1).toDestination();
    voices = createVoices(master);
    started = true;
  }
  return {
    load(s) { song = s; tempo = s.bpm; },
    async play() {
      if (!song) throw new Error('no song loaded');
      if (playing) return;                                   // ignore double-play (don't stack callbacks)
      await Tone.start(); ensure();
      step = 0;
      Tone.Transport.bpm.value = tempo;
      if (repeatId !== null) Tone.Transport.clear(repeatId);
      repeatId = Tone.Transport.scheduleRepeat((t) => {
        const sixteenth = Tone.Time('16n').toSeconds();
        const barSeconds = stepsPerBar(song.meter) * sixteenth;
        for (const ev of eventsForStep(song, step)) trigger(voices, ev, t, sixteenth, barSeconds);
        step++;
      }, '16n');
      Tone.Transport.start();
      playing = true;
    },
    stop() {
      Tone.Transport.stop();
      if (repeatId !== null) { Tone.Transport.clear(repeatId); repeatId = null; }
      step = 0; playing = false;
    },
    setTempo(bpm) { tempo = bpm; Tone.Transport.bpm.value = bpm; },
  };
}
